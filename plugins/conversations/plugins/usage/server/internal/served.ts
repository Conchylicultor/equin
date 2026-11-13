import { and, asc, eq, like } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { claudeAccountSpend, conversationUsageById } from "../../core";
import { _conversationUsageAccountDays, conversationUsage } from "./tables";

// The cost stat's read: a primary-key seek of the conversation's totals, and
// the `:rows` point routing sends a recount to its own conversation's readers
// alone.
export const conversationUsageByIdServed = serveCollection(
  conversationUsageById,
  { from: conversationUsage },
);

// One account's days of the asked month: a prefix read of the primary key.
// Every write to the table recomputes each subscribed tuple (a db value
// recomputes whole) — a handful of accounts, at most 31 rows each.
export const claudeAccountSpendServed = serveValue(claudeAccountSpend, {
  source: "db",
  reads: {
    tables: [_conversationUsageAccountDays],
    reason: "the account's spend per day",
  },
  loader: async ({ accountId, month }) => {
    const t = _conversationUsageAccountDays;
    const days = await db
      .select({ date: t.date, costUsd: t.costUsd })
      .from(t)
      .where(and(eq(t.accountId, accountId), like(t.date, `${month}-%`)))
      .orderBy(asc(t.date));
    return { days };
  },
});
