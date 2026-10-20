import {
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import {
  conversationProgressRows,
  type ConversationProgress,
} from "../../core";

// This conversation's progress row: its row of the lookup-only
// `conversationProgressRows` collection — one O(1) point sub. `found: false`
// is determinate (no progress classified yet); "not loaded yet" stays the
// pending arm, so it can never read as "no progress".
export function useProgressFor(
  conversationId: string,
): LiveRowResult<ConversationProgress> {
  return useLiveRow(conversationProgressRows, conversationId);
}
