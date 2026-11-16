import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { claudeSpendHoursView } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { supervisorsSpend } from "../../core";
import { readSpendBreakdown, SPEND_JOINED_RELATIONS } from "./spend-query";

// The breakdown recomputes on every write to the priced ledger (the change
// feed on the bases of `claude_spend_hours_v`: the token ledger, the rates,
// the price versions): one aggregate over at most a week of hourly
// rows per account, joined to what spent them. The joined task, conversation,
// role and automation rows are read again on each of those recomputes — never
// a recompute of their own, which would re-run the aggregate on every task or
// conversation write (a status flip, a title) and push the same bytes.
export const supervisorsSpendServed = serveValue(supervisorsSpend, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [claudeSpendHoursView],
    reason:
      "each account's priced usage per hour and source, summed over its window — a ledger write adds cost to the tree, a price correction re-prices it",
    notified: {
      relations: SPEND_JOINED_RELATIONS,
      reason:
        "what spent a cost (a conversation's task, mandate root, role, automation) and its name are read with the spend: the ledger moves on every usage-sync pass while anything runs, and the next write shows a rename or a re-route. Nothing notifies for them alone.",
    },
  },
  loader: ({ windows }) => readSpendBreakdown(db, windows),
});
