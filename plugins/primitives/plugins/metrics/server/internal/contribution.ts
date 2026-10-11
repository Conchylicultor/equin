import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { LiveKeyRange } from "@plugins/network/plugins/live/core";
import type {
  BreakdownDecl,
  BreakdownEvaluate,
  DeclParams,
  DrillItem,
  Interval,
  MetricDecl,
  MetricEvaluate,
  MetricSourceDecl,
} from "../../core";

/** Which records a metric's `details` / `detailsTotal` is asked about: one bucket (or one series of it). */
export interface DetailsScope<P> {
  interval: Interval;
  /** The split dimension and key the user picked; null = every record in the interval. */
  split: { id: string; key: string } | null;
  params: P;
}

/**
 * What a metric's `details` receives: the scope, and one key range of its
 * records — newest first, by `at` (UTC, millisecond precision) then `id`:
 * the records strictly after `range.after` and up to `range.until`, at most
 * `range.limit` (network/live's `sliceRange` answers it for a list held in
 * memory). A range's cut is a position: the record it was taken from may be
 * gone.
 */
export interface DetailsCtx<P> extends DetailsScope<P> {
  range: LiveKeyRange;
}

export type MetricDetails<P> = (
  ctx: DetailsCtx<P>,
) => Promise<readonly DrillItem[]>;

/** How many records a scope holds — the drill-down's total. */
export type MetricDetailsTotal<P> = (ctx: DetailsScope<P>) => Promise<number>;

// The erased forms the registry holds. Params are `Record<string, unknown>`
// here because the registry holds every metric at once; each call is handed
// the params parsed against THAT metric's own specs, which is the type
// `serveMetric` / `serveBreakdown` checked the evaluator against.
type AnyParams = Record<string, unknown>;

export interface MetricImpl {
  metric: MetricDecl;
  evaluate: MetricEvaluate<AnyParams>;
  details?: MetricDetails<AnyParams>;
  detailsTotal?: MetricDetailsTotal<AnyParams>;
}

export interface BreakdownImpl {
  breakdown: BreakdownDecl;
  evaluate: BreakdownEvaluate<AnyParams>;
}

/**
 * Bind a metric declaration to its evaluator (and optional drill-down — its
 * records, and how many there are), typed by its params. A `detailsTotal`
 * without `details` is a tsc error: a total counts the records it lists.
 */
export function serveMetric<M extends MetricDecl>(
  metric: M,
  impl: {
    evaluate: MetricEvaluate<DeclParams<M>>;
  } & (
    | { details?: undefined; detailsTotal?: undefined }
    | {
        details: MetricDetails<DeclParams<M>>;
        detailsTotal?: MetricDetailsTotal<DeclParams<M>>;
      }
  ),
): MetricImpl {
  return {
    metric,
    evaluate: impl.evaluate as unknown as MetricEvaluate<AnyParams>,
    ...(impl.details !== undefined && {
      details: impl.details as unknown as MetricDetails<AnyParams>,
    }),
    ...(impl.detailsTotal !== undefined && {
      detailsTotal:
        impl.detailsTotal as unknown as MetricDetailsTotal<AnyParams>,
    }),
  };
}

/** Bind a breakdown declaration to its evaluator, typed by its params. */
export function serveBreakdown<B extends BreakdownDecl>(
  breakdown: B,
  impl: { evaluate: BreakdownEvaluate<DeclParams<B>> },
): BreakdownImpl {
  return {
    breakdown,
    evaluate: impl.evaluate as unknown as BreakdownEvaluate<AnyParams>,
  };
}

export interface SourceImpl {
  source: MetricSourceDecl;
  metrics: readonly MetricImpl[];
  breakdowns?: readonly BreakdownImpl[];
  /**
   * What makes this source's numbers stale: subscribe `bump` to it and return
   * the unsubscribe. Runs only while a tab holds a query or drill-down of the
   * source — once, however many (`source-watch.ts`); each bump refetches them.
   * Absent = the numbers change only with the range (nothing to watch).
   */
  changes?: (bump: () => void) => () => void;
}

// One contribution per metric source. Consumers never import a provider: the
// served catalog, query and details values read this collection generically.
export const MetricsServer = {
  Source: defineServerContribution<SourceImpl>("metrics.source", {
    docLabel: (s) => s.source.id,
  }),
};
