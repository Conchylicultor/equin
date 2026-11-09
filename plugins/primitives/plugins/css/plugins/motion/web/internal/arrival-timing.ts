// The staged batch's timeline (`ArrivalStep`): when each step arrives — its
// rows' slots opening and their content entering together. The entry itself
// (durations, curves, rise) is CSS (`arrival.css`).
//
// A step every 150 ms, so the batch reads as a top-to-bottom cascade rather
// than one pop; a long batch compresses its gaps to keep the whole cascade
// within `MAX_SPAN_MS`.

/** Between two steps, unless the batch is too long to keep it. */
export const STEP_GAP_MS = 150;
/** The last step starts at most this long after the first. */
export const MAX_SPAN_MS = 900;

/** When step `step` of a `steps`-step batch arrives, from the batch's mount. */
export function arrivalDelayMs(step: number, steps: number): number {
  const gap = steps <= 1 ? 0 : Math.min(STEP_GAP_MS, MAX_SPAN_MS / (steps - 1));
  return Math.round(step * gap);
}
