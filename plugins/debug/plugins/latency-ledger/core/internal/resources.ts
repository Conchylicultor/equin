import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { LATENCY_WINDOWS, LatencySummarySchema } from "./endpoints";
import { LATENCY_SUMMARY_TABS } from "./metrics";

/**
 * The responsiveness summary for one window and one set of tabs (`tabs`: a
 * person's, automation's, or every tab — `LATENCY_SUMMARY_TABS`): p50 / p95 by
 * minute class, the exit criteria, thread owners and the slowest interactions.
 *
 * Served external (`server/internal/summary-resource.ts`): its tables are
 * excluded from the change feed by declaration, so the ledger's own minute
 * flush is the only change signal, and it notifies the subscribed windows.
 *
 * `load: "on-demand"`: the 7-day histogram sum alone — one of the loader's
 * queries, so a lower bound on the whole load — measured ~340 ms on main
 * (2026-10-02, EXPLAIN ANALYZE, 28k minute rows × 67 buckets), past the 50 ms
 * bar for a value recomputed in the shared flush — so a flush sends an `invalidate` and each
 * open card refetches over HTTP (D15 of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md).
 */
export const latencySummary = liveValue("latency-ledger.summary", {
  schema: LatencySummarySchema,
  params: {
    window: z.enum(LATENCY_WINDOWS),
    tabs: z.enum(LATENCY_SUMMARY_TABS),
  },
  load: "on-demand",
});
