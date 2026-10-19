import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { DEPLOY_CATEGORY_ID } from "../core/task-category";

export default {
  description:
    "The Deploy task category: the category tasks filed from the Deploy app, such as a failed deploy's investigation, are grouped under.",
  portable: true,
  contributions: [
    TaskCategory({ id: DEPLOY_CATEGORY_ID, label: "Deploy", order: 8 }),
  ],
} satisfies ServerPluginDefinition;
