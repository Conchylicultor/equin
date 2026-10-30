import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * Which tasks an agent manages: one row per task under a live conversation
 * watch of ANOTHER task — on the task itself (an agent watching what it filed,
 * `watch.children`) or on an ancestor (a watch covers its subtree; a
 * supervisor root's `watch.tree`), in `tasks_ext_manager`. `managerTaskId` is
 * the nearest such watcher's own task, so when a sub-supervisor's conversation
 * ends, what it managed goes up one level to the watch above it. A task no
 * other task's agent watches has no row: it is the person's own.
 *
 * Derived from `task_watches` and the folder chain, never written by hand: the
 * watch writes, the watcher's conversation ending or coming back, and a task
 * created or re-filed refresh it (`refreshTaskManagers`).
 *
 * It EXPOSES its presence to every list whose rows reach a task (the
 * conversation lists, the task list) as `managedBy` — `agent` where the task
 * has a row, `you` where it has none — so a list filters out (or groups by)
 * what an agent is looking after; and `managerTaskId` itself (null where it
 * has none), so a list draws a managed task beneath its manager's row (the
 * Queue's `attach`).
 */
export const taskManagerShape = defineExtensionShape({
  key: "taskId",
  fields: { managerTaskId: textField() },
  exposes: {
    parent: tasksEntityRef,
    name: "manager",
    fields: { managerTaskId: { label: "Managed by task" } },
    presence: {
      id: "managedBy",
      label: "Managed by",
      values: { present: "agent", absent: "you" },
      options: { you: { label: "You" }, agent: { label: "Agent" } },
    },
  },
});
