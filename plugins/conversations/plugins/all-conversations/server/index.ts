import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  allConversationsServed,
  conversationHistoryServed,
} from "./internal/collection";

export default {
  description:
    "Serves the two conversation-list collections — `conversations.all.v2` (system conversations hidden by a default scope) and `conversations.history.v2` — over `_conversations` with the owner joins (attempt → task), routed: a conversation, attempt or task write refills only the rows it changes.",
  contributions: [
    ...allConversationsServed.declare,
    ...conversationHistoryServed.declare,
  ],
} satisfies ServerPluginDefinition;
