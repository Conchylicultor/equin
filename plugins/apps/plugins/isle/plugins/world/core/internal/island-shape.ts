// Organic island silhouettes: a deterministic shape generator, one island per
// seed.
//
// An island is made in two stages. A layout of soft primitives (ellipse
// bodies, tapered spines, crescents, necks, bays, lagoons, islets — chosen per
// kind) is unioned smoothly, sampled through a low-frequency domain warp and
// given a fractal coast. That outline is rasterised once on a coarse grid and
// turned into a true signed distance to the coast (sub-cell seeds + vector
// propagation), so the height is the same function of "how far from the shore"
// everywhere: shallows, sand and grass come out at the same widths on every
// shape, and the interior rises to a flat plateau where villages fit.
//
// `planIsland(seed, opts)` is cheap (~ms): the layout and a polar profile, for
// spacing an archipelago. `plan.build()` rasterises the shape; `plan.steps()`
// is the same work as a generator that yields between phases, for a caller
// that slices it across frames.

import { mulberry32 } from "@plugins/packages/plugins/seeded-random/core";
import { clamp, fbmShape, lerp, vnoise } from "./noise";
import type { Pt } from "./geometry";

/** A soft primitive: signed distance (px, negative inside) and a bounding box. */
interface Prim {
  readonly box: readonly [number, number, number, number];
  /** Box-distance scale: the box distance × lbk is a lower bound of d. */
  readonly lbk: number;
  d(x: number, y: number): number;
}

type Spine3 = readonly [number, number, number];

const boxDist = (p: Prim, x: number, y: number) => {
  const b = p.box;
  const dx = Math.max(b[0] - x, 0, x - b[2]);
  const dy = Math.max(b[1] - y, 0, y - b[3]);
  return Math.sqrt(dx * dx + dy * dy) * p.lbk;
};

function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ---------- 8SSEDT: each cell takes a neighbour's nearest coast point when nearer ----------
function edtRow(
  DD: Float64Array,
  PX: Float64Array,
  PY: Float64Array,
  gw: number,
  gh: number,
  C: number,
  j: number,
  fwd: boolean,
): void {
  const rl = (k: number, X: number, Y: number, k2: number) => {
    if (DD[k2] === Infinity) return;
    const px = PX[k2]!;
    const py = PY[k2]!;
    const dx = px - X;
    const dy = py - Y;
    const d2 = dx * dx + dy * dy;
    if (d2 < DD[k]!) {
      DD[k] = d2;
      PX[k] = px;
      PY[k] = py;
    }
  };
  const Y = j * C;
  const r0 = j * gw;
  if (fwd) {
    for (let i = 0; i < gw; i++) {
      const k = r0 + i;
      const X = i * C;
      if (i > 0) rl(k, X, Y, k - 1);
      if (j > 0) {
        rl(k, X, Y, k - gw);
        if (i > 0) rl(k, X, Y, k - gw - 1);
        if (i < gw - 1) rl(k, X, Y, k - gw + 1);
      }
    }
    for (let i = gw - 2; i >= 0; i--) rl(r0 + i, i * C, Y, r0 + i + 1);
    return;
  }
  for (let i = gw - 1; i >= 0; i--) {
    const k = r0 + i;
    const X = i * C;
    if (i < gw - 1) rl(k, X, Y, k + 1);
    if (j < gh - 1) {
      rl(k, X, Y, k + gw);
      if (i < gw - 1) rl(k, X, Y, k + gw + 1);
      if (i > 0) rl(k, X, Y, k + gw - 1);
    }
  }
  for (let i = 1; i < gw; i++) rl(r0 + i, i * C, Y, r0 + i - 1);
}

// ---------- primitives ----------
function ellipse(cx: number, cy: number, a: number, b: number, rot = 0): Prim {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const m = Math.min(a, b);
  const e = Math.max(a, b);
  return {
    box: [cx - e, cy - e, cx + e, cy + e],
    lbk: m / e,
    d(x, y) {
      const dx = x - cx;
      const dy = y - cy;
      const u = (dx * c + dy * s) / a;
      const v = (-dx * s + dy * c) / b;
      return (Math.sqrt(u * u + v * v) - 1) * m;
    },
  };
}
const disc = (cx: number, cy: number, r: number) => ellipse(cx, cy, r, r);

/** A tapered tube along a polyline of [x, y, r]. */
function spine(pts: readonly Spine3[]): Prim {
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  for (const [x, y, r] of pts) {
    x0 = Math.min(x0, x - r);
    y0 = Math.min(y0, y - r);
    x1 = Math.max(x1, x + r);
    y1 = Math.max(y1, y + r);
  }
  return {
    box: [x0, y0, x1, y1],
    lbk: 1,
    d(x, y) {
      let best = 1e9;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay, ar] = pts[i - 1]!;
        const [bx, by, br] = pts[i]!;
        const dx = bx - ax;
        const dy = by - ay;
        const L = dx * dx + dy * dy || 1;
        const t = clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1);
        const qx = ax + t * dx - x;
        const qy = ay + t * dy - y;
        const v = Math.sqrt(qx * qx + qy * qy) - lerp(ar, br, t);
        if (v < best) best = v;
      }
      return best;
    },
  };
}

/** A Catmull-Rom curve through [x, y, r] control points, sampled into a spine. */
function curvedSpine(ctrl: readonly Spine3[], per = 4): Prim {
  const out: Spine3[] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)]!;
    const p1 = ctrl[i]!;
    const p2 = ctrl[i + 1]!;
    const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)]!;
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const c = (j: 0 | 1 | 2) =>
        0.5 *
        (2 * p1[j] +
          (-p0[j] + p2[j]) * t +
          (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 +
          (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
      out.push([c(0), c(1), c(2)]);
    }
  }
  out.push(ctrl[ctrl.length - 1]!);
  return spine(out.map(([x, y, r]) => [x, y, Math.max(r, 4)] as const));
}

