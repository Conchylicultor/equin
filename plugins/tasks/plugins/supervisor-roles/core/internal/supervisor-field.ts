import { z } from "zod";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * Who owns a task: one row per task a supervisor role owns, in the
 * `tasks_ext_supervisor` entity-extension table — `supervisor` is the role's
 * id (a foreign key, so a role that still owns tasks cannot be deleted), and
 * `filedFromTaskId` the task whose agent filed it into the role's backlog
 * (null for a task routed there by hand, or a session root), so a backlog row
 * can say who asked.
 *
 * Not the task's category: a category records the surface that FILED the
 * task (stamped by the filing plugin, never seen by agents); the supervisor
 * records who OWNS it, and changing it is how a task is re-routed to another
 * role's backlog.
 *
 * It EXPOSES `supervisor` to every list whose rows reach a task (the task
 * list filters and groups by it); a task with no row reads NULL — no role.
 */
export const taskSupervisorShape = defineExtensionShape({
  key: "taskId",
  fields: {
    supervisor: textField({ label: "Supervisor" }),
    filedFromTaskId: nullable(textField({ label: "Filed from task" })),
  },
  exposes: {
    parent: tasksEntityRef,
    name: "supervisor",
    fields: { supervisor: {} },
  },
});
export const TaskSupervisorRowSchema = taskSupervisorShape.schema;
export type TaskSupervisorRow = z.infer<typeof TaskSupervisorRowSchema>;

/**
 * One task's supervisor row, by task id (`useLive(taskSupervisors, { id })`;
 * `found: false` is "no role"). Lookup-only: a LIST of tasks reads the
 * exposed `supervisor` field instead, so the set is bounded by construction.
 */
export const taskSupervisors = liveCollection("task-supervisors.by-id", {
  from: taskSupervisorShape,
  id: "taskId",
});
