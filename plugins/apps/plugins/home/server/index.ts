import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { APPS_CATEGORY_ID } from "../core/task-category";

export default {
  description:
    "The Apps task category: the category tasks filed from the Home app's cards, such as building a new app, are grouped under.",
  portable: true,
  contributions: [
    TaskCategory({ id: APPS_CATEGORY_ID, label: "Apps", order: 11 }),
  ],
} satisfies ServerPluginDefinition;
