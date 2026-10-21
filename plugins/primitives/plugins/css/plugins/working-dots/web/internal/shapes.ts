/**
 * The dot styles, as pure shapes: each dot's offset from the resting row at a
 * pass's progress `p` (0 → 1, may overshoot past 1 under the spring), at
 * amplitude `a`. Offsets are in units where a dot is 6 wide and the dots sit
 * PITCH apart; the engine scales them to the rendered size.
 *
 * Every shape starts and ends on the resting row — the invariant that lets any
 * pass follow any other without a seam (shapes.test.ts).
 */

export interface DotPose {
  x?: number;
  y?: number;
  /** Scale; 1 at rest. */
  s?: number;
  /** Halo strength 0..1; 0 at rest. */
  halo?: number;
}

export type DotStyleName = "gooey" | "wave" | "leap" | "orbit" | "glow";

export interface DotStyle {
  /** Run through the gooey (blur + alpha threshold) filter, so touching dots melt together. */
  goo?: boolean;
  /** Most passes in one run of this style (default 3). */
  maxReps?: number;
  pose: (p: number, i: number, a: number) => DotPose;
}

/** A dot's diameter, in shape units. */
export const DOT_UNITS = 6;
/** Centre-to-centre spacing, in shape units: a gap of two thirds of a dot, room to breathe. */
export const PITCH = 10;
/** Resting x of each dot, in shape units. */
export const REST_X = [0, PITCH, 2 * PITCH] as const;

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** A bump that leaves and lands with zero speed (sin²): no dot starts or stops with a kick. */
const hump = (q: number) => Math.sin(Math.PI * clamp01(q)) ** 2;
/** Dot i's own window of the pass, so a swell runs along the row. */
const stagger = (p: number, i: number) => clamp01((p - i * 0.25) / 0.5);

export const DOT_STYLES: Record<DotStyleName, DotStyle> = {
  // The middle dot rolls into the left dot, through, into the right one, and back — melting into each.
  gooey: {
    goo: true,
    pose: (p, i, a) => {
      const w = Math.sin(2 * Math.PI * p);
      if (i === 1) return { x: -PITCH * a * w };
      return { s: 1 + 0.15 * a * Math.max(0, i === 0 ? w : -w) };
    },
  },
  // A swell runs along the row: each dot rises and grows in turn.
  wave: {
    pose: (p, i, a) => {
      const k = hump(stagger(p, i));
      return { y: -3 * a * k, s: 1 + 0.1 * a * k };
    },
  },
  // The last dot hops over the other two to the front while they shuffle along.
  leap: {
    pose: (p, i, a) =>
      i === 2
        ? { x: -2 * PITCH * p, y: -5.5 * a * hump(p), s: 1 - 0.12 * hump(p) }
        : { x: PITCH * p },
  },
  // The outer dots swing a full turn round the middle one.
  orbit: {
    maxReps: 1,
    pose: (p, i) => {
      if (i === 1) return {};
      const t = 2 * Math.PI * p;
      const sign = i === 0 ? -1 : 1;
      return {
        x: sign * PITCH * (Math.cos(t) - 1),
        y: sign * PITCH * Math.sin(t),
      };
    },
  },
  // A lit bead passes along the row, haloed.
  glow: {
    pose: (p, i, a) => {
      const k = hump(stagger(p, i));
      return { s: 1 + 0.2 * a * k, halo: Math.min(1, a) * k };
    },
  },
};
