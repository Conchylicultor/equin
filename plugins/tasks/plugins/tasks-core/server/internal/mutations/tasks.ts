import { and, eq, inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _taskDependencies, _tasks } from "../tables";
import { tasks } from "../views";
import { TaskGraph, taskAuthorColumns, type TaskFiling } from "../../../core";
import { taskIdKind } from "@plugins/tasks/plugins/task-ids/core";
import {
  findNextRankInFolder,
  isDescendant,
  listTasks,
  nearestMandate,
  taskDependsOn,
} from "../queries/tasks";
import type { MandateRef } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { mandateRefiledAs } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/server";
import { refreshEffectiveMandates } from "./mandate";
import { withTaskStatusChange } from "../status-scope";
import {
  taskCreated,
  taskDescriptionChanged,
  taskRefiled,
  taskTitleChanged,
} from "../tables-events";
import type { EmitTx } from "@plugins/infra/plugins/events/server";
import { withTaskStatusBatch, type DbExecutor } from "../status-batch";
import { Rank } from "@plugins/primitives/plugins/rank/core";

interface CreateTaskFields {
  id?: string;
  groupId?: string | null;
  title: string;
  // Defaults to true (machine-generated label). Pass false when the title is
  // human/agent-authored (explicit API/MCP title) so buildTaskPrompt keeps it.
  titleAuto?: boolean;
  /** Who decided the task should exist, and the surface that filed it. */
  filing: TaskFiling;
  rank?: Rank;
  description?: string | null;
}

/**
 * A task is filed under a folder (display-only hierarchy, not a dependency) —
 * and inherits that folder's mandate — or it is a root, and names its own
 * mandate (`defineMandate`): what an agent may do inside its subtree. There is
 * no root without one (tsc here, and the `tasks_root_has_mandate` CHECK
 * underneath).
 */
export type CreateTaskInput = CreateTaskFields &
  (
    | { folderId: string; mandate?: never }
    | { folderId?: null; mandate: MandateRef }
  );

