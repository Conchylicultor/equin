import { z } from "zod";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import { _claudeSpendHours } from "@plugins/infra/plugins/claude-cli/plugins/spend-ledger/server";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import {
  claudeAccountSpend,
  conversationUsageById,
  type AccountSpendDay,
} from "../../core";
import { conversationUsage } from "./tables";

// The cost stat's read: a primary-key seek of the conversation's totals, and
// the `:rows` point routing sends a recount to its own conversation's readers
// alone.
export const conversationUsageByIdServed = serveCollection(
  conversationUsageById,
  { from: conversationUsage },
);

/**
 * One account's spend per UTC day of `month` (`YYYY-MM`, UTC): the spend
 * ledger's hours of the month — a range read of its primary key's
 * (account, hour) prefix, every source, `unattributed` history included —
 * summed per day, in day order.
 */
export async function accountSpendDays(
  exec: DbExecutor,
  accountId: string,
  month: string,
): Promise<AccountSpendDay[]> {
  const t = _claudeSpendHours;
  const start = new Date(`${month}-01T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()))
    throw new Error(`not a month (YYYY-MM): ${month}`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const day = sql`to_char(date_trunc('day', ${t.hour}, 'UTC'), 'YYYY-MM-DD')`;
  return exec
    .select({
      date: day.mapWith(parsed(z.string(), "UTC day")).as("date"),
      costUsd: sql`sum(${t.costUsd})`.mapWith(t.costUsd).as("cost_usd"),
    })
    .from(t)
    .where(and(eq(t.accountId, accountId), gte(t.hour, start), lt(t.hour, end)))
    .groupBy(day)
    .orderBy(day);
}

// Every write to the ledger recomputes each subscribed tuple (a db value
// recomputes whole) — a handful of accounts, a month of hourly rows each.
export const claudeAccountSpendServed = serveValue(claudeAccountSpend, {
  source: "db",
  reads: {
    tables: [_claudeSpendHours],
    reason: "the account's spend per hour, summed per day",
  },
  loader: async ({ accountId, month }) => ({
    days: await accountSpendDays(db, accountId, month),
  }),
});
