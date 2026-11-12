import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { conversationSectionIdKind } from "../core";

export { classifyQueue } from "./classify-queue";
export type { ClassifiedQueue, RankedConversation, TaskGroup } from "./classify-queue";

export default {
  description:
    "Queue classification (classifyQueue) consumed by the DataView Queue tab; a reorder is the server's (reorderQueue mints the rank). Ranks seeded once on creation (newest first); a waiting task group the user filed into a section (Pinned, or one of their own — the csec id kind, registered here) is read out under it.",
  contributions: [IdKinds.Kind({ kind: conversationSectionIdKind })],
} satisfies PluginDefinition;
