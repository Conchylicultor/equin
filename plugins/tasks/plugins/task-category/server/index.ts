import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { taskCategoriesServed } from "./internal/resource";
import { taskCategoryRegistryServed } from "./internal/registry";

export { TaskCategory } from "./internal/contribution";
export { tasksCategory } from "./internal/tables";
export { getTaskCategory, setTaskCategory } from "./internal/mutations";

export default {
  description:
    "Owns the tasks_ext_category side-table: the per-task category (registry-driven via the TaskCategory contribution, system-set only), its live collection (the whole ordered set, routed and L2-persisted), and the live category registry (fixed per process).",
  contributions: [
    ...taskCategoriesServed.declare,
    ...taskCategoryRegistryServed.declare,
  ],
} satisfies ServerPluginDefinition;
