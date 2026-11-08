/**
 * The numbers every chapter of the zoom is drawn and moved with: rounding for
 * markup, the easing curves, a seeded generator (so a drawing generated from a
 * seed is the same on every visit), and polyline geometry.
 */

export type Pt = readonly [number, number];
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One decimal: every coordinate written into markup goes through this. */
export const n1 = (x: number): number => Math.round(x * 10) / 10;
export const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));
/** Smoothstep over 0…1, clamped. */
export const smooth = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

/**
 * A switch decided by a value that can hover at its threshold (a scroll position at rest under a
 * thumb, a page that moves a few pixels as a phone's toolbar hides): it turns on once the value
 * reaches `on` and off again only below `off`, so a value hovering at either cannot flip it back
 * and forth. Every on/off decision the zoom takes from scroll goes through one.
 */
export function latch(on: number, off: number): (x: number) => boolean {
  if (!(off < on))
    throw new Error(`latch: off (${off}) must be below on (${on})`);
  let state = false;
  return (x) => {
    if (state ? x < off : x >= on) state = !state;
    return state;
  };
}

export type Ease = (t: number) => number;
export const EASE = {
  io: (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  out: (t: number) => 1 - Math.pow(1 - t, 3),
} satisfies Record<string, Ease>;
export type EaseName = keyof typeof EASE;

/** {@link EASE.io} over a clamped input. */
export const io = (x: number): number => EASE.io(clamp01(x));

export function lerpRect(a: Rect, b: Rect, m: number): Rect {
  return {
    x: a.x + (b.x - a.x) * m,
    y: a.y + (b.y - a.y) * m,
    w: a.w + (b.w - a.w) * m,
    h: a.h + (b.h - a.h) * m,
  };
}

/** A seeded generator (mulberry32): 0 ≤ x < 1, the same sequence for the same seed. */
export function random(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A smooth curve through points (Catmull-Rom as cubic Béziers): a trend, not a zig-zag. */
export function smoothPath(P: readonly Pt[]): string {
  const at = (i: number) => P[Math.max(0, Math.min(P.length - 1, i))]!;
  let d = `M${n1(at(0)[0])} ${n1(at(0)[1])}`;
  for (let i = 0; i < P.length - 1; i++) {
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    const e = at(i + 2);
    d += `C${n1(b[0] + (c[0] - a[0]) / 6)} ${n1(b[1] + (c[1] - a[1]) / 6)} ${n1(c[0] - (e[0] - b[0]) / 6)} ${n1(c[1] - (e[1] - b[1]) / 6)} ${n1(c[0])} ${n1(c[1])}`;
  }
  return d;
}

export const polyline = (pts: readonly Pt[]): string =>
  "M" + pts.map((p) => `${n1(p[0])} ${n1(p[1])}`).join("L");

/**
 * The point a fraction m of the way along a polyline, by length — where a trail
 * drawn with pathLength="1" and stroke-dashoffset 1 - m ends, so a comet's head
 * always sits on its trail's tip.
 */
export function alongPath(pts: readonly Pt[], m: number): Pt {
  const L = [0];
  for (let i = 1; i < pts.length; i++)
    L.push(
      L[i - 1]! +
        Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]),
    );
  const at = clamp01(m) * L[L.length - 1]!;
  let i = 1;
  while (i < pts.length && L[i]! < at) i++;
  if (i >= pts.length) return pts[pts.length - 1]!;
  const k = (at - L[i - 1]!) / (L[i]! - L[i - 1]! || 1);
  const a = pts[i - 1]!;
  const b = pts[i]!;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}

/**
 * How far along its way something travelling is, u in 0…1: it leaves and
 * arrives at speed (an ease-in-out would stall at both ends, reading as a
 * freeze as it leaves or reaches an orbit), slowing a little midway.
 */
export function travel(u: number): number {
  const c = clamp01(u);
  return 0.55 * c + 0.45 * (c * c * (3 - 2 * c));
}
