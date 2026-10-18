import type { Aggregate } from "@plugins/infra/plugins/runtime-profiler/core";

// Pure window-delta math for the `queue-slot-blocked` detector, kept out of the
// watchdog so the arithmetic reads on its own. The watchdog owns the
// module-level baseline map and the report emission; this file owns only the
// numbers.
//
// WHY A DELTA AT ALL. The runtime profiler accumulates per-label totals
// cumulatively since boot (`count`, `totalMs`, `waitTotalMs`, `waits`), so
// reading them raw would answer "has this job EVER been blocked", and would keep
// answering yes forever after one bad hour. Diffing successive samples answers
// "was it blocked in the last 30 seconds", which is the question a watchdog
// asks. Same shape as `debug/op-rate`'s monitor, which diffs the same profile.

/**
 * Reset-safe window delta of a cumulative counter. Byte-for-byte the rule
 * `debug/op-rate` uses on the same profile:
 *
 * - first observation (`prev === undefined`) → `null`: seed the baseline and
 *   fire nothing, so a backend that has been up for a day does not report its
 *   entire history as one window;
 * - reset or regression (`current < prev` — the profile was reset, or this is a
 *   label whose aggregate was rebuilt) → the full current value;
 * - otherwise → `current - prev`.
 */
export function windowDelta(
  prev: number | undefined,
  current: number,
): number | null {
  if (prev === undefined) return null;
  return current >= prev ? current - prev : current;
}

/** The cumulative counters of one `job` aggregate, as of one sample. */
export interface JobSpanSample {
  count: number;
  totalMs: number;
  waitTotalMs: number;
  /** Σ per-record wait unions by admission-gate layer. */
  waits: Record<string, number>;
}

/** Snapshot the counters this detector diffs. Copies `waits` — the profiler
 *  hands back a fresh object per call today, but a baseline that aliased live
 *  recorder state would silently diff a value against itself. */
export function sampleOf(agg: Aggregate): JobSpanSample {
  return {
    count: agg.count,
    totalMs: agg.totalMs,
    waitTotalMs: agg.waitTotalMs,
    waits: { ...(agg.waits ?? {}) },
  };
}

/** One job's per-run averages over the window, once it has tripped. */
export interface BlockedTrip {
  runs: number;
  /** Per-run wall-clock hold of the worker slot. */
  holdMs: number;
  /** Per-run union of admission-gate waits charged inside that hold. */
  waitMs: number;
  /** `holdMs - waitMs` — the job's own time. */
  workMs: number;
  /** The single gate that contributed most of the wait, and its per-run ms. */
  layer: string;
  layerMs: number;
  /** Every contributing gate, per-run ms, largest first (includes `layer`). */
  layers: { layer: string; ms: number }[];
}

/**
 * Did this job hold its slots to WAIT rather than to work, over the window?
 *
 * Two conditions, both on per-run averages:
 *  1. the average run waited at least `floorMs` — a 200 ms handler that waits
 *     150 ms is 75% wait and completely uninteresting;
 *  2. more than half the average hold was that wait — the ratio is what makes
 *     the claim "it is holding a slot to wait", not "it is slow".
 *
 * Returns `null` when it did not trip, when the window contains no completed
 * runs (nothing to average), or when the wait cannot be attributed to any gate
 * — naming the gate IS the report, so an unattributed wait has nothing to say
 * that `queue-slot-hog` does not already say better.
 */
export function blockedTrip(
  prev: JobSpanSample,
  cur: JobSpanSample,
  floorMs: number,
): BlockedTrip | null {
  const runs = windowDelta(prev.count, cur.count);
  if (runs === null || runs <= 0) return null;

  const holdTotalMs = windowDelta(prev.totalMs, cur.totalMs) ?? 0;
  const waitTotalMs = windowDelta(prev.waitTotalMs, cur.waitTotalMs) ?? 0;

  const waitMs = waitTotalMs / runs;
  const holdMs = holdTotalMs / runs;
  if (waitMs < floorMs) return null;
  // Strictly more than half. Each record's wait is an interval UNION over its
  // own timeline, so `waitTotalMs <= holdTotalMs` always holds and this ratio is
  // in [0, 1] by construction — it can never be inflated by concurrent waiters.
  if (waitTotalMs * 2 <= holdTotalMs) return null;

  const layers: { layer: string; ms: number }[] = [];
  for (const layer of new Set([
    ...Object.keys(prev.waits),
    ...Object.keys(cur.waits),
  ])) {
    const ms = windowDelta(prev.waits[layer] ?? 0, cur.waits[layer] ?? 0) ?? 0;
    if (ms > 0) layers.push({ layer, ms: ms / runs });
  }
  layers.sort((a, b) => b.ms - a.ms);
  const top = layers[0];
  if (!top) return null;

  return {
    runs,
    holdMs,
    waitMs,
    workMs: Math.max(0, holdMs - waitMs),
    layer: top.layer,
    layerMs: top.ms,
    layers,
  };
}
