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

export interface SleepPublisher {
  /** The last published reading, reading the clock first if nothing was yet. */
  current(): SleepNow;
  /** Read the clock; tell every listener only when it changed. */
  publish(): void;
  /** Run `fn` on every changed reading `publish` finds. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
}

/** The set-if-changed core of the publisher, with the clock injected. */
export function createSleepPublisher(
  read: () => SleepClockReading,
): SleepPublisher {
  let last: { value: SleepNow } | null = null;
  const listeners = new Set<() => void>();
  return {
    current() {
      last ??= { value: toSleepNow(read()) };
      return last.value;
    },
    publish() {
      const next = toSleepNow(read());
      if (last !== null && !sleepNowChanged(last.value, next)) return;
      last = { value: next };
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
