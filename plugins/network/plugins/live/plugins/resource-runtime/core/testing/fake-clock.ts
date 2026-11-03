/**
 * A hand-advanced clock for the suites that exercise a timer window — a
 * throttle's `debounceMs`, the floor persist's `persistWindowMs` — or assert a
 * frame's timing. Bun's fake timers replace `setTimeout` / `setInterval`,
 * `performance.now()` and `Date.now()` (every clock the runtime reads), so time
 * moves only when the test says `advance`: a host that descheduled the test for
 * longer than a window between two steps cannot push an event across the
 * window's edge (the 2026-10-30 flakes of `runtime-throttle` and the floor
 * persist burst, which raced real windows of 30–60 ms against `tick()`s).
 *
 * Inside it `tick()` is one macrotask through `setImmediate`, which Bun does not
 * fake (its usual `setTimeout(0)` would never fire); time stands still across
 * it, so a timer fires only on `advance`.
 */

import { jest, onTestFinished } from "bun:test";
import { swapTick } from "../test-support";

export interface FakeClock {
  /**
   * Settle what is already queued (`tick()`) — at the current time, as it
   * would on a real host — then move the clock `ms` forward, firing every
   * timer now due, and `tick()` again.
   */
  advance(ms: number): Promise<void>;
}

const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Run the current test's `body` under the fake clock. Real timers come back
 * when the test finishes — a timed-out one included, so a hang never leaks
 * fake timers into the tests after it. Build the harness INSIDE `body`, so
 * every timer and timestamp the runtime takes is on the fake clock.
 */
export async function withFakeClock(
  body: (clock: FakeClock) => Promise<void>,
): Promise<void> {
  jest.useFakeTimers();
  const restoreTick = swapTick(turn);
  onTestFinished(() => {
    restoreTick();
    jest.useRealTimers();
  });
  await body({
    async advance(ms) {
      await turn();
      jest.advanceTimersByTime(ms);
      await turn();
    },
  });
}
