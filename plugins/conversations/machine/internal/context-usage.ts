import { serveValue } from "@plugins/network/plugins/live/machine";
import { runtimeOfConversationLookup } from "@plugins/tasks/plugins/tasks-core/server";
import { conversationContextUsage } from "../../core";
import { Runtime } from "../../server/internal/runtime";

/**
 * `conversations.context-usage`: the agent's own measure of its context
 * window, asked of its runtime on every read. The window moves when a turn
 * starts or ends (and so around a compaction), which is when the
 * conversation's `status` moves — so the read is reached through a compiled
 * lookup of THAT conversation's `runtime` / `status`: another conversation's
 * write, or this one's other columns, never re-asks the agent. Throttled,
 * since each read is a round trip to the agent.
 */
export const contextUsageServed = serveValue(conversationContextUsage, {
  source: "external",
  changes: "notified",
  throttleMs: 1000,
  reads: {
    tables: [],
    lookups: [runtimeOfConversationLookup.read<{ id: string }>((p) => p.id)],
    reason:
      "the conversation's runtime row picks which runtime to ask, and its status (a turn starting or ending) is when the window moves",
  },
  loader: async ({ id }) => {
    const found = await runtimeOfConversationLookup.run(id);
    if (!found.found) throw new Error(`Conversation ${id} not found`);
    return Runtime.get(found.row.runtime).contextUsage(id);
  },
});