/** An arc of a circle from a0 to a1, thickness profile w(t). */
function arc(
  cx: number,
  cy: number,
  R: number,
  a0: number,
  a1: number,
  w: (t: number) => number,
  n = 9,
): Prim {
  const ctrl: Spine3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = lerp(a0, a1, t);
    ctrl.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R, w(t)]);
  }
  return curvedSpine(ctrl, 3);
}

// ---------- kinds ----------
type Rnd = () => number;
interface Layout {
  add: Prim[];
  sub: Prim[];
}
const between = (r: Rnd, a: number, b: number) => a + r() * (b - a);

/** A few headlands and coves round an ellipse-ish body. */
function coastFeatures(
  r: Rnd,
  A: number,
  B: number,
  L: Layout,
  {
    capes = [1, 3],
    coves = [1, 2],
    coveR = [0.16, 0.26],
  }: {
    capes?: [number, number];
    coves?: [number, number];
    coveR?: [number, number];
  } = {},
): void {
  const R = Math.sqrt(A * B);
  const nc = Math.round(between(r, capes[0], capes[1]));
  const nb = Math.round(between(r, coves[0], coves[1]));
  const used: number[] = [];
  const freeAngle = () => {
    for (let t = 0; t < 20; t++) {
      const a = r() * Math.PI * 2;
      if (
        used.every(
          (u) => Math.abs(Math.atan2(Math.sin(a - u), Math.cos(a - u))) > 0.7,
        )
      ) {
        used.push(a);
        return a;
      }
    }
    const a = r() * 6.28;
    used.push(a);
    return a;
  };
  for (let i = 0; i < nc; i++) {
    const a = freeAngle();
    const ex = Math.cos(a) * A;
    const ey = Math.sin(a) * B;
    const len = R * between(r, 0.16, 0.32);
    const w = R * between(r, 0.1, 0.17);
    const bend = between(r, -0.5, 0.5);
    const nx = Math.cos(a + bend * 0.5);
    const ny = Math.sin(a + bend * 0.5);
    L.add.push(
      curvedSpine([
        [ex * 0.7, ey * 0.7, w * 1.6],
        [ex + nx * len * 0.5, ey + ny * len * 0.5, w],
        [ex + Math.cos(a + bend) * len, ey + Math.sin(a + bend) * len, w * 0.5],
      ]),
    );
  }
  for (let i = 0; i < nb; i++) {
    const a = freeAngle();
    const rr = R * between(r, coveR[0], coveR[1]);
    const d = 1.0 + (rr / R) * 0.25;
    L.sub.push(
      ellipse(
        Math.cos(a) * A * d,
        Math.sin(a) * B * d,
        rr * between(r, 1, 1.5),
        rr,
        a + Math.PI / 2,
      ),
    );
  }
}

/** Small islets and rocks off a coast described by an ellipse ±A × ±B. */
function islets(r: Rnd, A: number, B: number, L: Layout, n: number): void {
  const R = Math.sqrt(A * B);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const d = between(r, 1.12, 1.4);
    const cx = Math.cos(a) * A * d;
    const cy = Math.sin(a) * B * d;
    const big = r() < 0.35;
    const rr = big ? R * between(r, 0.07, 0.11) : between(r, 46, 75);
    L.add.push(ellipse(cx, cy, rr * between(r, 1, 1.6), rr, r() * 3));
    if (r() < 0.6) {
      const k = 1 + Math.floor(r() * 3);
      for (let j = 0; j < k; j++) {
        const b = a + between(r, -0.25, 0.25);
        const e = d + between(r, 0.05, 0.16);
        L.add.push(
          disc(Math.cos(b) * A * e, Math.sin(b) * B * e, between(r, 34, 52)),
        );
      }
    }
  }
}

/** Every island kind, with its layout. Each lays out primitives in a frame of about ±A × ±B. */
export type IslandKind =
  | "round"
  | "ridge"
  | "crescent"
  | "twin"
  | "cluster"
  | "kidney"
  | "fingers"
  | "lagoon";

const KINDS: Record<
  IslandKind,
  (r: Rnd, A: number, B: number, L: Layout) => void
