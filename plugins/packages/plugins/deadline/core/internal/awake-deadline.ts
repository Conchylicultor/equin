/**
 * A clock that pauses while the machine sleeps, in ms. `performance.now()`
 * is one on every host this code runs on — Bun and the browser read
 * mach_absolute_time on macOS, CLOCK_MONOTONIC on Linux — while a timer
 * (`setTimeout`) keeps counting through sleep: on wake, every timer whose
 * time passed during the nap fires at once.
 *
 * Measured: on 2026-11-20 a backend's boot journal (performance.now) showed
 * a load wave of 1068 ms inside a 934 s maintenance sleep on the wall clock.
 */
export type AwakeClock = () => number;

export const awakeClock: AwakeClock = () => performance.now();

/** The longest delay a timer takes as asked: past it, `setTimeout` fires in 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface AwakeDeadlineOptions {
  /** A reading of `clock` the budget runs from (default: now). */
  startedAt?: number;
  /** The awake clock (injected for tests). */
  clock?: AwakeClock;
}

/**
 * Call `onExpire` once `budgetMs` of AWAKE time has passed — a deadline a
 * sleep does not spend. The timer is only a wake-up call: when it fires, the
 * awake clock says how much of the budget was really spent, and it re-arms
 * for the rest. So a 30 min bound armed in one dark wake no longer fires in
 * the next one 33 wall-clock minutes later, after the work had run for 11 s
 * (2026-11-07), and a DB call issued just before a nap is not declared "no
 * reply" the instant the machine wakes (2026-11-03).
 *
 * The one awake timer: every watchdog, deadline and lease timer on work THIS
 * machine runs counts awake time through it. Returns the cancel; cancelling
 * after expiry is a no-op.
 */
export function armAwakeDeadline(
  budgetMs: number,
  onExpire: () => void,
  opts: AwakeDeadlineOptions = {},
): () => void {
  const clock = opts.clock ?? awakeClock;
  const startedAt = opts.startedAt ?? clock();
  let timer: ReturnType<typeof setTimeout>;
  const left = (): number => budgetMs - (clock() - startedAt);
  const check = (): void => {
    const ms = left();
    // Under a millisecond left is the timer's own granularity, not sleep.
    if (ms >= 1) timer = setTimeout(check, Math.min(ms, MAX_TIMER_MS));
    else onExpire();
  };
  timer = setTimeout(check, Math.min(Math.max(0, left()), MAX_TIMER_MS));
  return () => clearTimeout(timer);
}
