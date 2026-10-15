import { and, eq, inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _taskDependencies, _tasks } from "../tables";
import { tasks } from "../views";
import { TaskGraph } from "../../../core";
import { taskIdKind } from "@plugins/tasks/plugins/task-ids/core";
import {
  findNextRankInFolder,
  isDescendant,
  listTasks,
  taskDependsOn,
} from "../queries/tasks";
import { withTaskStatusChange } from "../status-scope";
import { taskTitleChanged } from "../tables-events";
import type { EmitTx } from "@plugins/infra/plugins/events/server";
import { unionTaskClusters } from "./clusters";
import { withTaskStatusBatch, type DbExecutor } from "../status-batch";
import { Rank } from "@plugins/primitives/plugins/rank/core";

export interface CreateTaskInput {
  id?: string;
  // Folder the task is filed under (display-only hierarchy, not a dependency).
  folderId?: string | null;
  groupId?: string | null;
  title: string;
  // Defaults to true (machine-generated label). Pass false when the title is
  // human/agent-authored (explicit API/MCP title) so buildTaskPrompt keeps it.
  titleAuto?: boolean;
  author?: string;
  rank?: Rank;
  description?: string | null;
}

export interface UpdateTaskPatch {
  title?: string;
  description?: string | null;
  drop?: boolean;
  hold?: boolean;
  // Re-file under a different folder (display-only hierarchy, not a dependency).
  // No `rank`: positioning is `handle-move`'s job, which mints against the
  // complete sibling set inside its own transaction. A re-file made here keeps
  // the task's existing rank.
  folderId?: string | null;
}

export async function createTask(
  input: CreateTaskInput,
  exec: DbExecutor = db,
) {
  // Handed the pool, run the whole creation in ONE transaction; handed a tx, join
  // it (the caller owns the boundary — `handle-insert-between` already calls this
  // under `withTaskStatusBatch`). The INSERT and the folder union must be atomic:
  // the union's `FOR UPDATE` is only a real lock inside a transaction, and having
  // both commit together removes the crash window as well. Only the pool path
  // wraps, and on that path the caller holds no locks, so this cannot deadlock.
  if (exec === db) return db.transaction((tx) => createTaskOn(input, tx));
  return createTaskOn(input, exec);
}

async function createTaskOn(input: CreateTaskInput, exec: DbExecutor) {
  const id = input.id ?? taskIdKind.mint();
  const folderId = input.folderId ?? null;
  const rank = input.rank ?? (await findNextRankInFolder(folderId, exec));
  // The scope brackets the INSERT: the task does not exist yet, so its entry
  // status reads null and the emit reports its first-ever status (typically
  // "new"). Subscribers bound via `where({ taskId })` only register after
  // creation, so that first emit is a no-op for them; emitting unconditionally
  // keeps the mutation/event surface uniform with updateTask.
  await withTaskStatusChange(id, exec, async () => {
    // No `clusterId` here: it is derived from `folderId`, never an input, and it
    // is written by the union below rather than computed inline.
    await exec.insert(_tasks).values({
      id,
      folderId,
      groupId: input.groupId ?? null,
      title: input.title,
      titleAuto: input.titleAuto ?? true,
      author: input.author,
      rank: rank.toJSON(),
      description: input.description ?? null,
    });
  });
  // Filing under a folder IS a membership edge, so the new task joins the
  // folder's cluster — routed through `unionTaskClusters` rather than an inline
  // `clusterLabelOf` read so it inherits the `FOR UPDATE`. An unlocked
  // read-then-write here would strand the new task on a label its folder had
  // already left: read F's label L1, a concurrent union moves F's whole cluster
  // to L0, then this INSERT lands L1 — a label no other row carries. That is the
  // vanishing-from-its-tree failure this column exists to prevent, and it needs
  // no crash, just ordinary concurrency.
  if (folderId) await unionTaskClusters(id, folderId, exec);
  // On the creating executor, so the event commits (or rolls back) with the
  // row. Same PgTransaction ⇄ EmitTx cast as `withTaskStatusChange`'s emit.
  await taskTitleChanged.emit(
    { taskId: id, title: input.title },
    exec === db ? undefined : { tx: exec as EmitTx },
  );
  // No parent force-expand here: expand/collapse is device-local view state
  // owned by the data-view primitive, not a column. The tree reveals a new child
  // client-side (`useTreeRow.addChild` expands the row it created under). Which
  // columns move `updatedAt` is declared once, in the tasks entity's `touchedBy`
  // (`tables.ts`) — the union above relabels `clusterId`, which does not count.
  const [full] = await exec
    .select()
    .from(tasks)
    .where(eq(tasks.id, id))
    .limit(1);
  return full!;
}

