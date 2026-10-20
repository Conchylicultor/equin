import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useTaskShortTitle } from "./hooks";
export type { TaskShortTitle } from "../core";

export default {
  description:
    "Reads a task's Haiku-made short title (at most three words) with useTaskShortTitle; a row is current only while its sourceTitle equals the task's title.",
} satisfies PluginDefinition;
