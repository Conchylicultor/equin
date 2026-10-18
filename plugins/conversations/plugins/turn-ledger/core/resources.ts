import { liveCollection } from "@plugins/network/plugins/live/core";
import { ledgerTurnsEntityRef } from "./entity";

// A conversation's ledger, read per conversation, newest first. The rows that
// still render something (held, typing, merged, failed, unverified) are always
// among the newest: a turn reaches a verdict before the next few are sent. The
// window is a bound, not a page anyone scrolls.
export const conversationTurns = liveCollection("turn-ledger.turns", {
  from: ledgerTurnsEntityRef,
  pick: ["conversationId"],
  carry: {
    pick: [
      "id",
      "kind",
      "text",
      "state",
      "hookless",
      "extraText",
      "error",
      "createdAt",
      "updatedAt",
    ],
  },
  id: "id",
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 20 },
  maxLimit: 100,
});
