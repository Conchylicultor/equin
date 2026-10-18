/**
 * The fold tween's timing — ONE clock for every fold in the app: a nested
 * box's height (collapsible's `FoldMotion`), a flat list's revealed or hidden
 * rows (`useRowFold`), and the chevron's quarter turn (`duration-200`). A fold
 * in a tree and a fold in a section must not run at two speeds.
 *
 * Read it through {@link foldTiming}: the duration and the opening curve
 * depend on how far the fold travels.
 */
export const FOLD_MS = 200;

/** The longest a fold runs, however far it travels. */
export const FOLD_MAX_MS = 300;

/** Fast out, soft landing — the content leaves decisively and settles. */
export const FOLD_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * Opening: a gentler start, the same soft landing. Under {@link FOLD_EASING}
 * a fold covers half its distance in its first fifth — fine for a short box,
 * but a screenful of rows then jumps ~150 px a frame and reads as a pop, not
 * a motion. This one has covered a quarter by then.
 */
export const FOLD_OPEN_EASING = "cubic-bezier(0.3, 0, 0.1, 1)";

/** Up to this distance a fold runs {@link FOLD_MS}; past it, longer. */
const FOLD_SHORT_PX = 300;
/** Extra time per px past {@link FOLD_SHORT_PX}, up to {@link FOLD_MAX_MS}. */
const FOLD_MS_PER_PX = 0.15;

export interface FoldTiming {
  duration: number;
  easing: string;
}

/**
 * The timing of one fold: `opening` (content arriving) or not, over
 * `distance` px. A short fold runs {@link FOLD_MS}; a long one a little
 * longer (capped at {@link FOLD_MAX_MS}), so its speed per frame stays
 * readable instead of its duration staying fixed.
 */
export function foldTiming({
  opening,
  distance,
}: {
  opening: boolean;
  distance: number;
}): FoldTiming {
  const extra =
    Math.max(0, Math.abs(distance) - FOLD_SHORT_PX) * FOLD_MS_PER_PX;
  return {
    duration: Math.min(FOLD_MAX_MS, FOLD_MS + extra),
    easing: opening ? FOLD_OPEN_EASING : FOLD_EASING,
  };
}
