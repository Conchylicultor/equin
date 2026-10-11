import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  useLive,
  type LiveListResult,
} from "@plugins/network/plugins/live/web";
import {
  metricCatalog,
  metricDetails,
  metricQuery,
  type Catalog,
  type DetailsSelector,
  type DrillItem,
  type DrillMeta,
  type MetricQuery,
  type MetricResult,
} from "../../core";

// The three metrics reads, each a live value (`core/live.ts`): a change the
// metric's source announces refetches what a tab shows — the server watches
// the source while the tab holds the read, and the query cache keeps the last
// answer on screen while the refetch runs. A changed question (a new range, a
// split) is a new tuple, and shows its own loading state.

/** The served catalog: every source, metric and breakdown. Fixed per process. */
export function useMetricCatalog(): ResourceResult<Catalog> {
  return useLive(metricCatalog);
}

/** One metric (or breakdown) query; the server resolves its source from the metric id. */
export function useMetric(query: MetricQuery): ResourceResult<MetricResult> {
  return useLive(metricQuery, query);
}

/** A drawer's preview — page 0 — and the step each "Show more" grows it by. */
export const DETAILS_STEP = 5;

/**
 * The records behind one bucket (optionally one split key), newest first: a
 * preview of `DETAILS_STEP`, growing by as many per `loadMore` — every loaded
 * page live, up to the declaration's `maxLimit` (`canGrow` false there).
 */
export function useMetricDetails(
  selector: DetailsSelector,
): LiveListResult<DrillItem> {
  return useLive(metricDetails, selector, { limit: DETAILS_STEP });
}

/** How many records the bucket holds in all (`total: null` — its metric does not count them). */
export function useMetricDetailsTotal(
  selector: DetailsSelector,
): ResourceResult<DrillMeta> {
  return useLive(metricDetails.meta, selector);
}
