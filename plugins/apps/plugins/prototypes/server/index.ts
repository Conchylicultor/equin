import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { PROTOTYPES_CATEGORY_ID } from "../core/task-category";

// The app's data dir as a file root — the one way any sub-plugin reaches the
// prototypes tree, on every host.
export { prototypesFiles } from "./internal/roots";

export default {
  description:
    "The Prototypes task category: the category tasks filed from the Prototypes gallery, such as creating or improving a prototype, are grouped under. Declares the app's data dir as the prototypesFiles file root (watched, its _picks ledgered).",
  portable: true,
  contributions: [
    TaskCategory({ id: PROTOTYPES_CATEGORY_ID, label: "Prototypes", order: 9 }),
  ],
} satisfies ServerPluginDefinition;
