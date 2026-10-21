import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  _conversations,
  getConversationRuntime,
} from "@plugins/tasks/plugins/tasks-core/server";
import { conversationContextUsage } from "../../core";
import { Runtime } from "../../server/internal/runtime";

/**
 * `conversations.context-usage`: the agent's own measure of its context
 * window, asked of its runtime on every read. The conversation row moves on
 * every turn start and end (and so around a compaction), so a write to it is
 * the push to measure again; throttled, since a row write is not always a
 * turn and each read is a round trip to the agent.
 */
export const contextUsageServed = serveValue(conversationContextUsage, {
  source: "external",
  changes: "notified",
  throttleMs: 1000,
  reads: {
    tables: [_conversations],
    reason:
      "the conversation's runtime row picks which runtime to ask, and its writes (a turn starting or ending) are when the window moves",
  },
  loader: async ({ id }) => {
    const row = await getConversationRuntime(id);
    if (!row) throw new Error(`Conversation ${id} not found`);
    return Runtime.get(row.runtime).contextUsage(id);
  },
});
