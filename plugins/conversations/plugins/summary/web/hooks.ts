import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { conversationSummaries, type ConversationSummary } from "../core";

/**
 * The conversation's most recent summary. Settled `null` means it was never
 * summarised; "not loaded yet" stays the pending arm, so a summarised
 * conversation can never read as "No summary yet" during the load window.
 *
 * A one-row window of the collection's default order (`generatedAt desc`), so
 * the server hands back the latest row and nothing else.
 */
export function useLatestConversationSummary(
  conversationId: string,
): ResourceResult<ConversationSummary | null> {
  const latest = useLive(conversationSummaries, {
    where: { conversationId },
    limit: 1,
  });
  return mapResource(latest, (rows) => rows[0] ?? null);
}
