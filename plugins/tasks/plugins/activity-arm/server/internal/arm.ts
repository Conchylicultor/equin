import { activityServed } from "@plugins/activity/server";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { taskActivityArm } from "../../core";

/** Tasks, bound into the activity union: every task, dropped and held ones included (its exposures filter them). */
export const taskActivityServed = activityServed.arm(taskActivityArm, {
  from: _tasks,
  id: _tasks.id,
  base: (j) => ({
    title: j.base.title,
    updatedAt: j.base.updatedAt,
    createdAt: j.base.createdAt,
  }),
  extra: () => ({}),
});
