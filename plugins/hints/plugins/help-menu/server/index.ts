import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { HELP_CATEGORY_ID } from "../core/task-category";

export default {
  description:
    'The Help task category: the category questions asked from the ? menu ("Ask equin how to…") are grouped under.',
  portable: true,
  contributions: [
    TaskCategory({ id: HELP_CATEGORY_ID, label: "Help", order: 19 }),
  ],
} satisfies ServerPluginDefinition;
