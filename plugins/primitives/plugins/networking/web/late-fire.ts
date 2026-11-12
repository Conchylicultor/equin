/**
 * How late a timer may fire and still prove the page ran meanwhile. A hidden
 * tab's timers are aligned to whole seconds (Chrome's basic throttling); past
 * this, the page (or the worker) could not run between the timer's due time
 * and now — frozen (a phone locking its screen, a laptop asleep, a discarded
 * tab coming back) or its thread stalled (reported on its own).
 */
export const LATE_FIRE_SLACK_MS = 1_500;

/**
 * Whether a timer due at `dueAt` fired so late (at `now`) that a wait measured
 * across it is no evidence: an answer may be sitting unprocessed in the
 * page's queue, behind this very callback. A deadline that fires late re-arms
 * a fresh window from now instead of declaring its fault — it neither claims
 * a fault it cannot establish nor asks anyone to mute it. Throttling within
 * the slack (and every real hang, which outlasts a fresh window of running
 * time) still reports.
 */
export function firedLate(dueAt: number, now: number): boolean {
  return now - dueAt > LATE_FIRE_SLACK_MS;
}
