import { liveValue } from "@plugins/network/plugins/live/core";
import {
  CatalogSchema,
  DetailsSelectorSchema,
  DrillItemSchema,
  DrillMetaSchema,
  MetricQuerySchema,
  MetricResultSchema,
} from "./wire";

// The three reads every metrics surface makes, as live values — served in
// `server/internal/resources.ts`, read with `useLive` in
// `web/internal/use-metric.ts`. A source's `changes` reaches every subscribed
// query and drill-down of it (`server/internal/source-watch.ts`), so a number
// on screen refreshes without polling.

/** Every source, metric and breakdown with its label, unit, splits and param specs. Fixed per process. */
export const metricCatalog = liveValue("metrics.catalog", {
  schema: CatalogSchema,
});

/**
 * One metric (a series) or breakdown query. A structured question, so a typed
 * query value; on-demand, because an evaluation is a provider call each tab
 * refetches after a change rather than one the server pushes to every tab.
 */
export const metricQuery = liveValue("metrics.query", {
  schema: MetricResultSchema,
  query: MetricQuerySchema,
  load: "on-demand",
  // An unknown id, split or param, a bad range (`MetricQueryError`).
  refusals: ["invalid-query"],
});

/** A drill-down's page size: page 0 of a read with no `limit` of its own, and its step. */
const DRILL_PAGE = 50;

/** The most records a drill-down lists (its pages are every one live, so it is capped). */
const DRILL_MAX = 500;

/**
 * The records behind one bucket (or one series of it), newest first: key-range
 * pages cut at each record's `at` (then its id) — each loaded page live, a
 * keyed window a source's change reaches as a delta (so no `load`: a page is
 * always pushed). The bucket's total is the per-question sibling,
 * `metricDetails.meta`.
 */
export const metricDetails = liveValue("metrics.details", {
  query: DetailsSelectorSchema,
  paged: {
    item: DrillItemSchema,
    id: "id",
    key: { of: (item) => [item.at], order: ["desc"] },
    limit: DRILL_PAGE,
    maxLimit: DRILL_MAX,
    meta: DrillMetaSchema,
  },
  // An unknown id, interval or split, a metric with no details (`MetricQueryError`).
  refusals: ["invalid-query"],
});
