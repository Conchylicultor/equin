import { ResourceRefusal } from "@plugins/packages/plugins/resource-protocol/core";
import {
  InvalidRangeError,
  evaluateBreakdown,
  evaluateMetric,
  parseParams,
  type DetailsSelector,
  type DrillItem,
  type MetricQuery,
  type MetricResult,
  type ParamSpecs,
} from "../../core";
import type { LiveKeyRange } from "@plugins/network/plugins/live/core";
import type { MetricImpl } from "./contribution";
import type { MetricRegistry } from "./registry";

// Evaluating a query and listing a bucket's records — the loaders of the
// served `metrics.query` / `metrics.details` values (`./served.ts`). Every
// error the asker can make — an unknown id, split or param, a bad range, a
// drill-down on a metric without one — is a `MetricQueryError` naming it;
// anything past validation that throws is a provider bug, rethrown as is.

/**
 * A question the registry cannot answer as asked (an unknown id, split or
 * param; a bad range). A `ResourceRefusal`: the reader is shown the message
 * (the read's `refused` error arm), and it is never reported as a server
 * failure.
 */
export class MetricQueryError extends ResourceRefusal {
  constructor(message: string) {
    super(message);
    this.name = "MetricQueryError";
  }
}

export async function runQuery(
  registry: MetricRegistry,
  query: MetricQuery,
  now: Date,
): Promise<MetricResult> {
  const entry = registry.lookup(query.metric);
  if (entry.kind === "unknown") {
    throw new MetricQueryError(`unknown metric "${query.metric}"`);
  }
  const params = parsedParams(entry.specs, query.params);
  try {
    if (entry.kind === "breakdown") {
      if ("split" in query) {
        throw new MetricQueryError(
          `breakdown "${query.metric}" cannot be split`,
        );
      }
      return await evaluateBreakdown(
        entry.impl.breakdown,
        { range: query.range, tz: query.tz, params },
        entry.impl.evaluate,
        now,
      );
    }
    const decl = entry.impl.metric;
    if ("split" in query) {
      if (!decl.splits.some((s) => s.id === query.split)) {
        throw new MetricQueryError(
          `metric "${decl.id}" has no split "${query.split}"`,
        );
      }
      return await evaluateMetric(
        decl,
        { range: query.range, tz: query.tz, params, split: query.split },
        entry.impl.evaluate,
        now,
      );
    }
    return await evaluateMetric(
      decl,
      { range: query.range, tz: query.tz, params, compare: query.compare },
      entry.impl.evaluate,
      now,
    );
  } catch (err) {
    if (err instanceof InvalidRangeError)
      throw new MetricQueryError(err.message);
    throw err;
  }
}

/** One key range of the records behind a bucket (or one series of it). */
export async function runDetails(
  registry: MetricRegistry,
  query: DetailsSelector,
  range: LiveKeyRange,
): Promise<readonly DrillItem[]> {
  const { impl, scope } = detailsScope(registry, query);
  if (impl.details === undefined) {
    throw new MetricQueryError(`metric "${impl.metric.id}" has no details`);
  }
  return impl.details({ ...scope, range });
}

/**
 * How many records a bucket (or one series of it) holds — `null` when its
 * metric lists them but does not count them (no `detailsTotal`).
 */
export async function runDetailsTotal(
  registry: MetricRegistry,
  query: DetailsSelector,
): Promise<number | null> {
  const { impl, scope } = detailsScope(registry, query);
  if (impl.details === undefined) {
    throw new MetricQueryError(`metric "${impl.metric.id}" has no details`);
  }
  return impl.detailsTotal === undefined ? null : impl.detailsTotal(scope);
}

/** The metric a drill-down asks about and its scope, validated as asked. */
function detailsScope(
  registry: MetricRegistry,
  query: DetailsSelector,
): {
  impl: MetricImpl;
  scope: {
    interval: DetailsSelector["interval"];
    split: DetailsSelector["split"];
    params: Record<string, unknown>;
  };
} {
  const entry = registry.lookup(query.metric);
  if (entry.kind !== "metric") {
    throw new MetricQueryError(`unknown metric "${query.metric}"`);
  }
  const decl = entry.impl.metric;
  const split = query.split;
  if (split !== null && !decl.splits.some((s) => s.id === split.id)) {
    throw new MetricQueryError(
      `metric "${decl.id}" has no split "${split.id}"`,
    );
  }
  if (Date.parse(query.interval.start) >= Date.parse(query.interval.end)) {
    throw new MetricQueryError("interval start must be before its end");
  }
  return {
    impl: entry.impl,
    scope: {
      interval: query.interval,
      split,
      params: parsedParams(entry.specs, query.params),
    },
  };
}

function parsedParams(
  specs: ParamSpecs,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = parseParams(specs, raw);
  if (!parsed.ok) throw new MetricQueryError(parsed.error);
  return parsed.values;
}
