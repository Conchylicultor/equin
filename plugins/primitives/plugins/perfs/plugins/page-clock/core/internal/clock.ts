// The two clocks of a page or worker, kept apart by type.
//
// - EpochMs: the wall clock (`Date.now()`, ms since the Unix epoch). It keeps
//   running while the device sleeps, and is the one time base every thread and
//   process agrees on.
// - PerfMs: the performance timeline (`performance.now()`, an entry's
//   `startTime`, an event's `timeStamp`, a JS Self-Profiling sample's
//   `timestamp`): ms since this realm's `timeOrigin`, on a clock that PAUSES
//   while the device sleeps — CLOCK_MONOTONIC in Chrome on Android,
//   mach_absolute_time on macOS.
//
// So `performance.timeOrigin + stamp` is not the wall clock: after a sleep it
// lags `Date.now()` by every sleep since the realm started (report-1795091821
// -xwqzky: an Android tab after ~2.2 h asleep had its profiler samples placed
// hours before the stall they sampled). The offset between the two clocks is
// read at once instead (`clockOffset()`), and it is exact for every stamp
// taken since the device last woke; a stamp from before that lands no later
// than the wake — never inside a span that began after it.

declare const epochBrand: unique symbol;
declare const perfBrand: unique symbol;
declare const offsetBrand: unique symbol;

/** A wall-clock instant: ms since the Unix epoch (`Date.now()`). */
export type EpochMs = number & { readonly [epochBrand]: true };
/**
 * A performance-timeline instant: ms since this realm's `timeOrigin`, on a
 * clock that pauses while the device sleeps.
 */
export type PerfMs = number & { readonly [perfBrand]: true };
/**
 * `Date.now() − performance.now()` read in one go: what a PerfMs stamp taken
 * since the device last woke adds to become an EpochMs. It grows by each
 * sleep, so it is read when the stamps are taken (or just after), never once
 * at load.
 */
export type ClockOffset = number & { readonly [offsetBrand]: true };

/** Now, on the wall clock. */
export const epochNow = (): EpochMs => Date.now() as EpochMs;

/** Now, on the performance timeline. */
export const perfNow = (): PerfMs => performance.now() as PerfMs;

/**
 * Names a number some API handed over as a performance-timeline stamp
 * (`entry.startTime`, `event.timeStamp`, a profiler sample's `timestamp`).
 */
export const asPerfMs = (t: number): PerfMs => t as PerfMs;

/**
 * Names a number read back from storage or a message as a wall-clock instant
 * (a decoded payload's `startedAt`): the clock it was written on.
 */
export const asEpochMs = (t: number): EpochMs => t as EpochMs;

/** The clocks' offset from one instant read on both of them. */
export const offsetOf = (epoch: EpochMs, perf: PerfMs): ClockOffset =>
  (epoch - perf) as ClockOffset;

/** The clocks' offset, now. */
export const clockOffset = (): ClockOffset => offsetOf(epochNow(), perfNow());

/**
 * A performance-timeline stamp on the wall clock, through `offset` (default:
 * read now). Pass the offset read when the stamps were collected — a trace's
 * stop, an entry's delivery — when converting later.
 */
export function perfToEpoch(
  t: PerfMs,
  offset: ClockOffset = clockOffset(),
): EpochMs {
  return (t + offset) as EpochMs;
}

/** A wall-clock instant on the performance timeline (the inverse of perfToEpoch). */
export function epochToPerf(
  t: EpochMs,
  offset: ClockOffset = clockOffset(),
): PerfMs {
  return (t - offset) as PerfMs;
}

/** Both clocks read at one instant: where the timeline stood, and the offset then. */
export interface ClockReading {
  perf: PerfMs;
  offset: ClockOffset;
}

/** Both clocks, now. */
export function readClocks(): ClockReading {
  const perf = perfNow();
  return { perf, offset: offsetOf(epochNow(), perf) };
}

/**
 * A stamp from a long-running record (a profiler trace) on the wall clock,
 * through the first of `readings` (in timeline order, taken along the record)
 * at or after it — exact unless the device slept between the stamp and that
 * reading, so readings taken every second bound the error to the second a
 * sleep began in. A stamp after the last reading takes the last one.
 */
export function perfToEpochAlong(
  t: PerfMs,
  readings: readonly ClockReading[],
): EpochMs {
  const next = readings.find((r) => r.perf >= t) ?? readings.at(-1);
  if (!next)
    throw new Error("perfToEpochAlong: no clock reading to place the stamp by");
  return perfToEpoch(t, next.offset);
}
