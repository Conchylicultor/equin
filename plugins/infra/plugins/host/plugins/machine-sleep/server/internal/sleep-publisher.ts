import type { SleepClockReading } from "@plugins/packages/plugins/sleep-clock/core";
import type { SleepNow } from "../../core";

/**
 * Reading the two clocks a few hundred nanoseconds apart jitters `asleepMs` by a
 * hair on every read; only a sleep moves it by a whole millisecond or more.
 */
const ASLEEP_EPSILON_MS = 1;

export function toSleepNow(r: SleepClockReading): SleepNow {
  return r.supported
    ? { boot: r.boot, asleepMs: r.asleepMs, wakeAtMs: r.wakeAtMs }
    : null;
}

/** Whether `next` says something `prev` did not: a new boot, a new wake, or more sleep. */
export function sleepNowChanged(prev: SleepNow, next: SleepNow): boolean {
  if (prev === null || next === null) return prev !== next;
  return (
    prev.boot !== next.boot ||
    prev.wakeAtMs !== next.wakeAtMs ||
    Math.abs(next.asleepMs - prev.asleepMs) >= ASLEEP_EPSILON_MS
  );
}

/** One sleep placed on the wall clock (epoch ms). */
export interface SleepInterval {
  startMs: number;
  endMs: number;
}

/** How many placed sleeps are kept: a caller asks about spans that just ended. */
const SLEEP_RING_CAP = 50;

/**
 * The sleep `next` adds over `prev`, placed on the wall clock — or null when
 * none, or when it cannot be placed. The clock knows only how much more the box
 * slept and when it last woke, so all of it is placed as ONE sleep ending at
 * that wake: several naps between two readings (dark-wake cycles) read as one
 * stretch ending at the last wake — never more sleep than there was, though
 * possibly later than it happened. A new boot, or no wake time, places nothing.
 */
export function sleepBetween(
  prev: SleepNow,
  next: SleepNow,
): SleepInterval | null {
  if (prev === null || next === null || prev.boot !== next.boot) return null;
  const slept = next.asleepMs - prev.asleepMs;
  if (slept < ASLEEP_EPSILON_MS || next.wakeAtMs === null) return null;
  return { startMs: next.wakeAtMs - slept, endMs: next.wakeAtMs };
}

/** ms of `[startMs, endMs]` covered by the union of `sleeps`. */
export function overlapMs(
  sleeps: readonly SleepInterval[],
  startMs: number,
  endMs: number,
): number {
  let total = 0;
  let frontier = startMs;
  for (const s of [...sleeps].sort((a, b) => a.startMs - b.startMs)) {
    const from = Math.max(s.startMs, frontier);
    const to = Math.min(s.endMs, endMs);
    if (to > from) {
      total += to - from;
      frontier = to;
    }
  }
  return total;
}

export interface SleepPublisher {
  /** The last published reading, reading the clock first if nothing was yet. */
  current(): SleepNow;
  /** Read the clock; tell every listener only when it changed. */
  publish(): void;
  /**
   * ms the machine slept inside `[startMs, endMs]` (epoch ms), from the sleeps
   * this process has seen — reading the clock first, so a wake moments ago
   * counts. `null` where the platform cannot tell (never "did not sleep").
   */
  sleptDuring(startMs: number, endMs: number): number | null;
  /** Run `fn` on every changed reading `publish` finds. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
}

/** The set-if-changed core of the publisher, with the clock injected. */
export function createSleepPublisher(
  read: () => SleepClockReading,
): SleepPublisher {
  let last: { value: SleepNow } | null = null;
  const listeners = new Set<() => void>();
  const sleeps: SleepInterval[] = [];
  const publish = (): void => {
    const next = toSleepNow(read());
    if (last !== null && !sleepNowChanged(last.value, next)) return;
    const placed = last === null ? null : sleepBetween(last.value, next);
    if (placed !== null) {
      sleeps.push(placed);
      if (sleeps.length > SLEEP_RING_CAP) sleeps.shift();
    }
    last = { value: next };
    for (const fn of listeners) fn();
  };
  return {
    current() {
      last ??= { value: toSleepNow(read()) };
      return last.value;
    },
    publish,
    sleptDuring(startMs, endMs) {
      publish();
      if (last?.value === null) return null;
      return overlapMs(sleeps, startMs, endMs);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
