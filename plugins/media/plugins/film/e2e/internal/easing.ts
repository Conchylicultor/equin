// Easings as DATA, so a composition serializes to the page: a named preset, a
// cubic-bezier, a spring, or a step. `ease(e, u)` maps segment progress
// u ∈ [0, 1] to eased progress; every easing hits 0 at 0 and exactly 1 at 1
// (a spring may overshoot in between).

export type EasingName =
  | "linear"
  | "in"
  | "out"
  | "inOut"
  | "inSine"
  | "outSine"
  | "inOutSine"
  | "inQuad"
  | "outQuad"
  | "inOutQuad"
  | "inCubic"
  | "outCubic"
  | "inOutCubic"
  | "inQuart"
  | "outQuart"
  | "inOutQuart"
  | "outExpo"
  | "inOutExpo"
  | "outBack"
  /** Holds the previous value until the key, then jumps. */
  | "step";

export type Easing =
  | EasingName
  /** CSS `cubic-bezier(x1, y1, x2, y2)`. */
  | { bezier: [number, number, number, number] }
  /**
   * A damped spring settling exactly at the segment's end. `bounce` 0 is
   * critically damped (no overshoot), 0.3 a gentle overshoot, 0.6 springy.
   */
  | { spring: { bounce?: number } };

/** Named presets that are CSS's own curves (Material / Apple-like). */
const BEZIERS: Partial<Record<EasingName, [number, number, number, number]>> = {
  in: [0.42, 0, 1, 1],
  out: [0, 0, 0.58, 1],
  inOut: [0.42, 0, 0.58, 1],
  inSine: [0.12, 0, 0.39, 0],
  outSine: [0.61, 1, 0.88, 1],
  inOutSine: [0.37, 0, 0.63, 1],
  inQuad: [0.11, 0, 0.5, 0],
  outQuad: [0.5, 1, 0.89, 1],
  inOutQuad: [0.45, 0, 0.55, 1],
  inCubic: [0.32, 0, 0.67, 0],
  outCubic: [0.33, 1, 0.68, 1],
  inOutCubic: [0.65, 0, 0.35, 1],
  inQuart: [0.5, 0, 0.75, 0],
  outQuart: [0.25, 1, 0.5, 1],
  inOutQuart: [0.76, 0, 0.24, 1],
  outExpo: [0.16, 1, 0.3, 1],
  inOutExpo: [0.87, 0, 0.13, 1],
  outBack: [0.34, 1.56, 0.64, 1],
};

/** Solve a cubic-bezier timing curve for x = u (Newton, then bisection). */
function bezier(p: [number, number, number, number], u: number): number {
  const [x1, y1, x2, y2] = p;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xAt = (s: number): number => ((ax * s + bx) * s + cx) * s;
  const dxAt = (s: number): number => (3 * ax * s + 2 * bx) * s + cx;
  let s = u;
  for (let i = 0; i < 8; i++) {
    const err = xAt(s) - u;
    if (Math.abs(err) < 1e-7) return ((ay * s + by) * s + cy) * s;
    const d = dxAt(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  let lo = 0;
  let hi = 1;
  s = u;
  for (let i = 0; i < 40; i++) {
    const x = xAt(s);
    if (Math.abs(x - u) < 1e-7) break;
    if (x < u) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return ((ay * s + by) * s + cy) * s;
}

/** Damped-spring step response over u ∈ [0, 1], corrected to land exactly on 1. */
function spring(bounce: number, u: number): number {
  const zeta = Math.min(1, Math.max(0.05, 1 - bounce));
  // ζω₀ = 6.9: the envelope is at 1e-3 when the segment ends.
  const w0 = 6.9 / zeta;
  const raw = (x: number): number => {
    if (zeta >= 1) return 1 - Math.exp(-w0 * x) * (1 + w0 * x);
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return (
      1 -
      Math.exp(-zeta * w0 * x) *
        (Math.cos(wd * x) + ((zeta * w0) / wd) * Math.sin(wd * x))
    );
  };
  return raw(u) + (1 - raw(1)) * u;
}

export function ease(e: Easing | undefined, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (e === undefined || e === "linear") return u;
  if (e === "step") return 0;
  if (typeof e === "string") {
    const b = BEZIERS[e];
    if (!b) throw new Error(`unknown easing "${e}"`);
    return bezier(b, u);
  }
  if ("bezier" in e) return bezier(e.bezier, u);
  return spring(e.spring.bounce ?? 0.25, u);
}
