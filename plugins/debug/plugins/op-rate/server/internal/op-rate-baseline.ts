// op-rate judges an op's calls in a window against the op's OWN history, never
// against one fixed bar per span kind. A fixed bar fired on normal load that is
// merely high in absolute terms (a watched agent streaming its reply pushes
// `conversations.partial-message` ~760 times per window, every window it
// streams) and could not see a runaway that is small in absolute terms but far
// above what that op normally does.
//
// The history is each op's distribution of calls per window, kept per UTC day
// as a histogram (tables.ts) in two regimes, because a backend's first window
// is a different kind of window: every tab replays its subscriptions and the
// boot catch-up runs, so on main (which restarts many times a day) a boot-window
// peak would otherwise become the bar every steady window is judged against.
//
// Pure: the job owns the module state and the DB; this file owns the numbers.

import type { OpRateRegime } from "../../core";

/** The monitor's window: its cron interval. */
export const WINDOW_MS = 5 * 60_000;

/** How many past days the baseline reads (today excluded — see usualCallsOf). */
export const BASELINE_DAYS = 7;

/**
 * The quantile of an op's past windows taken as its usual count. Steady: the
 * 99th percentile — an op is "usually" at most this busy in all but ~20 of the
 * week's ~2,000 windows, so a recurring burst (an agent streaming, the hourly
 * jobs) is usual and a loop that is new this day is not. Boot: the 90th of the
 * week's boot windows (main boots dozens of times a day; a worktree a few).
 */
export const BASELINE_QUANTILE: Record<OpRateRegime, number> = {
  steady: 0.99,
  boot: 0.9,
};

/**
 * Past windows of a regime needed before the baseline is trusted: a full day of
 * steady windows; ten boots. Fewer, and the regime is warming up: steady
 * windows are judged on the per-kind warm-up thresholds, boot windows are not
 * judged (as before baselines existed: the first window after boot only
 * seeded).
 */
export const MIN_HISTORY_WINDOWS: Record<OpRateRegime, number> = {
  steady: (24 * 60 * 60_000) / WINDOW_MS,
  boot: 10,
};

/**
 * Upper bound (inclusive) of each call-count bucket: exact up to 16, then a
 * quarter-octave apart (2^¼ ≈ 1.19×, rounded up: at most 25 % above the last
 * bound at the low end). A window with `n ≥ 1` calls lands in the first bucket
 * whose bound is ≥ n. A quantile reads as its bucket's upper bound, so a usual
 * count is at most that much high — the judgement errs toward not firing,
 * never toward firing on noise.
 */
export const BUCKET_UPPER: readonly number[] = (() => {
  const bounds: number[] = [];
  for (let n = 1; n <= 16; n++) bounds.push(n);
  let n = 16;
  while (n < 2 ** 31 - 1) {
    n = Math.min(Math.ceil(n * 2 ** 0.25), 2 ** 31 - 1);
    bounds.push(n);
  }
  return bounds;
})();

/** A bucket's upper bound; throws on an index outside the scheme. */
export function bucketUpper(bucket: number): number {
  const bound = BUCKET_UPPER[bucket];
  if (bound === undefined)
    throw new Error(`op-rate: bucket ${bucket} is outside the bucket scheme`);
  return bound;
}

/** The bucket a window of `calls ≥ 1` calls lands in. */
export function bucketOf(calls: number): number {
  if (!Number.isInteger(calls) || calls < 1)
    throw new Error(`bucketOf: ${calls} is not a positive call count`);
  let lo = 0;
  let hi = BUCKET_UPPER.length - 1;
  if (calls > bucketUpper(hi)) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bucketUpper(mid) >= calls) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** One op's past windows of one regime. */
export interface OpHistory {
  /** Every window of the regime the monitor judged (the op called or not). */
  windows: number;
  /** Windows in which the op was called, by bucket. */
  buckets: ReadonlyMap<number, number>;
}

/**
 * The op's usual calls per window: the `quantile` of its past windows, those it
 * was not called in counted as 0. Throws when the history counts more called
 * windows than windows — the two are written in one transaction, so that is a
 * broken store, not a number to judge on.
 */
export function usualCallsOf(history: OpHistory, quantile: number): number {
  let called = 0;
  for (const n of history.buckets.values()) called += n;
  if (called > history.windows)
    throw new Error(
      `op-rate history counts ${called} called windows out of ${history.windows}`,
    );
  const rank = Math.max(1, Math.ceil(quantile * history.windows));
  let seen = history.windows - called;
  if (seen >= rank) return 0;
  for (const bucket of [...history.buckets.keys()].sort((a, b) => a - b)) {
    seen += history.buckets.get(bucket) ?? 0;
    if (seen >= rank) return bucketUpper(bucket);
  }
  throw new Error("unreachable: the ranks sum to the window count");
}

export interface OpRateRule {
  /** Never fire below this many calls in a window. */
  minCalls: number;
  /** Fire past this many times the usual count. */
  factor: number;
}

/** What a window's call count is judged against. */
export type OpRateBasis =
  | { kind: "baseline"; usualCalls: number }
  | { kind: "warm-up"; threshold: number };

/** The bar a window's calls must exceed to be reported. */
export function thresholdOf(basis: OpRateBasis, rule: OpRateRule): number {
  if (basis.kind === "warm-up") return basis.threshold;
  return Math.max(rule.minCalls, Math.ceil(rule.factor * basis.usualCalls));
}

