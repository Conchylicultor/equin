import type { PageSeries } from "./series";

const HOUR_MS = 60 * 60_000;
/** Below this span a rate is noise (and `performance.memory` refreshes ~20 min). */
const MIN_SPAN_MS = 30 * 60_000;

/**
 * A page's JS heap growth over the points it sampled, MB per hour: the change
 * from its first to its latest reading with a heap, over the time between
 * them. Null when the browser reports no heap or the span is too short to say.
 */
export function jsHeapGrowthMbPerHour(page: PageSeries): number | null {
  const withHeap = page.points.filter((p) => p.jsHeapUsedMb !== null);
  const first = withHeap[0];
  const last = withHeap.at(-1);
  if (first === undefined || last === undefined) return null;
  const span = last.t - first.t;
  if (span < MIN_SPAN_MS) return null;
  return ((last.jsHeapUsedMb! - first.jsHeapUsedMb!) / span) * HOUR_MS;
}
