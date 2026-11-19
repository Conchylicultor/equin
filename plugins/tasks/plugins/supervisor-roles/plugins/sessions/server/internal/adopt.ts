import { and, eq, sql } from "drizzle-orm";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { withNotifyBatch } from "@plugins/framework/plugins/server-core/core";
import {
  assertChoiceLaunchable,
  type ModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { checkAfterIds } from "@plugins/tasks/core";
import {
  _tasks,
  addTaskDependency,
  clearMandate,
  DependencyCycleError,
  getTask,
  type DbExecutor,
  tasksView,
  updateTask,
  withTaskStatusBatch,
} from "@plugins/tasks/plugins/tasks-core/server";
import { armTaskAutoStart } from "@plugins/tasks/server";
import {
  roleBacklogSql,
  tasksSupervisor,
} from "@plugins/tasks/plugins/supervisor-roles/server";

/** Why a backlog task could not be adopted: not (or no more) in the role's
 * backlog, held by a person, or an `after` the graph refuses (an unknown task,
 * a dependency cycle) — `message` says which. */
export type AdoptRefusal =
  | { kind: "not-in-backlog" }
  | { kind: "held" }
  | { kind: "after"; message: string };

/** How the adopted task starts: armed with `model` (launched once nothing it
 * runs after is pending), or left for a person (or a later `edit_task
 * start: "armed"`) to start. */
export type AdoptStart =
  { kind: "armed"; model: ModelChoice } | { kind: "manual" };

/** A refusal raised inside the adoption's transaction, so it rolls back. */
export class AdoptRefused extends Error {
  constructor(readonly refusal: AdoptRefusal) {
    super(refusal.kind);
  }
}

/**
 * The adoption's writes, on the caller's transaction (exported for the
 * DB-backed test): lock the task, check it is still in `roleId`'s backlog and
 * not held (else throw `AdoptRefused`), move it under `rootTaskId`, drop its
 * mandate and owner row, and wire it after each of `after` (a cycle throws
 * `DependencyCycleError`). Arms nothing.
 */
export async function moveIntoSession(
  tx: DbExecutor,
  args: {
    taskId: string;
    roleId: string;
    rootTaskId: string;
    after: readonly string[];
  },
): Promise<void> {
  const { taskId, roleId, rootTaskId, after } = args;
  await tx.execute(
    sql`SELECT 1 FROM ${_tasks} WHERE ${_tasks.id} = ${taskId} FOR UPDATE`,
  );
  const [row] = await tx
    .select({ status: tasksView.status })
    .from(tasksView)
    .innerJoin(_tasks, eq(_tasks.id, tasksView.id))
    .innerJoin(
      tasksSupervisor.table,
      eq(tasksSupervisor.table.taskId, tasksView.id),
    )
    .where(and(eq(tasksView.id, taskId), roleBacklogSql(roleId)))
    .limit(1);
  if (!row) throw new AdoptRefused({ kind: "not-in-backlog" });
  if (row.status === "held") throw new AdoptRefused({ kind: "held" });
  await updateTask(taskId, { folderId: rootTaskId }, tx);
  await clearMandate(taskId, tx);
  await tasksSupervisor.delete(taskId, tx);
  for (const id of after) await addTaskDependency(taskId, id, tx);
}

/**
 * Adopt `taskId` from role `roleId`'s backlog into the session rooted at
 * `rootTaskId`: one transaction, the task row locked first so a concurrent
 * launch, hold or route is seen — still in the backlog (a root, or nested in
 * the tree it was routed from), it moves under the session's root, inherits
 * the session's mandate (any it states — the interactive one every root
 * states — dropped, or it would stay a root of its own), its owner row goes
 * (the tree's root carries the role from now on), and it is wired to run
 * after each of `after` (plain edges, spliced into no chain). Then, once
 * every edge is written — so it is never armed and unblocked in between — it
 * is armed per `start` (after `afterAdopt`). The ONE adopt, behind both the
 * `adopt_task` tool and the Supervisors pane's Adopt.
 */
export async function adoptIntoSession(args: {
  taskId: string;
  roleId: string;
  rootTaskId: string;
  start: AdoptStart;
  /** The tasks it runs after; absent = none. */
  after?: readonly string[];
  /** Runs once the task is adopted, before it is armed (the tool's watch). */
  afterAdopt?: () => Promise<void>;
}): Promise<
  { ok: true; after: string[] } | { ok: false; refusal: AdoptRefusal }
> {
  const { taskId, roleId, rootTaskId, start } = args;
  if (start.kind === "armed")
    assertChoiceLaunchable(start.model, getModelCatalog());
  let after: string[] = [];
  if (args.after !== undefined) {
    const checked = await checkAfterIds(args.after, {
      self: taskId,
      exists: async (id) => (await getTask(id)) !== null,
    });
    if (!checked.ok)
      return {
        ok: false,
        refusal: { kind: "after", message: checked.message },
      };
    after = checked.after;
  }
  try {
    await withNotifyBatch(() =>
      withTaskStatusBatch(async (tx) => {
        await moveIntoSession(tx, { taskId, roleId, rootTaskId, after });
      }),
    );
  } catch (err) {
    if (err instanceof AdoptRefused) return { ok: false, refusal: err.refusal };
    if (err instanceof DependencyCycleError)
      return { ok: false, refusal: { kind: "after", message: err.message } };
    throw err;
  }
  await args.afterAdopt?.();
  if (start.kind === "armed")
    await armTaskAutoStart({
      taskId,
      model: start.model,
      armedFrom: asPluginId("tasks.supervisor-roles.sessions"),
    });
  return { ok: true, after };
}

/** An adoption's refusal, in words. */
export function adoptRefusalMessage(
  taskId: string,
  refusal: AdoptRefusal,
  backlogName: string,
): string {
  switch (refusal.kind) {
    case "held":
      return `${taskId} is held by a person: it stays in the backlog.`;
    case "not-in-backlog":
      return `${taskId} is not in ${backlogName}.`;
    case "after":
      return `${refusal.message} — ${taskId} stays in the backlog.`;
  }
}
