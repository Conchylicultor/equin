import { liveArm } from "@plugins/network/plugins/live/core";
import { activity } from "@plugins/activity/core";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * Tasks, as an arm of the activity space. Declared FROM the task entity, so
 * every field a plugin exposes on a task (track, category, the automation it
 * came from) is listed in the "Task" band of every list of activity — with no
 * code here. Its own fields are none: a task's status is computed over its
 * attempts, not a column of it.
 */
export const taskActivityArm = liveArm(activity, "task", {
  label: "Task",
  order: 10,
  from: tasksEntityRef,
});
