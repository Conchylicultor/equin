import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { BACKGROUND_CATEGORY_ID } from "../core";

export default {
  description:
    "The Background task category: the category a failed background run's investigation is filed under.",
  contributions: [
    TaskCategory({
      id: BACKGROUND_CATEGORY_ID,
      label: "Background",
      order: 16,
    }),
  ],
} satisfies ServerPluginDefinition;
