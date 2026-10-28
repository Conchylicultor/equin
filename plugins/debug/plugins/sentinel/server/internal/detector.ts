import type { SignalKey } from "@plugins/debug/plugins/sentinel/plugins/status-file/core";
import type { ClusterSample } from "../../core";

// Pure onset state machine — dual-threshold, dual-dwell hysteresis. Fed one
// sample per sentinel tick; IO-free so trip/clear behavior is bun-testable.
//
// Trip when ANY signal is elevated for `onTicks` consecutive ticks; clear when
// ALL signals sit below the clear thresholds (trip thresholds × offRatio) for
// `offTicks` consecutive ticks. One trip event per episode.

export interface DetectorThresholds {
  onLocksWaiting: number;
  onBlkReadDeltaMs: number;
  onBackendP99Ms: number;
  onSlowBackends: number;
  onDecompressionsPerSec: number;
  onTicks: number;
  offRatio: number;
  offTicks: number;
}

/** Signal values at a tick, for the trip trace's detail payload. */
export interface SignalReadings {
  /** Context, never a trip signal: see `SignalKeySchema`. */
  loadRatio: number;
  locksWaiting: number;
  blkReadDeltaMs: number | null;
  slowBackends: number;
  /** Null when the host sampler's line was missing or stale this tick. */
  decompressionsPerSec: number | null;
}

export type DetectorEvent =
  | {
      kind: "trip";
      runUpMs: number;
      signals: SignalReadings;
      elevated: SignalKey[];
    }
  | { kind: "clear" }
  | null;

/**
 * One tick's readings, which signals sit at or above their trip limit
 * (`elevated`) and which are not calm yet (`holding`: at or above their clear
 * limit, `offRatio` of the trip limit) — the exact math the trip and clear
 * decisions use. A tripped detector clears once `holding` stays empty, so
 * `holding` is what keeps an episode going. Exported so the worker's vitals
 * file shows the same numbers the detector acted on.
 */
export function signalsAt(
  sample: ClusterSample,
  t: DetectorThresholds,
): {
  readings: SignalReadings;
  elevated: SignalKey[];
  holding: SignalKey[];
  allCalm: boolean;
} {
  const readings: SignalReadings = {
    loadRatio: sample.cpuCount > 0 ? sample.loadAvg1 / sample.cpuCount : 0,
    // A pg-unreadable tick reads 0 locks: neither elevated nor calm-blocking.
    locksWaiting: sample.pgLocksWaiting ?? 0,
    blkReadDeltaMs: sample.pgBlkReadDeltaMs,
    slowBackends: Object.values(sample.backendP99).filter(
      (p99) => p99 > t.onBackendP99Ms,
    ).length,
    // Missing/stale host line — the null-blk-read convention applies.
    decompressionsPerSec: sample.decompressionsPerSec ?? null,
  };
  // Each signal's reading against its trip limit; a null reading is neither
  // elevated nor calm-blocking.
  const against: [SignalKey, number | null, number][] = [
    ["locksWaiting", readings.locksWaiting, t.onLocksWaiting],
    ["blkReadDeltaMs", readings.blkReadDeltaMs, t.onBlkReadDeltaMs],
    ["slowBackends", readings.slowBackends, t.onSlowBackends],
    [
      "decompressionsPerSec",
      readings.decompressionsPerSec,
      t.onDecompressionsPerSec,
    ],
  ];
  const elevated: SignalKey[] = [];
  const holding: SignalKey[] = [];
  for (const [key, value, on] of against) {
    if (value === null) continue;
    if (value >= on) elevated.push(key);
    if (value >= on * t.offRatio) holding.push(key);
  }
  return { readings, elevated, holding, allCalm: holding.length === 0 };
}

export interface OnsetDetector {
  /** Feed one tick's sample; returns the transition event, if any. */
  feed(
    sample: ClusterSample,
    thresholds: DetectorThresholds,
    cadenceMs: number,
  ): DetectorEvent;
  readonly tripped: boolean;
}

/**
 * `seed.tripped` starts the machine mid-episode without a trip event — a
 * respawned sentinel worker adopting a fresh existing latch (it must keep
 * refreshing the lease it did not set, and eventually emit the clear).
 */
export function createOnsetDetector(seed?: {
  tripped?: boolean;
}): OnsetDetector {
  let elevatedTicks = 0;
  let calmTicks = 0;
  let tripped = seed?.tripped ?? false;

  return {
    get tripped() {
      return tripped;
    },
    feed(sample, thresholds, cadenceMs): DetectorEvent {
      const { readings, elevated, allCalm } = signalsAt(sample, thresholds);

      if (!tripped) {
        elevatedTicks = elevated.length > 0 ? elevatedTicks + 1 : 0;
        if (elevatedTicks >= thresholds.onTicks) {
          tripped = true;
          calmTicks = 0;
          return {
            kind: "trip",
            runUpMs: elevatedTicks * cadenceMs,
            signals: readings,
            elevated,
          };
        }
        return null;
      }

      calmTicks = allCalm ? calmTicks + 1 : 0;
      if (calmTicks >= thresholds.offTicks) {
        tripped = false;
        elevatedTicks = 0;
        return { kind: "clear" };
      }
      return null;
    },
  };
}
