import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { withNotifyBatch } from "@plugins/framework/plugins/server-core/core";
import {
  assertChoiceLaunchable,
  type ModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import {
  _tasks,
  clearMandate,
  tasksView,
  updateTask,
  withTaskStatusBatch,
} from "@plugins/tasks/plugins/tasks-core/server";
import { armTaskAutoStart } from "@plugins/tasks/server";
import {
  BACKLOG_STATUSES,
  supervisorRoleMandate,
} from "@plugins/tasks/plugins/supervisor-roles/core";
import { tasksSupervisor } from "@plugins/tasks/plugins/supervisor-roles/server";

/** Why a backlog task could not be adopted. */
export type AdoptRefusal = "not-in-backlog" | "held";

/**
 * Adopt `taskId` from role `roleId`'s backlog into the session rooted at
 * `rootTaskId`: one transaction, the task row locked first so a concurrent
 * launch, hold or route is seen — still in the backlog, it joins the session's
 * tree, inherits the session's mandate (its own — the interactive one every
 * root states — dropped, or it would stay a root of its own), and its owner
 * row goes (the tree's root carries the role from now on). Then it is armed
 * with `model` (after `beforeArm`). The ONE adopt, behind both the `adopt_task` tool and the
 * Supervisors pane's Adopt.
 */
export async function adoptIntoSession(args: {
  taskId: string;
  roleId: string;
  rootTaskId: string;
  model: ModelChoice;
  /** Runs once the task is adopted, before it is armed (the tool's watch). */
  beforeArm?: () => Promise<void>;
}): Promise<{ ok: true } | { ok: false; refusal: AdoptRefusal }> {
  const { taskId, roleId, rootTaskId, model } = args;
  assertChoiceLaunchable(model, getModelCatalog());
  const refusal = await withNotifyBatch(() =>
    withTaskStatusBatch(async (tx): Promise<AdoptRefusal | null> => {
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
        .where(
          and(
            eq(tasksView.id, taskId),
            eq(tasksSupervisor.table.supervisor, roleId),
            isNull(tasksView.folderId),
            ne(_tasks.mandateRef, supervisorRoleMandate.id),
            inArray(tasksView.status, [...BACKLOG_STATUSES]),
          ),
        )
        .limit(1);
      if (!row) return "not-in-backlog";
      if (row.status === "held") return "held";
      await updateTask(taskId, { folderId: rootTaskId }, tx);
      await clearMandate(taskId, tx);
      await tasksSupervisor.delete(taskId, tx);
      return null;
    }),
  );
  if (refusal !== null) return { ok: false, refusal };
  await args.beforeArm?.();
  await armTaskAutoStart({
    taskId,
    model,
    armedFrom: asPluginId("tasks.supervisor-roles.sessions"),
  });
  return { ok: true };
}
