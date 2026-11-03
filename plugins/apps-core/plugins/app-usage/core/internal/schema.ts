import { z } from "zod";
import { clockParam, liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/**
 * One app's usage, summed over its daily rows. "7d" is today plus the six
 * days before it; "total" is everything still retained (two years, see the
 * server's retention).
 */
export const AppUsageSummaryRowSchema = z.object({
  appId: z.string(),
  launches7d: z.number(),
  focusedMs7d: z.number(),
  launchesTotal: z.number(),
  focusedMsTotal: z.number(),
  // Crosses the wire as an ISO string.
  lastOpenedAt: z.coerce.date().nullable(),
});
export type AppUsageSummaryRow = z.infer<typeof AppUsageSummaryRowSchema>;

/**
 * Today, the reader's local day (`YYYY-MM-DD`) — the 7-day window ends on it.
 * A clock param: the reader fills it (`useClockParam`) and re-pins it at local
 * midnight, so the window moves with the day, never with some later write.
 */
export const APP_USAGE_TODAY = clockParam.day();

/**
 * Every app ever used, with its summary — one row per app id, so the payload
 * is bounded by the app registry (tens), not by time. "7d" ends on `today`,
 * the reader's local day — the day the browser buckets usage by.
 */
export const appUsageSummary = liveValue("app-usage.summary", {
  params: { today: APP_USAGE_TODAY },
  schema: wholeList(AppUsageSummaryRowSchema, {
    reason:
      "one row per app id ever used — bounded by the installed app registry (tens of apps), never by time: the GROUP BY folds every day into its app",
  }),
});
