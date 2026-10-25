/** Motion has no duration under `prefers-reduced-motion`: the same states,
 *  no movement. Every tween in the app asks here — folds, columns, surfaces. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
