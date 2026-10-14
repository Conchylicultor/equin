import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { categoryPresentation } from "./internal/presentation";

export { useTaskCategories, useTaskCategoryMap } from "./hooks";
export type { TaskCategoryMap } from "./hooks";

export default {
  description:
    "Per-task category (registry-driven, system-set only): presents the exposed `category` field of every list whose rows reach a task (the task list groups by it), its options read from the live category registry.",
  contributions: [categoryPresentation],
} satisfies PluginDefinition;
