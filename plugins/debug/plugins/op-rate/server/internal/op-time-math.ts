// Pure delta / rollup math for the op-time trip-wire, extracted from the monitor
// job so the reset-safety and rollup arithmetic are unit-tested in isolation
// (op-time-math.test.ts). The job owns the module-level baseline maps and the
// report emission; this file owns only the number-crunching.

// Reset-safe window delta of a cumulative counter (call count OR totalMs). The
// runtime profiler accumulates both cumulatively since boot; we diff successive
// ticks. Byte-for-byte the same rule the op-rate count diff uses:
//   • First observation (`prev === undefined`) → null: seed the baseline and
//     fire nothing, avoiding a false spike from the full since-boot value.
//   • Reset/regression (`current < prev` — profile was reset, or the label is
//     new this tick) → the full current value as the window delta.
//   • Otherwise → `current - prev`.
export function windowDelta(
  prev: number | undefined,
  current: number,
): number | null {
  if (prev === undefined) return null;
  return current >= prev ? current - prev : current;
}

// One label's ms delta over the window (input to the per-kind rollup).
export interface LabelDelta {
  label: string;
  deltaMs: number;
}

export interface RollupBreach {
  /** Σ per-op ms deltas across the kind's labels this window. */
  sumDeltaMs: number;
  /** The per-kind ms budget × rollupFactor the sum exceeded. */
  rollupBudgetMs: number;
  /** Top-10 contributing labels by ms delta desc. */
  topLabels: LabelDelta[];
}

// Per-kind rollup: catches cost smeared across many labels, each under its own
// per-op budget. Trips when the sum of the kind's per-op ms deltas exceeds
// `budgetMs × rollupFactor`. Returns the breach (with the top-10 contributing
// labels) or null when under budget. Pure — the caller supplies the deltas.
export function computeRollup(
  deltas: LabelDelta[],
  budgetMs: number,
  rollupFactor: number,
): RollupBreach | null {
  const sumDeltaMs = deltas.reduce((acc, d) => acc + d.deltaMs, 0);
  const rollupBudgetMs = budgetMs * rollupFactor;
  if (sumDeltaMs <= rollupBudgetMs) return null;
  const topLabels = [...deltas]
    .sort((a, b) => b.deltaMs - a.deltaMs)
    .slice(0, 10);
  return { sumDeltaMs, rollupBudgetMs, topLabels };
}

// One gate's cumulative wait meter, as the profiler reports it (`GateMeter`).
export interface GateReading {
  layer: string;
  count: number;
  totalMs: number;
}

// The previous tick's reading of every gate, by layer.
export type GateBaseline = Map<string, { count: number; totalMs: number }>;

export interface GateTrip {
  layer: string;
  /** ms waited on the gate this window, summed across waiters. */
  msDelta: number;
  /** Waits charged on the gate this window. */
  waitsDelta: number;
}

// The gates whose waiters waited more than `budgetMs` in total this window,
// diffing each reading against `baseline` (updated in place, so it holds this
// tick's readings for the next). Same rules as `windowDelta`: a gate seen for
// the first time seeds and trips nothing; a reset takes the whole reading.
export function gateTrips(
  readings: readonly GateReading[],
  baseline: GateBaseline,
  budgetMs: number,
): GateTrip[] {
  const trips: GateTrip[] = [];
  for (const g of readings) {
    const prev = baseline.get(g.layer);
    baseline.set(g.layer, { count: g.count, totalMs: g.totalMs });
    const msDelta = windowDelta(prev?.totalMs, g.totalMs);
    if (msDelta === null || msDelta <= budgetMs) continue;
    trips.push({
      layer: g.layer,
      msDelta,
      waitsDelta: windowDelta(prev?.count, g.count) ?? 0,
    });
  }
  return trips;
}
