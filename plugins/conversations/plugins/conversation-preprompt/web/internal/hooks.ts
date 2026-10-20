import {
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import {
  conversationPrepromptRows,
  type ConversationPreprompt,
} from "../../core";

// This conversation's preprompt snapshot: its row of the lookup-only
// `conversationPrepromptRows` collection — one O(1) point sub. Called in the
// header chip and per-row in the sidebar list; the live-state keep-alive +
// sub-batch absorb the per-row sub churn. `found: false` is determinate (no
// preprompt recorded); "not loaded yet" stays the pending arm, so it can never
// read as "none".
export function useConversationPreprompt(
  conversationId: string,
): LiveRowResult<ConversationPreprompt> {
  return useLiveRow(conversationPrepromptRows, conversationId);
}
