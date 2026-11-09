// The staged batch's timeline (`ArrivalStep`): when each step's content enters,
// and how long the batch's room takes to open. The entry itself (its duration,
// curve and rise) is CSS (`arrival.css`).
//
// A step every 150 ms, so the batch reads as a top-to-bottom cascade rather
// than one pop; a long batch compresses its gaps to keep the whole cascade
// within `MAX_SPAN_MS`. The room opens on one curve for every row (one rigid
// push), and lasts until well after the last step has started — content never
// enters into a slot that has visibly finished opening.

/** The first step starts this far into the room's opening. */
export const FIRST_STEP_MS = 150;
/** Between two steps, unless the batch is too long to keep it. */
export const STEP_GAP_MS = 150;
/** The last step starts at most this long after the first. */
export const MAX_SPAN_MS = 900;
/** The room is still opening this long after the last step starts. */
export const OPEN_TAIL_MS = 375;
/** The shortest opening (a batch of one or two steps). */
export const MIN_OPEN_MS = 600;

function gapMs(steps: number): number {
  return steps <= 1 ? 0 : Math.min(STEP_GAP_MS, MAX_SPAN_MS / (steps - 1));
}

/** When step `step` of a `steps`-step batch enters, from the opening's start. */
export function arrivalDelayMs(step: number, steps: number): number {
  return Math.round(FIRST_STEP_MS + step * gapMs(steps));
}

/** How long a `steps`-step batch's room takes to open. */
export function arrivalOpenMs(steps: number): number {
  const lastStart = FIRST_STEP_MS + Math.max(0, steps - 1) * gapMs(steps);
  return Math.round(Math.max(MIN_OPEN_MS, lastStart + OPEN_TAIL_MS));
}