> = {
  // round-ish, a couple of headlands, one deep sheltered harbour bay
  round(r, A, B, L) {
    L.add.push(ellipse(0, 0, A * 0.94, B * 0.94));
    for (let i = 0; i < 2; i++) {
      const a = r() * 6.28;
      L.add.push(
        ellipse(
          Math.cos(a) * A * 0.42,
          Math.sin(a) * B * 0.42,
          A * between(r, 0.5, 0.65),
          B * between(r, 0.5, 0.65),
          r() * 3,
        ),
      );
    }
    const ha = r() * 6.28;
    const R = Math.sqrt(A * B);
    L.sub.push(
      ellipse(
        Math.cos(ha) * A * 1.0,
        Math.sin(ha) * B * 1.0,
        R * 0.34,
        R * 0.24,
        ha + Math.PI / 2,
      ),
    );
    coastFeatures(r, A, B, L, { capes: [1, 2], coves: [0, 1] });
    islets(r, A, B, L, Math.floor(r() * 3));
  },
  // a long ridge along a gentle S, tapering to capes; sometimes a hooked spit
  ridge(r, A, B, L) {
    const a = A * 1.3;
    const b = B * 0.62;
    const s1 = between(r, -0.35, 0.35) * b;
    const s2 = between(r, -0.35, 0.35) * b;
    const n = 7;
    const ctrl: Spine3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = lerp(-a, a, t);
      const y = Math.sin(t * Math.PI) * s1 + Math.sin(t * Math.PI * 2) * s2;
      const w =
        b *
        (0.18 + 0.85 * Math.pow(Math.sin(t * Math.PI), 0.55)) *
        between(r, 0.85, 1.12);
      ctrl.push([x, y, w]);
    }
    L.add.push(curvedSpine(ctrl));
    if (r() < 0.6) {
      const e = r() < 0.5 ? 0 : n;
      const [x, y] = ctrl[e]!;
      const dir = e ? 1 : -1;
      const up = r() < 0.5 ? 1 : -1;
      L.add.push(
        curvedSpine([
          [x - dir * b * 0.3, y, b * 0.22],
          [x + dir * b * 0.35, y + up * b * 0.35, b * 0.11],
          [x + dir * b * 0.2, y + up * b * 0.95, b * 0.08],
          [x - dir * b * 0.25, y + up * b * 1.15, b * 0.05],
        ]),
      );
    }
    coastFeatures(r, a * 0.85, b * 0.9, L, {
      capes: [1, 2],
      coves: [1, 2],
      coveR: [0.13, 0.2],
    });
    islets(r, a, b, L, 1 + Math.floor(r() * 3));
  },
  // a crescent hugging a wide sheltered bay
  crescent(r, A, B, L) {
    const R = Math.max(A, B) * 1.02;
    const span = between(r, 2.7, 3.5);
    const mid = -Math.PI / 2;
    const th = Math.min(A, B) * between(r, 0.42, 0.5);
    const cy = R * 0.5;
    L.add.push(
      arc(
        0,
        cy,
        R,
        mid - span / 2,
        mid + span / 2,
        (t) => th * (0.25 + 0.85 * Math.pow(Math.sin(t * Math.PI), 0.6)),
      ),
    );
    L.add.push(ellipse(0, cy - R * 1.08, A * 0.5, th * 0.6));
    if (r() < 0.35) L.add.push(disc(0, cy + R * 0.15, R * 0.1));
    coastFeatures(r, A * 0.8, B * 0.7, L, {
      capes: [0, 1],
      coves: [1, 1],
      coveR: [0.12, 0.18],
    });
    islets(r, A, B, L, Math.floor(r() * 3));
  },
  // two lobes joined by a narrow isthmus
  twin(r, A, B, L) {
    const t = between(r, -0.35, 0.35);
    const ax = A * 0.52;
    const a1 = [A * between(r, 0.5, 0.6), B * between(r, 0.62, 0.8)] as const;
    const a2 = [A * between(r, 0.38, 0.5), B * between(r, 0.55, 0.72)] as const;
    const e1 = ellipse(-ax, -t * B * 0.4, a1[0], a1[1], between(r, -0.4, 0.4));
    const e2 = ellipse(
      ax * 1.05,
      t * B * 0.4,
      a2[0],
      a2[1],
      between(r, -0.4, 0.4),
    );
    L.add.push(e1, e2);
    const w = Math.min(A, B) * between(r, 0.16, 0.24);
    L.add.push(
      curvedSpine([
        [-ax * 0.6, -t * B * 0.3, w * 1.4],
        [0, between(r, -0.2, 0.2) * B, w],
        [ax * 0.6, t * B * 0.3, w * 1.4],
      ]),
    );
    coastFeatures(r, A, B * 0.85, L, {
      capes: [1, 2],
      coves: [0, 1],
      coveR: [0.12, 0.18],
    });
    islets(r, A, B, L, Math.floor(r() * 3));
  },
  // a main body with a sister island across a strait and a scatter of islets
  cluster(r, A, B, L) {
    const sa = r() * 6.28;
    const mx = -Math.cos(sa) * A * 0.12;
    const my = -Math.sin(sa) * B * 0.12;
    L.add.push(ellipse(mx, my, A * 0.8, B * 0.84, between(r, -0.3, 0.3)));
    L.add.push(
      ellipse(
        mx + Math.cos(sa) * A * 0.42,
        my + Math.sin(sa) * B * 0.42,
        A * 0.45,
        B * 0.5,
        r() * 3,
      ),
    );
    const d = 1.18;
    const sx = mx + Math.cos(sa) * A * d;
    const sy = my + Math.sin(sa) * B * d;
    L.add.push(
      ellipse(
        sx,
        sy,
        A * between(r, 0.2, 0.28),
        B * between(r, 0.2, 0.3),
        r() * 3,
      ),
    );
    L.add.push(
      disc(
        sx + Math.cos(sa + 0.9) * A * 0.3,
        sy + Math.sin(sa + 0.9) * B * 0.3,
        Math.sqrt(A * B) * 0.08,
      ),
    );
    coastFeatures(r, A * 0.8, B * 0.84, L, { capes: [1, 2], coves: [1, 2] });
    islets(r, A, B, L, 3 + Math.floor(r() * 3));
  },
  // a kidney: one broad, shallow bight along a long side
  kidney(r, A, B, L) {
    L.add.push(ellipse(0, 0, A, B * 0.92));
    const side = r() < 0.5 ? 1 : -1;
    const R = Math.sqrt(A * B);
    L.sub.push(
      ellipse(
        between(r, -0.2, 0.2) * A,
        side * B * 1.02,
        A * between(r, 0.36, 0.46),
        B * between(r, 0.5, 0.6),
      ),
    );
    L.add.push(
      ellipse(-A * 0.62, side * B * 0.5, A * 0.34, B * 0.48, -side * 0.5),
      ellipse(A * 0.62, side * B * 0.5, A * 0.34, B * 0.48, side * 0.5),
    );
    coastFeatures(r, A, B * 0.9, L, {
      capes: [1, 2],
      coves: [0, 1],
      coveR: [0.12, 0.18],
    });
    islets(r, A, B, L, Math.floor(r() * 3) + (R > 0 ? 1 : 0));
  },
  // a compact core with long peninsulas — deep bays between them
  fingers(r, A, B, L) {
    L.add.push(ellipse(0, 0, A * 0.62, B * 0.66, between(r, -0.3, 0.3)));
    const n = 3 + Math.floor(r() * 2);
    const a0 = r() * 6.28;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2 + between(r, -0.35, 0.35);
      const len = between(r, 1.05, 1.4);
      const bend = between(r, -0.45, 0.45);
      const w = Math.min(A, B) * between(r, 0.2, 0.3);
      const p = (k: number, ww: number): Spine3 => [
        Math.cos(a + bend * k) * A * len * k,
        Math.sin(a + bend * k) * B * len * k,
        ww,
      ];
      L.add.push(
        curvedSpine([
          p(0.2, w * 1.5),
          p(0.55, w),
          p(0.85, w * 0.8),
          p(1, w * 0.55),
        ]),
      );
    }
    islets(r, A, B, L, 1 + Math.floor(r() * 3));
  },
  // round body holding a lagoon behind a sand bar, open to the sea by a channel
  lagoon(r, A, B, L) {
    L.add.push(ellipse(0, 0, A * 0.95, B * 0.95));
    const a = r() * 6.28;
    const R = Math.sqrt(A * B);
    const lx = Math.cos(a) * A * 0.52;
    const ly = Math.sin(a) * B * 0.52;
    L.sub.push(ellipse(lx, ly, R * 0.36, R * 0.24, a + Math.PI / 2));
    L.sub.push(
      curvedSpine([
        [lx, ly, 30],
        [Math.cos(a + 0.25) * A * 0.85, Math.sin(a + 0.25) * B * 0.85, 34],
        [Math.cos(a + 0.35) * A * 1.2, Math.sin(a + 0.35) * B * 1.2, 60],
      ]),
    );
    coastFeatures(r, A, B, L, {
      capes: [1, 2],
      coves: [0, 1],
      coveR: [0.12, 0.18],
    });
    islets(r, A, B, L, Math.floor(r() * 3));
  },
};
const KIND_SCALE: Record<IslandKind, number> = {
  round: 1.12,
  ridge: 1.3,
  crescent: 1.6,
  twin: 1.5,
  cluster: 1.3,
  kidney: 1.15,
  fingers: 1.6,
  lagoon: 1.18,
};
const WEIGHTS: ReadonlyArray<readonly [IslandKind, number]> = [
  ["round", 1],
  ["ridge", 1.1],
  ["crescent", 1],
  ["twin", 1],
  ["cluster", 1],
  ["kidney", 1],
  ["fingers", 0.8],
  ["lagoon", 0.5],
];

