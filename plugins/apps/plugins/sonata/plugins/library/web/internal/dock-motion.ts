import { useEffect, useRef, useState } from "react";

/**
 * How the section dock folds and unfolds: the panel growing out of the rail
 * (and back into it) and the notes giving way beside it run on ONE clock —
 * the mockup's 0.4 s ease-out (proto-1792113547-2qr6g7) — so the panel's edge
 * and the notes' edge travel together.
 */
export const DOCK_MS = 400;
const DOCK_CURVE = [0.2, 0.8, 0.2, 1] as const;

/** {@link DOCK_CURVE} as the CSS easing the panel's morph animates with. */
export const DOCK_EASE = `cubic-bezier(${DOCK_CURVE.join(", ")})`;

/** {@link DOCK_CURVE} as a function of time, for the eased reserve. */
const dockEase = cubicBezier(...DOCK_CURVE);

/**
 * The room the dock reserves at the right edge, in px, eased to `target` on
 * the dock's clock whenever it changes — the number the display's cover and
 * the progression capsule are laid out from, so the notes (a bleed display
 * lays its keys out from the number itself, which no CSS transition reaches)
 * narrow and widen with the panel. A change mid-way eases on from where it
 * stands. Under `prefers-reduced-motion` it lands on the next frame.
 */
export function useDockReserve(target: number): number {
  const [value, setValue] = useState(target);
  const drawn = useRef(target);
  useEffect(() => {
    const from = drawn.current;
    if (from === target) return;
    const duration = prefersReducedMotion() ? 0 : DOCK_MS;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = duration === 0 ? 1 : Math.min(1, (now - start) / duration);
      const v = from + (target - from) * dockEase(t);
      drawn.current = v;
      setValue(v);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * CSS `cubic-bezier(x1, y1, x2, y2)` as a function of time in [0, 1]: solve
 * the curve's x for its parameter (Newton, falling back to bisection where
 * the slope flattens), then read its y.
 */
function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (t: number) => number {
  const at = (a: number, b: number, s: number) =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  const slope = (a: number, b: number, s: number) =>
    3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 8; i++) {
      const dx = at(x1, x2, s) - t;
      if (Math.abs(dx) < 1e-6) return at(y1, y2, s);
      const d = slope(x1, x2, s);
      if (Math.abs(d) < 1e-6) break;
      s -= dx / d;
    }
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < 30; i++) {
      const x = at(x1, x2, s);
      if (Math.abs(x - t) < 1e-6) break;
      if (x < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return at(y1, y2, s);
  };
}
