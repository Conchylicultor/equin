/**
 * The fold tween's timing — ONE clock for every fold in the app: a nested
 * box's height (collapsible's `FoldMotion`), a flat list's revealed or hidden
 * rows (`useRowFold`), and the chevron's quarter turn (`duration-200`). A fold
 * in a tree and a fold in a section must not run at two speeds.
 */
export const FOLD_MS = 200;

/** Fast out, soft landing — the content arrives decisively and settles. */
export const FOLD_EASING = "cubic-bezier(0.2, 0, 0, 1)";
