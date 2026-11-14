import { and, eq } from "drizzle-orm";
import { Queue } from "@plugins/conversations/plugins/conversations-view/plugins/queue/server";
import { conversationSectionIdKind } from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { supervisorRoleMandate } from "../../core";
import { _supervisorRoles, tasksSupervisor } from "./tables";

/**
 * A role's session lands in the role's queue section: the task is a session
 * root (it states the supervisor-role mandate) and the role it works for has
 * a section. Every other task: no answer.
 */
export const roleSessionLaunchSection = Queue.LaunchSection({
  id: "supervisor-role-session",
  sectionFor: async (taskId, exec) => {
    const [row] = await exec
      .select({ section: _supervisorRoles.section })
      .from(_tasks)
      .innerJoin(
        tasksSupervisor.table,
        eq(tasksSupervisor.table.taskId, _tasks.id),
      )
      .innerJoin(
        _supervisorRoles,
        eq(_supervisorRoles.id, tasksSupervisor.table.supervisor),
      )
      .where(
        and(
          eq(_tasks.id, taskId),
          eq(_tasks.mandateRef, supervisorRoleMandate.id),
        ),
      )
      .limit(1);
    const section = row?.section ?? null;
    return section === null ? null : conversationSectionIdKind.key(section);
  },
});