export interface UpdateTaskPatch {
  title?: string;
  description?: string | null;
  drop?: boolean;
  hold?: boolean;
  // Re-file under a different folder (display-only hierarchy, not a dependency).
  // Re-filing to the root (`null`) copies the task's effective mandate onto it
  // when it has none of its own, so it keeps the powers it had.
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
  // under `withTaskStatusBatch`). The INSERT, the mandate refresh and the events
  // commit together. Only the pool path wraps, and on that path the caller holds
  // no locks, so this cannot deadlock.
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
    // `clusterId` is never an input: a new task is its own singleton, and the
    // database unions it into its folder's and its group's cluster as the row
    // lands (`../cluster-triggers.ts`) — the edge write IS the union.
    await exec.insert(_tasks).values({
      id,
      clusterId: id,
      folderId,
      mandateRef: input.folderId == null ? input.mandate.id : null,
      groupId: input.groupId ?? null,
      title: input.title,
      titleAuto: input.titleAuto ?? true,
      ...taskAuthorColumns(input.filing.author),
      filedFrom: input.filing.filedFrom,
      rank: rank.toJSON(),
      description: input.description ?? null,
    });
  });
  await refreshEffectiveMandates([id], exec);
  // On the creating executor, so the event commits (or rolls back) with the
  // row. Same PgTransaction ⇄ EmitTx cast as `withTaskStatusChange`'s emit.
  await taskTitleChanged.emit(
    { taskId: id, title: input.title },
    exec === db ? undefined : { tx: exec as EmitTx },
  );
  await taskCreated.emit(
    {
      taskId: id,
      folderId,
      title: input.title,
      ...taskAuthorColumns(input.filing.author),
      filedFrom: input.filing.filedFrom,
    },
    exec === db ? undefined : { tx: exec as EmitTx },
  );
  // No parent force-expand here: expand/collapse is device-local view state
  // owned by the data-view primitive, not a column. The tree reveals a new child
  // client-side (`useTreeRow.addChild` expands the row it created under). Which
  // columns move `updatedAt` is declared once, in the tasks entity's `touchedBy`
  // (`tables.ts`) — the insert's union relabels `clusterId`, which does not count.
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
  // Same executor-resolving split as `createTask`: a re-file's write, its
  // mandate refresh and `tasks.refiled` commit together. Only the pool path
  // wraps, and on that path the caller holds no locks, so this cannot deadlock.
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
    Object.assign(dbPatch, await prepareRefile(id, patch.folderId, exec));
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
    if (patch.folderId === null || typeof patch.folderId === "string")
      await finishRefile(id, patch.folderId, exec);
    if (typeof patch.title === "string") {
      await taskTitleChanged.emit(
        { taskId: id, title: patch.title },
        exec === db ? undefined : { tx: exec as EmitTx },
      );
    }
    if (patch.description === null || typeof patch.description === "string") {
      await taskDescriptionChanged.emit(
        { taskId: id, description: patch.description },
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

/**
 * The part of a re-file that is not the write itself, run before it on the
 * same executor (after the caller's self / descendant guards — a rejected
 * re-file must not write): filing to the root keeps the mandate the task had under its folder — a root names
 * one (the CHECK) — copied as its own; an OWNED mandate is never copied, the
 * task states the one its definition names for a re-file instead
 * (`mandateRefiledAs`: a task dragged out of a role session's tree must not
 * become a role session root no role owns). Returns the columns the write
 * sets.
 * After the write, the caller runs {@link finishRefile}. Shared by
 * `updateTask` and the tree's drag move, so no re-file path skips either half.
 */
export async function prepareRefile(
  id: string,
  folderId: string | null,
  exec: DbExecutor,
): Promise<{ folderId: string | null; mandateRef?: string }> {
  // Filing under a folder needs nothing here: the folder edge's write unions
  // the clusters in the database (`../cluster-triggers.ts`).
  if (folderId !== null) return { folderId };
  const own = await nearestMandate(id, exec);
  if (own.kind === "none") {
    throw new Error(
      `Cannot re-file task ${id} to the root: no mandate up its folder chain`,
    );
  }
  return own.rootTaskId === id
    ? { folderId }
    : { folderId, mandateRef: mandateRefiledAs(own.mandateId) };
}

/**
 * The part of a re-file run after its write, on the same executor: the
 * subtree's effective mandates, then `tasks.refiled` (it commits or rolls back
 * with the write) for what other plugins derive from the folder chain. The
 * other half of {@link prepareRefile}; every re-file path runs both.
 */
export async function finishRefile(
  id: string,
  folderId: string | null,
  exec: DbExecutor,
): Promise<void> {
  await refreshEffectiveMandates([id], exec);
  await taskRefiled.emit(
    { taskId: id, folderId },
    exec === db ? undefined : { tx: exec as EmitTx },
  );
}

/**
 * Names `mandate` as the mandate of `taskId`'s subtree — on a nested task it
 * overrides its ancestors' (nearest wins). What it grants is the mandate's
 * definition, read live.
 */
export async function setMandate(
  taskId: string,
  mandate: MandateRef,
  exec: DbExecutor = db,
): Promise<void> {
  const [row] = await exec
    .update(_tasks)
    .set({ mandateRef: mandate.id })
    .where(eq(_tasks.id, taskId))
    .returning({ id: _tasks.id });
  if (!row) throw new Error(`setMandate: no task ${taskId}`);
  await refreshEffectiveMandates([taskId], exec);
}

/**
 * Drops `taskId`'s own mandate, so it inherits its nearest ancestor's again.
 * Refused on a root: a root always states one.
 */
export async function clearMandate(
  taskId: string,
  exec: DbExecutor = db,
): Promise<void> {
  const [task] = await exec
    .select({ folderId: _tasks.folderId })
    .from(_tasks)
    .where(eq(_tasks.id, taskId))
    .limit(1);
  if (!task) throw new Error(`clearMandate: no task ${taskId}`);
  if (task.folderId === null) {
    throw new Error(
      `clearMandate: task ${taskId} is a root — a root always states its mandate`,
    );
  }
  await exec
    .update(_tasks)
    .set({ mandateRef: null })
    .where(eq(_tasks.id, taskId));
  await refreshEffectiveMandates([taskId], exec);
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

/**
 * The dependency edge refused because it would close a cycle (or point a task
 * at itself). Its own type so an endpoint answers it as a conflict (409),
 * which the browser names as "Circular dependency not added".
 */
export class DependencyCycleError extends Error {
  constructor(message = "Cycle detected in dependencies") {
    super(message);
    this.name = "DependencyCycleError";
  }
}

export async function addTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
  exec: DbExecutor = db,
): Promise<void> {
  if (dependsOnTaskId === taskId)
    throw new DependencyCycleError("A task cannot depend on itself");
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
    throw new DependencyCycleError();
  }
  // The edge write unions the two clusters in the database, in this
  // transaction (`../cluster-triggers.ts`), after the guards above — a rejected
  // cycle never reaches it, so it can never fuse two clusters.
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
