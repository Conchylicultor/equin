import type {
  BreakdownDecl,
  BreakdownOrder,
  Measure,
  MetricDecl,
} from "./define-metric";
import { resolveRange, type Interval, type RangeSpec } from "./intervals";
import {
  METRIC_MAX_BREAKDOWN_ROWS,
  METRIC_MAX_SERIES,
  type BreakdownResult,
  type BreakdownRow,
  type SeriesResult,
} from "./wire";

// Pure evaluation: the provider's `evaluate` is injected, so every rule here
// (what a total is, when a previous period exists, what a null means) is
// decided once, for every metric, and tested against a fake source.

/** What a provider evaluates: one value per interval, per split key. */
export interface EvaluateCtx<P> {
  intervals: readonly Interval[];
  /** A split id of the metric, or null for the unsplit total (exactly one row). */
  split: string | null;
  params: P;
}

export interface EvaluatedRow {
  key: string;
  label: string;
  /** One per interval, in order; null = not covered. */
  values: (number | null)[];
}

export type MetricEvaluate<P> = (
  ctx: EvaluateCtx<P>,
) => Promise<EvaluatedRow[]>;

export interface BreakdownCtx<P> {
  /** The whole range as one interval. */
  interval: Interval;
  params: P;
}

export type BreakdownEvaluate<P> = (
  ctx: BreakdownCtx<P>,
) => Promise<BreakdownRow[]>;

export type EngineQuery<P> = { range: RangeSpec; tz: string; params: P } & (
  { split: string } | { compare: boolean }
);

/**
 * Evaluate a metric over a range. ONE provider call covers every bucket, every
 * previous bucket, the range and the previous range; a split query makes a
 * second, unsplit call over the range alone for its total — a total is never a
 * sum of buckets, which would be wrong for distinct counts, medians and ratios.
 */
export async function evaluateMetric<P>(
  decl: MetricDecl,
  query: EngineQuery<P>,
  evaluate: MetricEvaluate<P>,
  now: Date,
): Promise<SeriesResult> {
  const split = "split" in query ? query.split : null;
  if (split !== null && !decl.splits.some((s) => s.id === split)) {
    throw new Error(`metric "${decl.id}" has no split "${split}"`);
  }
  const compare = "compare" in query && query.compare;
  const r = resolveRange(query.range, now, query.tz);
  const n = r.buckets.length;

  const intervals: Interval[] = compare
    ? [...r.buckets, ...r.previous, r.range, r.previousRange]
    : [...r.buckets, r.range];
  const rows = await evaluate({ intervals, split, params: query.params });
  checkRows(decl.id, rows, intervals.length, split);

  const rangeAt = compare ? 2 * n : n;
  const ranked = rows
    .map((row) => {
      const values = row.values.slice(0, n);
      return {
        key: row.key,
        label: row.label,
        values,
        total: tileValue(decl.measure, values, row.values[rangeAt]!),
      };
    })
    .sort(byTotalDesc);
  // The top series by total: a split with more keys is served truncated.
  const series = ranked.slice(0, METRIC_MAX_SERIES);

  let total: number | null;
  if (split === null) {
    total = series[0]!.total;
  } else {
    const whole = await evaluate({
      intervals: [r.range],
      split: null,
      params: query.params,
    });
    checkRows(decl.id, whole, 1, null);
    total = whole[0]!.values[0]!;
  }

  const result: SeriesResult = {
    kind: "series",
    buckets: r.buckets,
    series,
    truncated: ranked.length > series.length,
    total,
  };
  if (compare) {
    const row = rows[0]!;
    const values = row.values.slice(n, 2 * n);
    result.previous = {
      buckets: r.previous,
      values,
      total: tileValue(decl.measure, values, row.values[2 * n + 1]!),
      label: r.previousLabel,
    };
  }
  return result;
}

/** Evaluate a breakdown over the whole range, ordered as it declares. */
export async function evaluateBreakdown<P>(
  decl: BreakdownDecl,
  query: { range: RangeSpec; tz: string; params: P },
  evaluate: BreakdownEvaluate<P>,
  now: Date,
): Promise<BreakdownResult> {
  const r = resolveRange(query.range, now, query.tz);
  const rows = await evaluate({ interval: r.range, params: query.params });
  if (new Set(rows.map((row) => row.key)).size !== rows.length) {
    throw new Error(`breakdown "${decl.id}" returned a key twice`);
  }
  const ordered = [...rows].sort(breakdownOrder(decl.order));
  return {
    kind: "breakdown",
    rows: ordered.slice(0, METRIC_MAX_BREAKDOWN_ROWS),
    truncated: ordered.length > METRIC_MAX_BREAKDOWN_ROWS,
  };
}

