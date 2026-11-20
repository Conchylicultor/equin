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

/**
 * The last sleep as the clock itself places it — from when the machine went to
 * sleep to when it woke — or null when it cannot (never slept, unreadable, or
 * asleep again since the wake: then the pair bounds no one sleep). This is
 * what a process started AFTER a wake knows of the sleep before it: without
 * it, a backend booted on the wake judged everything that crossed the nap on
 * the wall clock (queue-health filed one post-wake backlog per such boot).
 */
export function lastSleepOf(r: SleepClockReading): SleepInterval | null {
  if (!r.supported || r.wakeAtMs === null || r.sleepAtMs === null) return null;
  if (r.sleepAtMs >= r.wakeAtMs) return null;
  return { startMs: r.sleepAtMs, endMs: r.wakeAtMs };
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

/**
 * The wall-clock instant from which the span up to `endMs` holds exactly
 * `awakeMs` of time the machine was AWAKE, given the sleeps placed so far:
 * walking back from `endMs`, every placed sleep is stepped over rather than
 * counted. With no sleep in reach it is `endMs - awakeMs`.
 *
 * A sleep placed later than it really happened (several naps read as one
 * stretch, see `sleepBetween`) only moves the answer earlier — it reads awake
 * time as sleep, never sleep as awake time.
 */
export function awakeSpanStartMs(
  sleeps: readonly SleepInterval[],
  endMs: number,
  awakeMs: number,
): number {
  let cursor = endMs;
  let need = awakeMs;
  // Latest-ending first; overlapping sleeps are stepped over together.
  for (const s of [...sleeps].sort((a, b) => b.endMs - a.endMs)) {
    if (s.startMs >= cursor) continue;
    const gap = cursor - Math.min(s.endMs, cursor);
    if (gap >= need) return cursor - need;
    need -= gap;
    cursor = s.startMs;
  }
  return cursor - need;
}

/**
 * The latest placed sleep that ENDED inside `[atMs - withinMs, atMs]` — the
 * wake `atMs` came just after — or null when none did.
 */
export function wakeWithin(
  sleeps: readonly SleepInterval[],
  atMs: number,
  withinMs: number,
): SleepInterval | null {
  let latest: SleepInterval | null = null;
  for (const s of sleeps) {
    if (s.endMs > atMs || s.endMs < atMs - withinMs) continue;
    if (latest === null || s.endMs > latest.endMs) latest = s;
  }
  return latest;
}

/** What {@link SleepPublisher.wakeBefore} answers. */
export type WakeBefore =
  /** The platform cannot tell — NOT "the machine did not wake". */
  | { supported: false }
  /** The sleep whose wake came in the window, or null when this process saw none. */
  | { supported: true; sleep: SleepInterval | null };

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
  /**
   * The wall-clock instant (epoch ms) `awakeMs` of AWAKE time before `endMs`,
   * stepping over the sleeps this process has seen — reading the clock first,
   * so a wake moments ago counts. `null` where the platform cannot tell.
   */
  awakeSpanStart(endMs: number, awakeMs: number): number | null;
  /**
   * The sleep this process saw end in the `withinMs` before `atMs` (epoch ms)
   * — "had the machine just woken?" — reading the clock first, so a wake
   * moments ago counts.
   */
  wakeBefore(atMs: number, withinMs: number): WakeBefore;
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
  const place = (s: SleepInterval | null): void => {
    if (s === null) return;
    sleeps.push(s);
    if (sleeps.length > SLEEP_RING_CAP) sleeps.shift();
  };
  // The first reading has no previous one to diff: the clock's own last sleep
  // is the one sleep it can place (the one this process started after).
  const first = (reading: SleepClockReading): SleepNow => {
    place(lastSleepOf(reading));
    last = { value: toSleepNow(reading) };
    return last.value;
  };
  const publish = (): void => {
    const reading = read();
    if (last === null) first(reading);
    else {
      const next = toSleepNow(reading);
      if (!sleepNowChanged(last.value, next)) return;
      place(sleepBetween(last.value, next));
      last = { value: next };
    }
    for (const fn of listeners) fn();
  };
  return {
    current() {
      return last === null ? first(read()) : last.value;
    },
    publish,
    sleptDuring(startMs, endMs) {
      publish();
      if (last?.value === null) return null;
      return overlapMs(sleeps, startMs, endMs);
    },
    awakeSpanStart(endMs, awakeMs) {
      publish();
      if (last?.value === null) return null;
      return awakeSpanStartMs(sleeps, endMs, awakeMs);
    },
    wakeBefore(atMs, withinMs) {
      publish();
      if (last?.value === null) return { supported: false };
      return { supported: true, sleep: wakeWithin(sleeps, atMs, withinMs) };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** The clock and timers {@link armAwakeTimeout} runs on (injected for tests). */
export interface TimerEnv {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Run `fn` once `awakeMs` of AWAKE time has passed: a timer that a sleep does
 * not spend. The platform timer counts sleep (a 10 min timer armed just before
 * a 15 min nap fires at the wake), so when it fires the span is re-measured
 * net of the sleeps `p` placed inside it, and re-armed for what is left.
 * Where the platform cannot tell, it is a plain wall-clock timer. Returns the
 * cancel.
 */
export function armAwakeTimeout(
  p: SleepPublisher,
  fn: () => void,
  awakeMs: number,
  env: TimerEnv,
): () => void {
  // A baseline reading, so a sleep inside the span is placed at the wake.
  p.publish();
  const startMs = env.now();
  let handle: unknown = null;
  const check = (): void => {
    const now = env.now();
    const slept = p.sleptDuring(startMs, now);
    const left = slept === null ? 0 : awakeMs - (now - startMs - slept);
    if (left > 0) handle = env.setTimeout(check, left);
    else {
      handle = null;
      fn();
    }
  };
  handle = env.setTimeout(check, awakeMs);
  return () => {
    if (handle !== null) env.clearTimeout(handle);
    handle = null;
  };
}
