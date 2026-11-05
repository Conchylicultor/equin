import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { TaskTreeRow } from "@plugins/tasks/plugins/tasks-core/core";

export const Tasks = {
  // Over the tasks tree's rows (`taskWindow`'s — exposed fields under
  // `$columns`, the child count under `$childCount`).
  TaskActions: defineItemActions<TaskTreeRow>(),
};
