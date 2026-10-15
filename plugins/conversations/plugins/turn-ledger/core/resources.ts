import { liveCollection } from "@plugins/network/plugins/live/core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { LedgerTurnSchema } from "./schemas";

// A conversation's ledger, read per conversation, newest first. The rows that
// still render something (held, typing, typed, merged, failed, unverified) are
// always among the newest: a turn reaches a verdict before the next few are
// sent. The window is a bound, not a page anyone scrolls.
export const conversationTurns = liveCollection("turn-ledger.turns", {
  row: LedgerTurnSchema,
  id: "id",
  filterable: { conversationId: liveText() },
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 20 },
  maxLimit: 100,
});
