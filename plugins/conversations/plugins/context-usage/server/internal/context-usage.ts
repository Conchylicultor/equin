import { serveCollection } from "@plugins/network/plugins/live/server";
import { conversationContextUsage, type ContextUsage } from "../../core";
import { conversationContext } from "./tables";

// The context ring's read: a primary-key seek of the conversation's last
// reading — never a round trip to the agent — and the `:rows` point routing
// sends a new reading to its own conversation's readers alone.
export const conversationContextUsageServed = serveCollection(
  conversationContextUsage,
  { from: conversationContext },
);

/**
 * Record the agent's latest measure of its context window. A runtime calls it
 * with each reading its agent reports, in the order the agent took them.
 */
export async function recordContextUsage(
  conversationId: string,
  usage: ContextUsage,
): Promise<void> {
  await conversationContext.upsert(conversationId, { usage });
}
