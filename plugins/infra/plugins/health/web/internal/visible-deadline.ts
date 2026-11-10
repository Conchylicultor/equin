/**
 * Elapsed time that counts only while the page is VISIBLE, for signals that
 * measure how long something has been wrong. A hidden page may be frozen — on
 * a phone, always, once the screen locks or another app comes up: its timers
 * pause and its sockets are dropped by the OS, so a wait that spans it is the
 * suspension's, not the thing being measured. Hidden is not frozen, though (a
 * desktop tab behind another is only throttled), so a signal is never excused
 * by a hide alone: only the hidden time itself is taken out of its window.
 *
 * - `visibleMsSince(start)`: how much of `[start, now]` the page was visible.
 * - `arm(key, ms, onElapsed)`: call `onElapsed` once the page has been visible
 *   for `ms` in total since arming. A timer that fires while hidden parks until
 *   the page is visible again. Re-arming a key that is already armed (or
 *   parked) does nothing.
 * - `onHidden()` / `onVisible()`: the page's `visibilitychange`s. A hidden
 *   period lasts from the hide until the visible event — or until now while
 *   that event has not landed: on resume a frozen page may run its overdue
 *   timers first, and they must still see the freeze.
 *
 * Hidden periods are kept in a short ring (`MAX_HIDDEN_PERIODS`): dropping the
 * oldest can only make a window look MORE visible, so an overflow errs towards
 * reporting, never towards excusing.
 */
export interface VisibleDeadlines {
  visibleMsSince(start: number): number;
  arm(key: string, ms: number, onElapsed: () => void): void;
  clear(key: string): void;
  clearAll(): void;
  onHidden(): void;
  onVisible(): void;
}

export interface VisibleDeadlineEnv {
  now(): number;
  isHidden(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const MAX_HIDDEN_PERIODS = 64;

interface Armed {
  ms: number;
  from: number;
  onElapsed: () => void;
  handle: unknown; // null = parked (fired while hidden)
}

export function createVisibleDeadlines(
  env: VisibleDeadlineEnv,
): VisibleDeadlines {
  // Closed hidden periods, oldest first, plus the open one (since the last
  // hide, until the visible event).
  const periods: Array<{ start: number; end: number }> = [];
  let hiddenSince: number | null = env.isHidden() ? env.now() : null;
  const armed = new Map<string, Armed>();

  const visibleMsSince = (start: number): number => {
    const now = env.now();
    let hidden = 0;
    const overlap = (a: number, b: number) => {
      hidden += Math.max(0, Math.min(b, now) - Math.max(a, start));
    };
    for (const p of periods) overlap(p.start, p.end);
    if (hiddenSince !== null) overlap(hiddenSince, now);
    return Math.max(0, now - start - hidden);
  };

  const schedule = (key: string, entry: Armed) => {
    entry.handle = env.setTimeout(
      () => {
        if (env.isHidden()) {
          entry.handle = null; // parked until visible
          return;
        }
        if (visibleMsSince(entry.from) < entry.ms) {
          schedule(key, entry);
          return;
        }
        armed.delete(key);
        entry.onElapsed();
      },
      Math.max(0, entry.ms - visibleMsSince(entry.from)),
    );
  };

  const clear = (key: string) => {
    const entry = armed.get(key);
    if (!entry) return;
    if (entry.handle !== null) env.clearTimeout(entry.handle);
    armed.delete(key);
  };

  return {
    visibleMsSince,
    arm(key, ms, onElapsed) {
      if (armed.has(key)) return;
      const entry: Armed = { ms, from: env.now(), onElapsed, handle: null };
      armed.set(key, entry);
      schedule(key, entry);
    },
    clear,
    clearAll() {
      for (const key of [...armed.keys()]) clear(key);
    },
    onHidden() {
      hiddenSince ??= env.now();
    },
    onVisible() {
      if (hiddenSince !== null) {
        periods.push({ start: hiddenSince, end: env.now() });
        if (periods.length > MAX_HIDDEN_PERIODS) periods.shift();
        hiddenSince = null;
      }
      for (const [key, entry] of armed) {
        if (entry.handle !== null) continue;
        schedule(key, entry);
      }
    },
  };
}
