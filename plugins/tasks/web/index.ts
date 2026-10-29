import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  usePatchTask,
  useTask,
  useTasksById,
  useActiveDependentCount,
} from "./client";
export type { TaskPatch } from "./client";

export default {
  description: "Nested tasks with attempts linking to conversations.",
} satisfies PluginDefinition;
