import { desc, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { nullable } from "@plugins/database/plugins/sql-projection/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { appUsageSummary } from "../../core";
import { _appUsageDaily } from "./tables";

const t = _appUsageDaily;
// Today and the six days before it. `current_date` is the server's local day,
// which is the user's: one instance per user, on their machine.
const IN_LAST_7_DAYS = sql`${t.day} > current_date - 7`;

// Push over `app_usage_daily`: a write to it recomputes the summary on every
// flush (the declared `reads`) — the route notifies nothing. Flushes
// come in bursts (an app switch in two windows), hence the throttle.
export const appUsageSummaryServed = serveValue(appUsageSummary, {
  source: "db",
  reads: {
    tables: [_appUsageDaily],
    reason:
      "the summary folds every day's row into one row per app, so a write to any row of the table may change any app's totals",
  },
  throttleMs: 2000,
  unbounded: {
    reason:
      "one row per app id ever used — bounded by the installed app registry (tens of apps), never by time: the GROUP BY folds every day into its app",
  },
  loader: async () =>
    db
      .select({
        appId: t.appId,
        launches7d:
          sql`coalesce(sum(${t.launches}) filter (where ${IN_LAST_7_DAYS}), 0)`.mapWith(
            Number,
          ),
        focusedMs7d:
          sql`coalesce(sum(${t.focusedMs}) filter (where ${IN_LAST_7_DAYS}), 0)`.mapWith(
            Number,
          ),
        launchesTotal: sql`coalesce(sum(${t.launches}), 0)`.mapWith(Number),
        focusedMsTotal: sql`coalesce(sum(${t.focusedMs}), 0)`.mapWith(Number),
        lastOpenedAt: sql`max(${t.lastOpenedAt})`.mapWith(
          nullable(t.lastOpenedAt),
        ),
      })
      .from(t)
      .groupBy(t.appId)
      .orderBy(desc(sql`sum(${t.focusedMs})`), t.appId),
});
