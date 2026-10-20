import type { Metrics } from "./query";

/**
 * Rates derived from {@link Metrics}. Each is `null` when its denominator is
 * zero — "no visits" has no bounce rate, it is not 0%.
 */

/**
 * The metrics that add up across days. `visitors` is deliberately absent: one
 * visitor spans many days, so a sum of daily visitors overcounts — it is
 * counted distinct over the whole span instead (`visitorCounts`, server).
 */
export type AdditiveMetrics = Omit<Metrics, "visitors">;

export const ZERO_ADDITIVE_METRICS: AdditiveMetrics = {
  visits: 0,
  pageviews: 0,
  bounces: 0,
  returningVisits: 0,
  durationMs: 0,
  events: 0,
};

export const ZERO_METRICS: Metrics = {
  visitors: 0,
  visits: 0,
  pageviews: 0,
  bounces: 0,
  returningVisits: 0,
  durationMs: 0,
  events: 0,
};

/** Field-wise sum; exact because every one of these is additive. */
export function addMetrics(
  a: AdditiveMetrics,
  b: AdditiveMetrics,
): AdditiveMetrics {
  return {
    visits: a.visits + b.visits,
    pageviews: a.pageviews + b.pageviews,
    bounces: a.bounces + b.bounces,
    returningVisits:
      a.returningVisits === null || b.returningVisits === null
        ? null
        : a.returningVisits + b.returningVisits,
    durationMs: a.durationMs + b.durationMs,
    events: a.events + b.events,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Share of visits that viewed exactly one page (0..1). */
export function bounceRate(m: Metrics): number | null {
  return ratio(m.bounces, m.visits);
}

export function viewsPerVisit(m: Metrics): number | null {
  return ratio(m.pageviews, m.visits);
}

/** Average visit duration, in ms. */
export function averageVisitDurationMs(m: Metrics): number | null {
  return ratio(m.durationMs, m.visits);
}

/** On a `page` row: average time that page was visible per view, in ms. */
export function averageTimeOnPageMs(pageRow: Metrics): number | null {
  return ratio(pageRow.durationMs, pageRow.pageviews);
}

/** On an `event` row: share of the period's visitors who fired it (0..1). */
export function conversionRate(
  eventRow: Metrics,
  summary: Metrics,
): number | null {
  return ratio(eventRow.visitors, summary.visitors);
}

/** A row's share of the period's visitors (0..1). */
export function visitorShare(row: Metrics, summary: Metrics): number | null {
  return ratio(row.visitors, summary.visitors);
}
