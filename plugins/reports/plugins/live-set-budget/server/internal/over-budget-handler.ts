import { sinkHandler } from "@plugins/framework/plugins/server-core/core";
import { liveSetOverBudgetSink } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { recordReportDebounced } from "@plugins/reports/plugins/engine/server";
import { LIVE_SET_OVER_BUDGET_KIND } from "../../core";

// Every load of a set past its budget emits (an entrant's order read, each
// notify of an external set), so one row per key per 10 min: the row counts
// episodes, not loads.
const DEBOUNCE_MS = 10 * 60 * 1000;

/** network/live's over-budget sink → a `live-set-over-budget` report, debounced per key. */
export const overBudgetHandler = sinkHandler(
  liveSetOverBudgetSink,
  () => (body) => {
    recordReportDebounced(
      `${LIVE_SET_OVER_BUDGET_KIND}:${body.key}`,
      DEBOUNCE_MS,
      {
        kind: LIVE_SET_OVER_BUDGET_KIND,
        source: "server-live-set-budget",
        message: `${body.key}: ${body.rows} rows, budget ${body.budget}`,
        data: { ...body, params: { ...body.params } },
      },
    );
  },
);
