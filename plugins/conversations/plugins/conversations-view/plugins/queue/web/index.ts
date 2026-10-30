import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { classifyQueue } from "./classify-queue";
export type { ClassifiedQueue, RankedConversation, TaskGroup } from "./classify-queue";

export default {
  description:
    "Queue classification (classifyQueue) consumed by the DataView Queue tab; a reorder is the server's (reorderQueue mints the rank). Ranks seeded once on creation (newest first); a user-set pin lifts a waiting task group into its own top section.",
  contributions: [],
} satisfies PluginDefinition;