/** The kind an island seed draws. */
export function kindOf(seed: number): IslandKind {
  const r = mulberry32(seed * 2654435761 + 7);
  const tot = WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let t = r() * tot;
  for (const [k, w] of WEIGHTS) if ((t -= w) < 0) return k;
  return "round";
}

// ---------- options and the shape ----------
/** Land forced or water forced: a disc, or a tube along points. */
export type Zone =
  | { readonly x: number; readonly y: number; readonly r: number }
  | { readonly pts: readonly Pt[]; readonly r: number };
export interface Circle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

export interface IslandOptions {
  readonly rx?: number;
  readonly ry?: number;
  readonly kind?: IslandKind;
  /** px of distance per unit of height at the coast. */
  readonly slope?: number;
  /** The hand-shaped home island: a gentle round body round its hand-placed features. */
  readonly home?: boolean;
  readonly rot?: number;
  readonly cell?: number;
  readonly keep?: readonly Zone[];
  readonly cut?: readonly Zone[];
  /** A sheltered harbour bay seaward of (x, y), facing (nx, ny). */
  readonly harbour?: {
    readonly x: number;
    readonly y: number;
    readonly nx?: number;
    readonly ny?: number;
    readonly r?: number;
  };
  /** Where coastToward never lands. */
  readonly noLanding?: readonly Circle[];
}

export interface CoastPoint {
  readonly x: number;
  readonly y: number;
  readonly nx: number;
  readonly ny: number;
  readonly main: boolean;
}

/** A built island, in local px (relative to the island centre). */
export interface IslandShape {
  readonly kind: IslandKind | "home";
  readonly seed: number;
  readonly slope: number;
  /** Local height: ~-1.5 … 1; land > 0, smooth. */
  height(x: number, y: number): number;
  /** On (or by) the main body, not an islet. */
  isMain(x: number, y: number): boolean;
  /** Farthest land (islets included) along angle a from the centre. */
  radiusTo(a: number): number;
  /** The main body's coast point nearest (x, y), outside the no-landing zones. */
  coastToward(x: number, y: number): Pt;
  /** Solid ground just inside that coast point. */
  landingToward(x: number, y: number, level?: number, inset?: number): Pt;
  /** n roomy, well-spread interior points of the main body. */
  sites(n: number, minH?: number, minD?: number): Pt[];
  /** The roomiest interior point of the main body. */
  readonly heart: Pt;
  readonly coast: readonly CoastPoint[];
  /** Where height > -0.5 (beyond it, open sea): [x0, y0, x1, y1]. */
  readonly bbox: readonly [number, number, number, number];
  /** Every bit of land, islets included. */
  readonly land: readonly [number, number, number, number];
}

export interface IslandPlan {
  readonly kind: IslandKind | "home";
  readonly seed: number;
  /** The rasterisation grid's box, local px. */
  readonly box: readonly [number, number, number, number];
  /** Farthest land along angle a, from the outline (before it is built). */
  radiusTo(a: number): number;
  /** The shape, built on first call. */
  build(): IslandShape;
  /** The same build, yielding between phases; its return value is the shape. */
  steps(): Generator<void, IslandShape, void>;
  /**
   * What the shape is assembled from (built on first call): plain data and
   * typed arrays, structured-cloneable — so another thread (a bake worker) can
   * build it and this one {@link restore} it.
   */
  data(): IslandShapeData;
  /** The shape from {@link data} built elsewhere: identical to `build()`'s. Ignored once built. */
  restore(data: IslandShapeData): IslandShape;
  /** Whether the shape is in (built or restored): reading it costs nothing. */
  built(): boolean;
}

