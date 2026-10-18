import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { taskCategoriesServed } from "./internal/resource";
import { taskCategoryRegistryServed } from "./internal/registry";
import { tasksCategory } from "./internal/tables";

export { TaskCategory } from "./internal/contribution";
export { tasksCategory } from "./internal/tables";
export { getTaskCategory, setTaskCategory } from "./internal/mutations";

export default {
  description:
    "Owns the tasks_ext_category side-table: the per-task category (registry-driven via the TaskCategory contribution, system-set only), its live collection (the whole ordered set, routed and L2-persisted), the live category registry (fixed per process), and the category exposed to every list whose rows reach a task (LiveColumns.Expose).",
  contributions: [
    ...taskCategoriesServed.declare,
    ...taskCategoryRegistryServed.declare,
    // The category, folded into every list whose rows reach a task.
    LiveColumns.Expose(tasksCategory),
  ],
  // The first slice of the portable-server split: its whole server closure is
  // meant to run in the browser host too (measured by
  // `boundaries:portable-closure`).
  portable: true,
} satisfies ServerPluginDefinition;