export async function updateTask(
  id: string,
  patch: UpdateTaskPatch,
  exec: DbExecutor = db,
) {
  // Same executor-resolving split as `createTask`, for the same reason: a folder
  // re-file unions, and the union's `FOR UPDATE` is only a real lock inside a
  // transaction. Opening one here also makes the union and the folder write
  // atomic, so the two can no longer disagree. Only the pool path wraps, and on
  // that path the caller holds no locks, so this cannot deadlock.
  if (exec === db) return db.transaction((tx) => updateTaskOn(id, patch, tx));
  return updateTaskOn(id, patch, exec);
}

async function updateTaskOn(
  id: string,
  patch: UpdateTaskPatch,
  exec: DbExecutor,
) {
  // No `updatedAt` here: the database derives it from the tasks entity's
  // `touchedBy` declaration (`tables.ts`), and a write to it raises.
  const dbPatch: Record<string, unknown> = {};
  if (typeof patch.title === "string") {
    dbPatch.title = patch.title;
    // An explicit title write is human-authored — never re-summarized into the
    // launch prompt, and protected from the Haiku CAS upgrade.
    dbPatch.titleAuto = false;
  }
  if (patch.description === null || typeof patch.description === "string") {
    dbPatch.description = patch.description;
  }
  if (typeof patch.drop === "boolean") {
    dbPatch.droppedAt = patch.drop ? new Date() : null;
    if (patch.drop) dbPatch.heldAt = null;
  }
  if (typeof patch.hold === "boolean") {
    dbPatch.heldAt = patch.hold ? new Date() : null;
    if (patch.hold) dbPatch.droppedAt = null;
  }
  if (patch.folderId === null || typeof patch.folderId === "string") {
    if (patch.folderId === id) {
      throw new Error("Cannot file a task into itself");
    }
    if (
      patch.folderId !== null &&
      (await isDescendant(id, patch.folderId, exec))
    ) {
      throw new Error("Cannot file a task into its own descendant");
    }
    if (patch.folderId !== null) {
      // Union BEFORE the write, and only after the self/descendant guards — a
      // rejected re-file must not union. On the same executor as the write, so
      // the label and the folder edge commit or roll back together.
      await unionTaskClusters(id, patch.folderId, exec);
    }
    dbPatch.folderId = patch.folderId;
  }
  // An empty patch writes nothing (drizzle rejects an empty SET); the read
  // below still answers whether the task exists.
  if (Object.keys(dbPatch).length > 0) {
    // The scope brackets the write (typical flip: a drop/hold transition) and
    // covers the task's dependents too — dropping a task unblocks everything
    // downstream of it, which no single-task snapshot could see.
    const updated = await withTaskStatusChange(id, exec, async () => {
      const [row] = await exec
        .update(_tasks)
        .set(dbPatch)
        .where(eq(_tasks.id, id))
        .returning({ id: _tasks.id });
      return row;
    });
    if (!updated) return null;
    if (typeof patch.title === "string") {
      await taskTitleChanged.emit(
        { taskId: id, title: patch.title },
        exec === db ? undefined : { tx: exec as EmitTx },
      );
    }
  }
  // No destination force-expand on a re-file, for the same reason as in
  // `createTask`: the tree opens a collapsed drop target itself
  // (`useTreeModel`'s `onDragEnd`). The destination folder's row is not written at all,
  // so its `updatedAt` (derived per `touchedBy` in `tables.ts`) cannot move.
  const [row] = await exec
    .select()
    .from(tasks)
    .where(eq(tasks.id, id))
    .limit(1);
  return row ?? null;
}

export async function updateTaskTitle(
  id: string,
  title: string,
  onlyIfTitleIn: string[],
): Promise<boolean> {
  const [updated] = await db
    .update(_tasks)
    // Haiku-generated label: keep titleAuto true so the title stays out of the
    // launch prompt (it is just a summary of the description).
    .set({ title, titleAuto: true })
    .where(and(eq(_tasks.id, id), inArray(_tasks.title, onlyIfTitleIn)))
    .returning({ id: _tasks.id });
  // Only a write that landed changed the title; a lost CAS changed nothing.
  if (updated) await taskTitleChanged.emit({ taskId: id, title });
  return !!updated;
}