/** A built island's raw data (`IslandPlan.data`): the shape is a pure function of it and the plan. */
export interface IslandShapeData {
  readonly H: Float32Array;
  readonly comp: Int32Array;
  readonly owner: Int32Array;
  readonly prof: Float32Array;
  readonly coast: readonly CoastPoint[];
  readonly mainId: number;
  readonly heartK: number;
  readonly bbox: readonly [number, number, number, number];
  readonly landBox: readonly [number, number, number, number];
}

/** A height grid → height(x, y), local px. */
function heightOf(
  H: Float32Array,
  gx0: number,
  gy0: number,
  gw: number,
  gh: number,
  C: number,
  fo: number,
  S: number,
) {
  return function height(x: number, y: number): number {
    const gx = (x - gx0) / C;
    const gy = (y - gy0) / C;
    if (gx < 0 || gy < 0 || gx >= gw - 1 || gy >= gh - 1) return -1.5;
    const i = gx | 0;
    const j = gy | 0;
    const fx = gx - i;
    const fy = gy - j;
    const k = j * gw + i;
    const a = H[k]!;
    const b = H[k + 1]!;
    const c = H[k + gw]!;
    const d = H[k + gw + 1]!;
    let h = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    // zoomed-in detail: two small octaves, only in a band from the shallows to the grass edge
    const w = 1 - Math.abs(h - 0.02) * 8;
    if (w > 0) {
      h +=
        w *
        (0.034 * (vnoise(x / 44 + fo, y / 44) - 0.5) +
          0.012 * (vnoise(x / 19 - fo, y / 19 + 3) - 0.5)) *
        (1000 / S);
    }
    return h;
  };
}

const zonePrim = (k: Zone): Prim =>
  "pts" in k
    ? spine(k.pts.map(([x, y]) => [x, y, k.r] as const))
    : disc(k.x, k.y, k.r);

