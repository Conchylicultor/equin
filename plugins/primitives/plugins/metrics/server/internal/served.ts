import type { LiveKeyRange } from "@plugins/network/plugins/live/core";
import type {
  Catalog,
  DetailsSelector,
  DrillItem,
  DrillMeta,
  MetricQuery,
  MetricResult,
} from "../../core";
import type { MetricRegistry } from "./registry";
import { runDetails, runDetailsTotal, runQuery } from "./run";
import type { SourceWatch } from "./source-watch";

// The options the three metrics values are served with (`./resources.ts`
// passes them to `serveValue`), built over a registry and a source watch so a
// test can drive them on its own.
//
// Freshness: a query or drill-down watches its metric's source for as long as
// a tab holds it (`whileSubscribed` → the source watch — once per drill-down
// QUESTION, however many of its pages and its total are held), and a change
// recomputes it — throttled, so a burst (a bulk write, a fetch landing many
// commits) is one refetch. Between a last unsubscribe and the next subscribe
// nothing watches, and nothing needs to: the runtime opens every subscription
// span with a fresh version, so a tab never trusts a value from before the gap.

/** A burst of source changes is one refetch per tuple. */
const THROTTLE_MS = 1000;

/** The catalog: fixed for the life of the process, so it is never notified. */
export function catalogOptions(registry: () => MetricRegistry) {
  return {
    source: "external" as const,
    changes: {
      fixed: {
        reason:
          "the metric sources are plugin contributions, registered once per process",
      },
    },
    loader: (): Catalog => registry().catalog,
  };
}

/**
 * Watch the source of `metricId` while a tuple is held. An id no source
 * contributed watches nothing — its loader is what fails, naming it.
 */
function watchMetric(
  registry: () => MetricRegistry,
  watch: SourceWatch,
): (query: { metric: string }, notify: () => void) => () => void {
  return ({ metric }, notify) => {
    const entry = registry().lookup(metric);
    if (entry.kind === "unknown") return () => {};
    return watch.acquire(entry.source.source.id, notify);
  };
}

/** One metric or breakdown query, evaluated now. */
export function queryOptions(
  registry: () => MetricRegistry,
  watch: SourceWatch,
) {
  return {
    source: "external" as const,
    changes: "notified" as const,
    loader: (query: MetricQuery): Promise<MetricResult> =>
      runQuery(registry(), query, new Date()),
    throttleMs: THROTTLE_MS,
    whileSubscribed: watchMetric(registry, watch),
  };
}

/** One key range of the records behind a bucket; the bucket's total is the meta sibling. */
export function detailsOptions(
  registry: () => MetricRegistry,
  watch: SourceWatch,
) {
  return {
    source: "external" as const,
    changes: "notified" as const,
    loader: (
      selector: DetailsSelector,
      range: LiveKeyRange,
    ): Promise<readonly DrillItem[]> => runDetails(registry(), selector, range),
    meta: async (selector: DetailsSelector): Promise<DrillMeta> => ({
      total: await runDetailsTotal(registry(), selector),
    }),
    throttleMs: THROTTLE_MS,
    whileSubscribed: watchMetric(registry, watch),
  };
}
