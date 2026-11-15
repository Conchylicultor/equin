import {
  doublePrecision,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// What each Claude account spent, per UTC hour and per what spent it (at API
// prices) — the ONE spend ledger. Two writers, each in the write that counts
// the cost, accumulating (`cost_usd + excluded.cost_usd`, `spendLedgerUpsert`):
//
// - the usage sync (conversations/usage), source `conv:<conversationId>`: the
//   cost a pass priced, per hour of the priced tokens, in the same statement as
//   the file rows it was priced from — a failed write moves neither;
// - the claude-cli call recorder, source `cli:<sourceName>`: a one-shot call's
//   `total_cost_usd`, in the transaction that records the call. Written
//   explicitly, never rolled up from the call log, which is trimmed.
//
// Not keyed to a conversation (`source` is a plain key, see `SpendSource`): an
// account's spend outlives what spent it. Kept whole, like the call log is not:
// a row per (account, active hour, source) — a few thousand a month.
export const _claudeSpendHours = pgTable(
  "claude_spend_hours",
  {
    accountId: text("account_id").notNull(),
    /** The UTC hour the cost was spent in (minutes and seconds zero). */
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    /** What spent it — `conv:<id>`, `cli:<name>` or `unattributed` (`SpendSource`). */
    source: text("source").notNull(),
    costUsd: doublePrecision("cost_usd").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.hour, t.source] })],
);
