import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { TaskRow } from "@plugins/tasks/plugins/tasks-core/core";

export const Tasks = {
  // Over the task list's rows (`taskRows`' — exposed fields under `$columns`).
  TaskActions: defineItemActions<TaskRow>(),
};