export async function addTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
  exec: DbExecutor = db,
): Promise<void> {
  if (dependsOnTaskId === taskId)
    throw new Error("A task cannot depend on itself");
  const [task] = await exec
    .select({ id: _tasks.id })
    .from(_tasks)
    .where(eq(_tasks.id, taskId))
    .limit(1);
  if (!task) throw new Error("Task not found");
  const [dep] = await exec
    .select({ id: _tasks.id })
    .from(_tasks)
    .where(eq(_tasks.id, dependsOnTaskId))
    .limit(1);
  if (!dep) throw new Error("Dependency task not found");
  // Read the cycle check on `exec` so it sees edges added earlier in the batch.
  if (await taskDependsOn(dependsOnTaskId, taskId, exec)) {
    throw new Error("Cycle detected in dependencies");
  }
  // THE ORDERING RULE: union at or before the edge write, NEVER after. A
  // committed union whose edge write is lost over-approximates membership —
  // harmless, that IS the invariant (membership grows, never shrinks). A
  // committed edge write whose union is lost UNDER-approximates, which is exactly
  // the bug this label exists to fix. So the union goes first, and it goes after
  // the guards above so a rejected cycle can never fuse two clusters.
  //
  // This is the only writer of `task_dependencies` — all 7 server and 6 web call
  // sites funnel through here — so this one line covers every edge creation.
  await unionTaskClusters(taskId, dependsOnTaskId, exec);
  // Seeded with the DEPENDENT end only. `dependsOnTaskId`'s own status is a
  // function of ITS ancestors, which this edge does not touch, and everything
  // downstream of `taskId` is already in `taskId`'s closure. The closure is the
  // same either side of the write — see the edge theorem in status-scope.ts.
  await withTaskStatusChange(taskId, exec, async () => {
    await exec
      .insert(_taskDependencies)
      .values({ taskId, dependsOnTaskId })
      .onConflictDoNothing();
  });
}

export async function removeTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
  exec: DbExecutor = db,
): Promise<boolean> {
  // Same seed as `addTaskDependency`, for the same reason — and this direction
  // is THE incident: detaching a blocker unblocks tasks several hops downstream,
  // while the edge's own dependent end often shows no change at all (it already
  // reads `done`/`dropped`), so naming only that end emitted nothing whatsoever.
  const row = await withTaskStatusChange(taskId, exec, async () => {
    const [deleted] = await exec
      .delete(_taskDependencies)
      .where(
        and(
          eq(_taskDependencies.taskId, taskId),
          eq(_taskDependencies.dependsOnTaskId, dependsOnTaskId),
        ),
      )
      .returning({ taskId: _taskDependencies.taskId });
    return deleted;
  });
  if (!row) return false;
  return true;
}

export async function dropTaskTree(id: string): Promise<number> {
  // One batch for the whole drop: the N per-task emits collapse into ONE flush
  // (one batched status read, one emit per task that actually moved), and the
  // update commits with them. `listTasks` reads the batch's own `tx` — reading
  // the pool from inside a transaction is the hold-and-wait shape
  // `database/no-pool-await-in-transaction` exists to prevent.
  return withTaskStatusBatch(async (tx) => {
    // Drop `id` plus every task that TRANSITIVELY depends on it and is still
    // active. The shared TaskGraph walk continues *through* settled
    // (done/dropped) intermediates to reach active nodes behind them, but never
    // re-acts on the settled nodes themselves — so already done/dropped
    // descendants are left untouched while a deep active dependent gated behind
    // one is still dropped.
    const graph = TaskGraph.from(await listTasks(tx));
    const ids = [
      ...new Set([id, ...graph.activeDependents(id).map((n) => n.id)]),
    ];

    const now = new Date();
    // ONE scope seeded with the whole id array: the dropped set and everything
    // downstream of it is a single closure, read once.
    await withTaskStatusChange(ids, tx, async () => {
      await tx
        .update(_tasks)
        .set({ droppedAt: now, heldAt: null })
        .where(inArray(_tasks.id, ids));
    });
    return ids.length;
  });
}
