import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  assertChoiceLaunchable,
  DEFAULT_MODEL_CHOICE,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { armTaskAutoStart } from "@plugins/tasks/server";
import { supervisorRoleMandate } from "@plugins/tasks/plugins/supervisor-roles/core";
import {
  getSupervisorRole,
  liveSessionOf,
  setTaskSupervisorRole,
} from "@plugins/tasks/plugins/supervisor-roles/server";
import { launchRoleSession } from "../../core";

export const handleLaunchRoleSession = implement(
  launchRoleSession,
  async ({ params, body }) => {
    const role = await getSupervisorRole(params.id);
    if (!role) throw new HttpError(404, `No supervisor role "${params.id}".`);
    const model = body.model ?? DEFAULT_MODEL_CHOICE;
    assertChoiceLaunchable(model, getModelCatalog());
    const opened = await db.transaction(async (tx) => {
      // One live session per role: concurrent launches of one role
      // serialize here, and the second finds the first.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`supervisor-role-session:${role.id}`}))`,
      );
      const live = await liveSessionOf(role.id, tx);
      // A live session that never ran (`new`) is (re)armed below: an arm
      // that failed after its launch committed would otherwise hold the
      // role's one session slot forever.
      if (live)
        return { taskId: live.id, started: false, arm: live.status === "new" };
      const prompt = role.prompt.trim();
      const task = await createTask(
        {
          mandate: supervisorRoleMandate,
          title: `${role.name} session`,
          titleAuto: false,
          description: prompt === "" ? null : prompt,
          filing: {
            author: { kind: "human" },
            filedFrom: asPluginId("tasks.supervisor-roles.sessions"),
          },
        },
        tx,
      );
      await setTaskSupervisorRole(task.id, role.id, tx);
      return { taskId: task.id, started: true, arm: true };
    });
    // After the commit: the launcher it wakes must see the task.
    if (opened.arm)
      await armTaskAutoStart({
        taskId: opened.taskId,
        model,
        armedFrom: asPluginId("tasks.supervisor-roles.sessions"),
      });
    return { taskId: opened.taskId, started: opened.started };
  },
);