/**
 * The single number a metric's tile shows: the range evaluated as one interval
 * (flow: its total; rate: its ratio / median), or, for a level, the value at
 * the range's end — the last bucket's.
 */
export function tileValue(
  measure: Measure,
  bucketValues: readonly (number | null)[],
  rangeValue: number | null,
): number | null {
  return measure === "level" ? (bucketValues.at(-1) ?? null) : rangeValue;
}

/** Running sum; null from the first uncovered bucket on (a sum over a gap is unknown). */
export function cumulative(
  values: readonly (number | null)[],
): (number | null)[] {
  let sum: number | null = 0;
  return values.map((v) => {
    sum = sum === null || v === null ? null : sum + v;
    return sum;
  });
}

export type Delta =
  { kind: "pct"; value: number } | { kind: "new" } | { kind: "none" };

/** `(cur − prev) / |prev|`; "new" from nothing; "none" when either side is not covered. */
export function delta(cur: number | null, prev: number | null): Delta {
  if (cur === null || prev === null) return { kind: "none" };
  if (prev === 0)
    return cur === 0 ? { kind: "pct", value: 0 } : { kind: "new" };
  return { kind: "pct", value: (cur - prev) / Math.abs(prev) };
}

export type DisplayChart = "area" | "line" | "stack" | "mirror" | "net";
export const DISPLAY_CHARTS = [
  "area",
  "line",
  "stack",
  "mirror",
  "net",
] as const;

export interface MetricDisplay {
  chart: DisplayChart;
  cumulative: boolean;
}

export type DisplayError =
  | { kind: "cumulative-needs-flow"; message: string }
  | { kind: "sum-across-splits-on-rate"; message: string };

/**
 * Why a display is illegal for a metric, or null when it is legal. A running
 * sum only means something for a flow; stacking or netting series adds them
 * across splits, which a rate cannot do.
 */
export function displayError(
  decl: Pick<MetricDecl, "id" | "measure">,
  display: MetricDisplay,
): DisplayError | null {
  if (display.cumulative && decl.measure !== "flow") {
    return {
      kind: "cumulative-needs-flow",
      message: `"${decl.id}" is a ${decl.measure}: only a flow can be shown cumulatively`,
    };
  }
  if (
    (display.chart === "stack" || display.chart === "net") &&
    decl.measure === "rate"
  ) {
    return {
      kind: "sum-across-splits-on-rate",
      message: `"${decl.id}" is a rate: its series cannot be added up as a ${display.chart} chart`,
    };
  }
  return null;
}

function checkRows(
  metricId: string,
  rows: readonly EvaluatedRow[],
  length: number,
  split: string | null,
): void {
  const where = `metric "${metricId}" (${split === null ? "unsplit" : `split "${split}"`})`;
  if (split === null && rows.length !== 1) {
    throw new Error(
      `${where} returned ${rows.length} rows; an unsplit evaluation returns exactly one`,
    );
  }
  if (new Set(rows.map((r) => r.key)).size !== rows.length) {
    throw new Error(`${where} returned a split key twice`);
  }
  for (const row of rows) {
    if (row.values.length !== length) {
      throw new Error(
        `${where} row "${row.key}" has ${row.values.length} values for ${length} intervals`,
      );
    }
    if (row.values.some((v) => v !== null && !Number.isFinite(v))) {
      throw new Error(`${where} row "${row.key}" has a non-finite value`);
    }
  }
}

function byTotalDesc(
  a: { key: string; total: number | null },
  b: { key: string; total: number | null },
): number {
  if (a.total !== b.total) {
    if (a.total === null) return 1;
    if (b.total === null) return -1;
    return b.total - a.total;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function breakdownOrder(
  order: BreakdownOrder,
): (a: BreakdownRow, b: BreakdownRow) => number {
  switch (order) {
    case "value-desc":
      return (a, b) => b.value - a.value;
    case "value-asc":
      return (a, b) => a.value - b.value;
    case "label":
      return (a, b) =>
        a.label.localeCompare(b.label, "en-US", { numeric: true });
  }
}
