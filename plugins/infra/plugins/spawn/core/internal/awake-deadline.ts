import {
  type AwakeClockReading,
  readAwakeClock,
} from "@plugins/packages/plugins/sleep-clock/core";

/**
 * A one-shot deadline that counts only the time the machine was AWAKE.
 *
 * A plain `setTimeout` counts sleep too (Bun's timers run on a clock that keeps
 * going while the machine sleeps). On 2026-11-07 a laptop on battery in deep
 * idle woke for 2–5 s every ~16 min; a 30-minute `rm -rf` deadline armed in one
 * dark wake fired in another 33 wall-clock minutes later — after the child had
 * run for ~11 s — and the delete was reported as "did not finish in 30 min".
 * A deadline is a wedge-breaker for work THIS machine runs, so it must measure
 * what that work was given: awake time.
 *
 * So the timer is only a wake-up call: when it fires, the awake clock says how
 * much of the budget was really spent, and the timer is re-armed for the rest.
 * Where the platform has no awake clock, it is the plain timer.
 *
 * Returns the cancel.
 */
export function armAwakeDeadline(
  budgetMs: number,
  onExpire: () => void,
  readAwake: () => AwakeClockReading = readAwakeClock,
): () => void {
  const start = readAwake();
  let timer: ReturnType<typeof setTimeout>;
  const arm = (ms: number) => {
    timer = setTimeout(() => {
      const now = start.supported ? readAwake() : start;
      if (start.supported && now.supported) {
        const left = budgetMs - (now.awakeMs - start.awakeMs);
        // Under a millisecond left is the timer's own granularity, not sleep.
        if (left >= 1) {
          arm(left);
          return;
        }
      }
      onExpire();
    }, ms);
  };
  arm(budgetMs);
  return () => clearTimeout(timer);
}
