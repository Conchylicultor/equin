import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { PROTOTYPES_CATEGORY_ID } from "../core/task-category";

export default {
  description:
    "The Prototypes task category: the category tasks filed from the Prototypes gallery, such as creating or improving a prototype, are grouped under.",
  portable: true,
  contributions: [
    TaskCategory({ id: PROTOTYPES_CATEGORY_ID, label: "Prototypes", order: 9 }),
  ],
} satisfies ServerPluginDefinition;
