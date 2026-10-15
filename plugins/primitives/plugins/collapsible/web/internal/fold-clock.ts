/**
 * The fold clock: how every fold starts its tween — a nested box's
 * (`FoldMotion`) and a flat list's rows (`useRowFold`) alike.
 *
 * The caller pins the fold's first frame in inline style during the commit;
 * `startFold` runs `start` on the next animation frame, handing it the time
 * the tween starts from: `performance.now()`, never the frame's own stamp.
 * Mounting what a fold reveals can hold the main thread for a long while,
 * and the frame stamp predates that work — a tween dated from it would have
 * elapsed by its first paint, and the content would snap open instead.
 *
 * The callback runs before the very next paint, so the clock itself costs no
 * frame: whatever passes between a click and the first moving frame is the
 * commit's own work (render, style, layout) — `e2e/fold-latency.ts` measures
 * it.
 *
 * Returns the cancel, for a flip or an unmount landing before the start.
 */
export function startFold(start: (startTime: number) => void): () => void {
  const frame = requestAnimationFrame(() => start(performance.now()));
  return () => cancelAnimationFrame(frame);
}

/** Folds have no duration under `prefers-reduced-motion`: the same states,
 *  no motion. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
