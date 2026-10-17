import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { taskActivityServed } from "./internal/arm";

export default {
  description:
    "The task arm of the activity space: binds the `tasks` table into the activity union (title, last change, creation); every field exposed on a task folds into its band.",
  register: [taskActivityServed],
} satisfies ServerPluginDefinition;