/** The layout and its outline (cheap); the shape is rasterised by `build()` / `steps()`. */
export function planIsland(seed: number, opts: IslandOptions = {}): IslandPlan {
  const kind = opts.kind ?? kindOf(seed);
  const ks0 = opts.home ? 1 : KIND_SCALE[kind];
  const rx = (opts.rx || 1200) * ks0;
  const ry = (opts.ry || 900) * ks0;
  const r = mulberry32(seed * 7919 + 31);
  const R = Math.sqrt(rx * ry);
  const S = opts.slope || clamp(R * 0.85, 850, 1500);
  const L: Layout = { add: [], sub: [] };
  const quiet: Circle[] = [];
  if (opts.home) {
    L.add.push(ellipse(0, 0, rx * 0.92, ry * 0.92));
    for (let i = 0; i < 2; i++) {
      const a = r() * 6.28;
      L.add.push(
        ellipse(
          Math.cos(a) * rx * 0.4,
          Math.sin(a) * ry * 0.4,
          rx * between(r, 0.55, 0.65),
          ry * between(r, 0.55, 0.65),
          r() * 3,
        ),
      );
    }
    coastFeatures(r, rx, ry, L, {
      capes: [1, 2],
      coves: [1, 1],
      coveR: [0.1, 0.15],
    });
    islets(r, rx, ry, L, 2 + Math.floor(r() * 2));
  } else KINDS[kind](r, rx, ry, L);
  if (opts.harbour) {
    const { x: hx, y: hy } = opts.harbour;
    const n0 = Math.hypot(opts.harbour.nx || 0, opts.harbour.ny || 1);
    const nx = (opts.harbour.nx || 0) / n0;
    const ny = (opts.harbour.ny ?? 1) / n0;
    const tx = -ny;
    const ty = nx;
    const Rb = opts.harbour.r || R * 0.16;
    const bx = hx + nx * (Rb + 90);
    const by = hy + ny * (Rb + 90);
    const w = R * 0.1;
    for (const sd of [-1, 1]) {
      const lean = sd < 0 ? 0.25 : -0.15;
      L.add.push(
        curvedSpine([
          [hx + tx * sd * Rb * 0.9, hy + ty * sd * Rb * 0.9, w * 2],
          [bx + tx * sd * Rb * 1.35, by + ty * sd * Rb * 1.35, w * 1.2],
          [
            bx + nx * Rb * (0.6 + lean) + tx * sd * Rb * 1.05,
            by + ny * Rb * (0.6 + lean) + ty * sd * Rb * 1.05,
            w * 0.8,
          ],
          [
            bx + nx * Rb * (0.95 + lean) + tx * sd * Rb * 0.55,
            by + ny * Rb * (0.95 + lean) + ty * sd * Rb * 0.55,
            w * 0.55,
          ],
        ]),
      );
    }
    L.sub.push(ellipse(bx, by, Rb * 1.15, Rb, Math.atan2(ty, tx)));
    quiet.push({ x: bx, y: by, r: Rb * 2.6 });
    L.sub.push(
      curvedSpine([
        [bx, by, Rb * 0.3],
        [
          bx + nx * Rb * 1.6 - tx * Rb * 0.15,
          by + ny * Rb * 1.6 - ty * Rb * 0.15,
          Rb * 0.32,
        ],
        [bx + nx * Rb * 2.4, by + ny * Rb * 2.4, Rb * 0.5],
      ]),
    );
  }
  const keep = (opts.keep ?? []).map(zonePrim);
  const cut = (opts.cut ?? []).map(zonePrim);
  // orientation: home stays as placed; others turn a little and may mirror
  const rot =
    opts.home || opts.rot === 0
      ? 0
      : opts.rot != null
        ? opts.rot
        : between(r, -0.55, 0.55);
  const mir = !opts.home && r() < 0.5 ? -1 : 1;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const ox = r() * 500;
  const oy = r() * 500;
  const ks = R * 0.14;
  const kb = R * 0.08;
  const W = R * 0.15;
  const WL = R * 0.85;
  const N0 = R * 0.5;
  function outline(x: number, y: number): number {
    const wx = x + W * (2 * fbmShape(x / WL + ox, y / WL + oy, 2) - 1);
    const wy =
      y + W * (2 * fbmShape(x / WL + oy + 40, y / WL + ox - 30, 2) - 1);
    const u = (wx * cr + wy * sr) * mir;
    const v = -wx * sr + wy * cr;
    let d = 1e9;
    for (const p of L.add) {
      if (boxDist(p, u, v) > d + ks) continue;
      d = smin(d, p.d(u, v), ks);
    }
    for (const p of L.sub) {
      if (boxDist(p, u, v) > kb - d) continue;
      d = -smin(-d, p.d(u, v), kb);
    }
    const n = fbmShape(x / N0 + oy, y / N0 + ox, 4, 0.5) - 0.5;
    d += n * R * 0.26 * clamp(1 - Math.abs(d) / (R * 0.5), 0.15, 1);
    for (const p of keep) d = Math.min(d, p.d(x, y) - 1);
    for (const p of cut) d = Math.max(d, -p.d(x, y) + 1);
    return d;
  }
  // the grid: the layout's box (rotated), plus noise, plus the sea margin
  let bx0 = 1e9;
  let by0 = 1e9;
  let bx1 = -1e9;
  let by1 = -1e9;
  const growB = (x: number, y: number) => {
    bx0 = Math.min(bx0, x);
    by0 = Math.min(by0, y);
    bx1 = Math.max(bx1, x);
    by1 = Math.max(by1, y);
  };
  for (const p of L.add) {
    const [a0, b0, a1, b1] = p.box;
    for (const [u, v] of [
      [a0, b0],
      [a1, b0],
      [a0, b1],
      [a1, b1],
    ] as const) {
      growB(u * mir * cr - v * sr, u * mir * sr + v * cr);
    }
  }
  for (const p of keep) {
    growB(p.box[0], p.box[1]);
    growB(p.box[2], p.box[3]);
  }
  const C = opts.cell || 24;
  const pad = R * 0.2 + W + S * 0.6 + 2 * C;
  const gx0 = Math.floor((bx0 - pad) / C) * C;
  const gy0 = Math.floor((by0 - pad) / C) * C;
  const gw = Math.ceil((bx1 + pad - gx0) / C) + 1;
  const gh = Math.ceil((by1 + pad - gy0) / C) + 1;
  const NC = gw * gh;
  // a quick polar profile from the outline itself (72 rays marched inward)
  const NR = 72;
  const pre = new Float32Array(NR);
  const far0 =
    Math.max(
      Math.hypot(bx0, by0),
      Math.hypot(bx1, by0),
      Math.hypot(bx0, by1),
      Math.hypot(bx1, by1),
    ) +
    R * 0.2 +
    W;
  for (let q = 0; q < NR; q++) {
    const a = (q / NR) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let d = far0;
    while (d > 0) {
      const o = outline(ca * d, sa * d);
      if (o < 0) break;
      d -= Math.max(30, Math.min(o * 0.6, 240));
    }
    pre[q] = Math.max(d, 0);
  }
  const preRadius = (a: number) => {
    const t = ((((a / (Math.PI * 2)) * NR) % NR) + NR) % NR;
    const i = Math.floor(t);
    const f = t - i;
    return lerp(pre[i % NR]!, pre[(i + 1) % NR]!, f);
  };

  let shape: IslandShape | null = null;
  let shapeData: IslandShapeData | null = null;
  let running: Generator<void, IslandShape, void> | null = null;

  function* steps(): Generator<void, IslandShape, void> {
    if (shape) return shape;
    // 1. the outline on the grid — fully only near the coast: a 4× coarser pass first
    const D = new Float32Array(NC);
    const Q = 4;
    const qw = Math.ceil(gw / Q) + 1;
    const qh = Math.ceil(gh / Q) + 1;
    const DQ = new Float32Array(qw * qh);
    for (let j = 0; j < qh; j++)
      for (let i = 0; i < qw; i++)
        DQ[j * qw + i] = outline(gx0 + i * Q * C, gy0 + j * Q * C);
    const far = Q * C * 1.6 + R * 0.06;
    yield;
    for (let j = 0; j < gh; j++) {
      const jq = Math.min(qh - 2, (j / Q) | 0);
      const fy = j / Q - jq;
      for (let i = 0; i < gw; i++) {
        const iq = Math.min(qw - 2, (i / Q) | 0);
        const fx = i / Q - iq;
        const a = DQ[jq * qw + iq]!;
        const b = DQ[jq * qw + iq + 1]!;
        const c = DQ[(jq + 1) * qw + iq]!;
        const d = DQ[(jq + 1) * qw + iq + 1]!;
        const m = Math.min(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
        D[j * gw + i] =
          m > far && a > 0 === b > 0 && a > 0 === c > 0 && a > 0 === d > 0
            ? a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
            : outline(gx0 + i * C, gy0 + j * C);
      }
    }
    yield;
    // 2. land mask, cleaned: specks of land go, enclosed ponds go
    const land = new Uint8Array(NC);
    for (let k = 0; k < NC; k++) land[k] = D[k]! < 0 ? 1 : 0;
    const comp = new Int32Array(NC).fill(-1);
    const comps: { land: number; n: number; edge: boolean; peak: number }[] =
      [];
    const stack = new Int32Array(NC);
    for (let k0 = 0; k0 < NC; k0++) {
      if (comp[k0]! >= 0) continue;
      const id = comps.length;
      const L0 = land[k0]!;
      let sp = 0;
      let n = 0;
      let edge = false;
      let best = 0;
      let bestK = k0;
      stack[sp++] = k0;
      comp[k0] = id;
      while (sp) {
        const k = stack[--sp]!;
        const i = k % gw;
        const j = (k / gw) | 0;
        n++;
        if (i === 0 || j === 0 || i === gw - 1 || j === gh - 1) edge = true;
        if (-D[k]! > best) {
          best = -D[k]!;
          bestK = k;
        }
        if (i > 0 && comp[k - 1]! < 0 && land[k - 1] === L0) {
          comp[k - 1] = id;
          stack[sp++] = k - 1;
        }
        if (i < gw - 1 && comp[k + 1]! < 0 && land[k + 1] === L0) {
          comp[k + 1] = id;
          stack[sp++] = k + 1;
        }
        if (j > 0 && comp[k - gw]! < 0 && land[k - gw] === L0) {
          comp[k - gw] = id;
          stack[sp++] = k - gw;
        }
        if (j < gh - 1 && comp[k + gw]! < 0 && land[k + gw] === L0) {
          comp[k + gw] = id;
          stack[sp++] = k + gw;
        }
      }
      comps.push({ land: L0, n, edge, peak: bestK });
    }
    const flip = comps.map((c) => (c.land ? c.n < 10 : !c.edge));
    for (let k = 0; k < NC; k++) if (flip[comp[k]!]) land[k] = land[k]! ^ 1;
    let mainId = -1;
    comps.forEach((c, id) => {
      if (c.land && !flip[id] && (mainId < 0 || c.n > comps[mainId]!.n))
        mainId = id;
    });
    yield;
    // 3. signed distance to the coast: sub-cell seeds on every land/sea edge, then propagation
    const PX = new Float64Array(NC);
    const PY = new Float64Array(NC);
    const DD = new Float64Array(NC).fill(Infinity);
    const coast: CoastPoint[] = [];
    const seed1 = (k: number, x: number, y: number) => {
      const dx = x - (k % gw) * C;
      const dy = y - ((k / gw) | 0) * C;
      const d2 = dx * dx + dy * dy;
      if (d2 < DD[k]!) {
        DD[k] = d2;
        PX[k] = x;
        PY[k] = y;
      }
    };
    const edgeAt = (
      k: number,
      k2: number,
      i: number,
      j: number,
      di: number,
      dj: number,
    ) => {
      if (land[k] === land[k2]) return;
      const a = D[k]!;
      const b = D[k2]!;
      const t =
        a < 0 !== b < 0 && a < 0 === !!land[k] ? clamp(a / (a - b), 0, 1) : 0.5;
      const x = (i + di * t) * C;
      const y = (j + dj * t) * C;
      seed1(k, x, y);
      seed1(k2, x, y);
      const sgn = land[k] ? 1 : -1;
      coast.push({
        x: x + gx0,
        y: y + gy0,
        nx: di * sgn,
        ny: dj * sgn,
        main: comp[land[k] ? k : k2] === mainId,
      });
    };
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        if (i + 1 < gw) edgeAt(k, k + 1, i, j, 1, 0);
        if (j + 1 < gh) edgeAt(k, k + gw, i, j, 0, 1);
      }
    }
    for (let j = 0; j < gh; j++) edtRow(DD, PX, PY, gw, gh, C, j, true);
    for (let j = gh - 1; j >= 0; j--) edtRow(DD, PX, PY, gw, gh, C, j, false);
    yield;
    // 4. height: distance over a slope that wanders a little, rising to a plateau inland
    const Hmax = 1.0;
    const H = new Float32Array(NC);
    let lx0 = 1e9;
    let ly0 = 1e9;
    let lx1 = -1e9;
    let ly1 = -1e9;
    let sx0 = 1e9;
    let sy0 = 1e9;
    let sx1 = -1e9;
    let sy1 = -1e9;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        const x = gx0 + i * C;
        const y = gy0 + j * C;
        const d = Math.sqrt(DD[k]!);
        const sd = land[k] ? d : -d;
        const s =
          S *
          (0.75 + 0.55 * vnoise(x / (R * 0.45) + ox + 3, y / (R * 0.45) + oy));
        H[k] = sd > 0 ? Hmax * (1 - Math.exp(-sd / (s * Hmax))) : sd / s;
        if (land[k]) {
          lx0 = Math.min(lx0, x);
          ly0 = Math.min(ly0, y);
          lx1 = Math.max(lx1, x);
          ly1 = Math.max(ly1, y);
        }
        if (H[k]! > -0.5) {
          sx0 = Math.min(sx0, x);
          sy0 = Math.min(sy0, y);
          sx1 = Math.max(sx1, x);
          sy1 = Math.max(sy1, y);
        }
      }
    }
    yield;
    // nearest-land-component per cell, for isMain (sea cells take their nearest coast's)
    const owner = new Int32Array(NC);
    for (let k = 0; k < NC; k++) {
      if (land[k]) {
        owner[k] = comp[k]!;
        continue;
      }
      const i = Math.round(PX[k]! / C);
      const j = Math.round(PY[k]! / C);
      let o = -1;
      for (let q = 0; q < 5 && o < 0; q++) {
        const ii = i + (q === 1 ? 1 : q === 2 ? -1 : 0);
        const jj = j + (q === 3 ? 1 : q === 4 ? -1 : 0);
        if (ii >= 0 && jj >= 0 && ii < gw && jj < gh && land[jj * gw + ii])
          o = comp[jj * gw + ii]!;
      }
      owner[k] = o;
    }
    yield;
    // polar profile: farthest land along each of 256 directions, islets included
    const NA = 256;
    const prof = new Float32Array(NA);
    for (let k = 0; k < NC; k++) {
      if (!land[k]) continue;
      const x = gx0 + (k % gw) * C;
      const y = gy0 + ((k / gw) | 0) * C;
      const a = Math.atan2(y, x);
      const rr = Math.hypot(x, y) + C;
      const ai = (Math.round((a / (Math.PI * 2)) * NA) + NA) % NA;
      for (let o = -1; o <= 1; o++) {
        const q = (ai + o + NA) % NA;
        if (rr > prof[q]!) prof[q] = rr;
      }
    }
    const heartK = comps[mainId] ? comps[mainId]!.peak : 0;
    if (shape) return shape; // restored meanwhile (between two yields)
    shapeData = {
      H,
      comp,
      owner,
      prof,
      coast,
      mainId,
      heartK,
      bbox: [sx0, sy0, sx1, sy1],
      landBox: [lx0, ly0, lx1, ly1],
    };
    shape = assemble(shapeData);
    return shape;
  }

  function assemble({
    H,
    comp,
    owner,
    prof,
    coast,
    mainId,
    heartK,
    bbox,
    landBox,
  }: IslandShapeData): IslandShape {
    const height = heightOf(H, gx0, gy0, gw, gh, C, seed % 1000, S);
    const cellOf = (x: number, y: number) => {
      const i = Math.round((x - gx0) / C);
      const j = Math.round((y - gy0) / C);
      return i < 0 || j < 0 || i >= gw || j >= gh ? -1 : j * gw + i;
    };
    const NA = prof.length;
    const noLand: Circle[] = (opts.cut ?? [])
      .map((c): Circle | null =>
        "pts" in c ? null : { x: c.x, y: c.y, r: (c.r || 0) + 320 },
      )
      .filter((c): c is Circle => c !== null)
      .concat(opts.noLanding ?? [], quiet);
    const mainCoast = coast.filter(
      (p) =>
        p.main && noLand.every((z) => Math.hypot(p.x - z.x, p.y - z.y) > z.r),
    );
    function coastToward(x: number, y: number): Pt {
      let best: CoastPoint | null = null;
      let bd = 1e18;
      for (const p of mainCoast) {
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (!best)
        throw new Error(`island ${seed}: no landing coast on its main body`);
      return [best.x, best.y];
    }
    function landingToward(x: number, y: number, level = 0.1, inset = 36): Pt {
      let [px, py] = coastToward(x, y);
      for (let n = 0; n < 200; n++) {
        const e = 8;
        const gxv = height(px + e, py) - height(px - e, py);
        const gyv = height(px, py + e) - height(px, py - e);
        const L = Math.hypot(gxv, gyv) || 1;
        if (height(px, py) > level) {
          inset -= 6;
          if (inset <= 0) break;
        }
        px += (gxv / L) * 6;
        py += (gyv / L) * 6;
      }
      return [px, py];
    }
    const heart: Pt = [gx0 + (heartK % gw) * C, gy0 + ((heartK / gw) | 0) * C];
    // A district wants room round it — its streets run east and west — so a
    // candidate is scored by the lowest height at it and ~450 px east and west
    // (~250 px north and south), then picked by farthest-point sampling.
    const Hat = (k: number, di: number, dj: number) => {
      const i = (k % gw) + di;
      const j = ((k / gw) | 0) + dj;
      return i < 0 || j < 0 || i >= gw || j >= gh ? -1 : H[j * gw + i]!;
    };
    const ex = Math.round(450 / C);
    const ey = Math.round(250 / C);
    function sites(n: number, minH = 0.3, minD = 500): Pt[] {
      const cand: number[] = [];
      const room: number[] = [];
      for (let k = 0; k < NC; k++) {
        if (
          comp[k] === mainId &&
          H[k]! > minH &&
          (k % gw) % 2 === 0 &&
          ((k / gw) | 0) % 2 === 0
        ) {
          cand.push(k);
          room.push(
            Math.min(
              H[k]!,
              Hat(k, ex, 0),
              Hat(k, -ex, 0),
              Hat(k, 0, ey),
              Hat(k, 0, -ey),
            ),
          );
        }
      }
      const out: Pt[] = [];
      const md = new Float32Array(cand.length).fill(1e18);
      const P = (k: number): Pt => [
        gx0 + (k % gw) * C,
        gy0 + ((k / gw) | 0) * C,
      ];
      let cur = -1;
      let bv0 = -1;
      cand.forEach((k, ci) => {
        if (room[ci]! > bv0) {
          bv0 = room[ci]!;
          cur = k;
        }
      });
      for (let s = 0; s < n && cur >= 0; s++) {
        const [cx, cy] = P(cur);
        out.push([cx, cy]);
        let bi = -1;
        let bv = -1;
        cand.forEach((k, ci) => {
          const [x, y] = P(k);
          const d = Math.hypot(x - cx, y - cy);
          if (d < md[ci]!) md[ci] = d;
          if (md[ci]! < minD || room[ci]! <= 0) return;
          const v = Math.min(md[ci]!, 1100) * room[ci]!;
          if (v > bv) {
            bv = v;
            bi = ci;
          }
        });
        cur = bi < 0 ? -1 : cand[bi]!;
      }
      return out.length >= n
        ? out
        : minH > 0.2
          ? sites(n, minH - 0.08, minD)
          : minD > 250
            ? sites(n, 0.3, minD - 125)
            : out;
    }
    return {
      kind: opts.home ? "home" : kind,
      seed,
      slope: S,
      height,
      isMain(x, y) {
        const k = cellOf(x, y);
        return k >= 0 && owner[k] === mainId;
      },
      radiusTo(a) {
        const t = ((((a / (Math.PI * 2)) * NA) % NA) + NA) % NA;
        const i = Math.floor(t);
        const f = t - i;
        return lerp(prof[i % NA]!, prof[(i + 1) % NA]!, f);
      },
      coastToward,
      landingToward,
      sites,
      heart,
      coast,
      bbox,
      land: landBox,
    };
  }

  return {
    kind: opts.home ? "home" : kind,
    seed,
    box: [gx0, gy0, gx0 + (gw - 1) * C, gy0 + (gh - 1) * C],
    radiusTo: preRadius,
    build() {
      if (shape) return shape;
      running ??= steps();
      let res = running.next();
      while (!res.done) res = running.next();
      running = null;
      return res.value;
    },
    steps() {
      return steps();
    },
    data() {
      if (!shapeData) {
        if (shape)
          throw new Error(
            `island ${seed}: restored from data, it has none of its own to give`,
          );
        this.build();
      }
      return shapeData!;
    },
    built() {
      return shape !== null;
    },
    restore(d) {
      if (shape) return shape;
      shapeData = d;
      shape = assemble(d);
      return shape;
    },
  };
}
