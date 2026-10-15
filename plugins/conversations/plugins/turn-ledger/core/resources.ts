import { liveCollection } from "@plugins/network/plugins/live/core";
import { LEDGER_TURN_CARRIED, LEDGER_TURN_LISTED } from "./schemas";

// A conversation's ledger, read per conversation, newest first. The rows that
// still render something (held, typing, merged, failed, unverified) are always
// among the newest: a turn reaches a verdict before the next few are sent. The
// window is a bound, not a page anyone scrolls.
export const conversationTurns = liveCollection("turn-ledger.turns", {
  fields: LEDGER_TURN_LISTED,
  carry: { fields: LEDGER_TURN_CARRIED },
  id: "id",
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 20 },
  maxLimit: 100,
});