/**
 * Calls in a window, per standard window: a window the cron stretched past
 * WINDOW_MS (the queue ran the job late) is scaled down to it; a shorter one (a
 * boot window: process start → first tick) is not scaled up — a burst does not
 * spread over the time the process did not exist.
 */
export function callsPerWindow(delta: number, windowMs: number): number {
  return windowMs > WINDOW_MS
    ? Math.round((delta * WINDOW_MS) / windowMs)
    : delta;
}

/**
 * A window is a `boot` window while it starts less than this long after the
 * process did. The boot burst (tabs reconnecting and replaying their
 * subscriptions, the catch-up) lands in the seconds after the backend is
 * ready; a process that started just before a tick has its burst in the
 * NEXT window, which must not be judged — or recorded — as steady.
 */
export const BOOT_SETTLE_MS = 3 * 60_000;

/** The previous tick of this process: the profile it read and when. */
export interface TickState {
  /** The profile's start (`getRuntimeProfile().sinceMs`, profiler clock). */
  epoch: number;
  /** When the tick read it (profiler clock). */
  atMs: number;
}

/** What this tick's counts mean. */
export type TickPlan =
  | {
      kind: "window";
      regime: OpRateRegime;
      windowMs: number;
      /** Every count started at 0 in this window (a fresh or reset profile). */
      fromZero: boolean;
    }
  | { kind: "unjudgeable"; reason: string };

/**
 * Which window this tick closes. The profile's counts are cumulative since its
 * epoch (process start, or a `resetRuntimeProfile()`):
 * - same epoch as the last tick → the window since that tick: `boot` while it
 *   started within BOOT_SETTLE_MS of the process start (`processStartMs`),
 *   else `steady`;
 * - this process's first tick → the boot window, process start → now, every
 *   count from 0 (a boot burst is judged, not swallowed as the seed);
 * - a reset since the last tick (boot-bench's `resetRuntimeProfile()` before a
 *   synthetic burst) → a part-window of benchmark load: not judged, only
 *   seeded;
 * - a first tick more than two windows after the start (the queue held the
 *   job) → the counts span an unknown stretch: not judged, only seeded.
 */
export function planTick(
  prev: TickState | undefined,
  epoch: number,
  nowMs: number,
  processStartMs: number,
): TickPlan {
  if (prev !== undefined && prev.epoch === epoch)
    return {
      kind: "window",
      regime: prev.atMs - processStartMs < BOOT_SETTLE_MS ? "boot" : "steady",
      windowMs: nowMs - prev.atMs,
      fromZero: false,
    };
  if (prev !== undefined)
    return { kind: "unjudgeable", reason: "the profile was reset mid-window" };
  const sinceEpoch = nowMs - epoch;
  if (sinceEpoch > 2 * WINDOW_MS)
    return {
      kind: "unjudgeable",
      reason: `first tick ${Math.round(sinceEpoch / 1000)}s after the profile started`,
    };
  return {
    kind: "window",
    regime: "boot",
    windowMs: sinceEpoch,
    fromZero: true,
  };
}

// --- The hour horizon ---
//
// A window is judged against the op's usual WINDOW, which on a bursty op (one
// whose busiest 1 % of windows are 15× its median) leaves room for a loop that
// doubles its traffic for hours. Its hours are far smoother, so each tick also
// judges the op's calls in the clock hour so far against its usual HOUR. The
// hour so far only grows, so judging it against whole past hours never fires
// early. Its history lives in the DB, not the process: main restarts several
// times an hour.

export const HOUR_MS = 60 * 60_000;

/**
 * The quantile of an op's past hours taken as its usual hour: the 95th — at
 * most this busy in all but ~8 of the week's 168 hours.
 */
export const HOUR_QUANTILE = 0.95;

/** Past hours needed before the hour baseline is trusted: a day. */
export const MIN_COVERED_HOURS = 24;

/**
 * A past hour is a sample only when the monitor judged at least this many of
 * its 12 windows: an hour the backend was mostly down would read as quiet.
 */
export const MIN_WINDOWS_PER_HOUR = 10;

/**
 * The op's usual calls per hour: the `quantile` of `hourCalls` — one entry per
 * covered past hour, 0 for an hour the op was not called in.
 */
export function usualHourCallsOf(
  hourCalls: readonly number[],
  quantile: number,
): number {
  if (hourCalls.length === 0)
    throw new Error("op-rate: an hour baseline needs at least one past hour");
  const sorted = [...hourCalls].sort((a, b) => a - b);
  const at = sorted[Math.max(1, Math.ceil(quantile * sorted.length)) - 1];
  if (at === undefined) throw new Error("unreachable: rank within the hours");
  return at;
}

/** The hour bar: the window rule scaled to an hour's twelve windows. */
export function hourThresholdOf(usualCalls: number, rule: OpRateRule): number {
  return thresholdOf(
    { kind: "baseline", usualCalls },
    { ...rule, minCalls: rule.minCalls * (HOUR_MS / WINDOW_MS) },
  );
}

/** The UTC hour an instant falls in. */
export function utcHourStart(epochMs: number): Date {
  return new Date(Math.floor(epochMs / HOUR_MS) * HOUR_MS);
}

/** The UTC day an instant falls in. */
export function utcDayStart(epochMs: number): Date {
  const d = new Date(epochMs);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}
