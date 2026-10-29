import { serveValue } from "@plugins/network/plugins/live/machine";
import { conversationRuntimesServed } from "@plugins/tasks/plugins/tasks-core/server";
import { conversationContextUsage } from "../../core";
import { Runtime } from "../../server/internal/runtime";

/**
 * `conversations.context-usage`: the agent's own measure of its context
 * window, asked of its runtime on every read. The window moves when a turn
 * starts or ends (and so around a compaction), which is when the
 * conversation's `status` moves — so the value FOLLOWS that conversation's
 * `runtime` / `status` (tasks-core's `conversationRuntimes`, `{ ids: [id] }`):
 * another conversation's write, or this one's other columns, never re-asks
 * the agent. Throttled, since each read is a round trip to the agent.
 */
export const contextUsageServed = serveValue(conversationContextUsage, {
  source: "external",
  changes: "notified",
  // The runtime row picks which runtime to ask; its status (a turn starting
  // or ending) is when the window moves.
  follows: (follow) => ({
    conv: follow(conversationRuntimesServed, ({ id }) => ({ ids: [id] })),
  }),
  throttleMs: 1000,
  loader: async ({ id }, { followed }) => {
    const [row] = followed.conv;
    if (row === undefined) throw new Error(`Conversation ${id} not found`);
    return Runtime.get(row.runtime).contextUsage(id);
  },
});
