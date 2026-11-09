import { announceNavigation } from "./announce-navigation";

/** A CSS `cubic-bezier(x1, y1, x2, y2)` timing function's control points. */
export type CubicBezier = readonly [number, number, number, number];

export interface GlideScrollOptions {
  /** How long the glide runs, in ms. */
  duration: number;
  /** The curve it runs on — pass the same points as a CSS transition it moves
   *  with, so the scroll and that transition land as one motion. */
  easing: CubicBezier;
  /**
   * The animation the glide moves with (a CSS transition beside it): the
   * glide reads its elapsed time off that animation's own clock every frame,
   * instead of keeping one of its own. A transition's clock starts when the
   * browser resolves the style change, which a long task after the commit
   * (a heavy mount) can push anywhere — one clock is the only way the two
   * cannot drift apart. Once it finishes or is cancelled, the glide lands.
   */
  follow?: Animation;
}

/**
 * The progress (0..1) a CSS `cubic-bezier(...)` reaches at time fraction `x`:
 * solves the curve's x(t) = x by bisection (monotonic for 0 ≤ x1, x2 ≤ 1), then
 * reads y(t).
 */
export function cubicBezierAt(
  [x1, y1, x2, y2]: CubicBezier,
  x: number,
): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const at = (t: number, a: number, c: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * c * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (at(mid, x1, x2) < x) lo = mid;
    else hi = mid;
  }
  return at((lo + hi) / 2, y1, y2);
}

/**
 * Glide `scroller` to `to` frame by frame on a given curve — for a scroll that
 * must move in step with a CSS transition running beside it (a row of columns
 * whose widths animate while the row scrolls to reveal its end), which native
 * `behavior: "smooth"` cannot: its duration and curve are the browser's.
 *
 * Only the axes passed move. The clock starts on the next frame (like a CSS
 * transition's); each frame writes the interpolated offset (the browser clamps
 * it to what the content allows at that frame), the last one the target
 * itself. A navigation: it announces one. Returns a cancel, which
 * stops the glide where it is.
 */
export function glideScroll(
  scroller: HTMLElement,
  to: { left?: number; top?: number },
  { duration, easing, follow }: GlideScrollOptions,
): () => void {
  const fromLeft = scroller.scrollLeft;
  const fromTop = scroller.scrollTop;
  const moves =
    (to.left !== undefined && Math.abs(to.left - fromLeft) >= 1) ||
    (to.top !== undefined && Math.abs(to.top - fromTop) >= 1);
  if (!moves) return () => {};
  announceNavigation(scroller);
  // The clock starts on the first frame, as a CSS transition's does: a
  // transition set in the same commit starts when the browser next renders,
  // which a long task after the commit (a heavy mount) can delay well past
  // now — started from now, the glide would jump while the widths had not
  // moved yet.
  let start = -1;
  let raf = 0;
  const elapsed = (now: number): number => {
    if (follow) {
      if (follow.playState === "finished" || follow.playState === "idle") {
        return duration;
      }
      return Number(follow.currentTime ?? 0);
    }
    if (start < 0) start = now;
    return now - start;
  };
  const step = (now: number) => {
    const p = duration <= 0 ? 1 : Math.min(1, elapsed(now) / duration);
    const e = cubicBezierAt(easing, p);
    if (to.left !== undefined) {
      scroller.scrollLeft = fromLeft + (to.left - fromLeft) * e;
    }
    if (to.top !== undefined) {
      scroller.scrollTop = fromTop + (to.top - fromTop) * e;
    }
    if (p < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
