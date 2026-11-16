import { z } from "zod";
import { sql } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { claudeSpendHoursView } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import {
  claudeAccountSpend,
  conversationUsageById,
  type AccountSpendDay,
} from "../../core";
import { _claudeAccountSpendCarryover, conversationUsage } from "./tables";

const AccountSpendDaySchema = z.object({
  date: z.string(),
  costUsd: z.number(),
});

// The cost stat's read: a primary-key seek of the conversation's totals, and
// the `:rows` point routing sends a recount to its own conversation's readers
// alone.
export const conversationUsageByIdServed = serveCollection(
  conversationUsageById,
  { from: conversationUsage },
);

/**
 * One account's spend per UTC day of `month` (`YYYY-MM`, UTC): the priced
 * token ledger's hours of the month (`claude_spend_hours_v` — every source;
 * an hour the view cannot price adds nothing, and the `cost-unpriced-model`
 * report names it), plus the legacy `unattributed` spend carried over (by
 * the migration that dropped the dollar ledger) for the days before spend
 * was filed per source — summed per day, in day order.
 * A day with usage but no priced cost reads 0.
 */
export async function accountSpendDays(
  exec: DbExecutor,
  accountId: string,
  month: string,
): Promise<AccountSpendDay[]> {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()))
    throw new Error(`not a month (YYYY-MM): ${month}`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const v = claudeSpendHoursView;
  const c = _claudeAccountSpendCarryover;
  return executeRows(exec, {
    label: "account spend days",
    query: sql`
      SELECT day AS date, sum(cost_usd)::float8 AS "costUsd"
        FROM (
          SELECT to_char(${v.hour} AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                 coalesce(${v.costUsd}, 0) AS cost_usd
            FROM ${v}
           WHERE ${v.accountId} = ${accountId}
             AND ${v.hour} >= ${start.toISOString()}::timestamptz
             AND ${v.hour} < ${end.toISOString()}::timestamptz
          UNION ALL
          SELECT to_char(${c.day}, 'YYYY-MM-DD'), ${c.costUsd}
            FROM ${c}
           WHERE ${c.accountId} = ${accountId}
             AND ${c.day} >= ${month + "-01"}::date
             AND ${c.day} < ${end.toISOString().slice(0, 10)}::date
        ) spend
       GROUP BY day
       ORDER BY day`,
    row: AccountSpendDaySchema,
  });
}

// Every write to the ledger, the rates or the price versions recomputes each
// subscribed tuple (a db value recomputes whole) — a handful of accounts, a
// month of hourly rows each, a range read of the ledger's hour index.
export const claudeAccountSpendServed = serveValue(claudeAccountSpend, {
  source: "db",
  reads: {
    tables: [claudeSpendHoursView, _claudeAccountSpendCarryover],
    reason:
      "the account's priced usage per hour, and its carried-over legacy days, summed per day",
  },
  loader: async ({ accountId, month }) => ({
    days: await accountSpendDays(db, accountId, month),
  }),
});
