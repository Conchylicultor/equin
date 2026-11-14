// Drawing helpers (sprite space: 1 unit = 1 world px). A Path adds a shape to
// the current path; part / limb fill and ink it with cel shading.

import type { Ctx2D } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import { mix } from "./colour";

export type Point = readonly [number, number];
export type Path = (g: Ctx2D) => void;
/** One piece of a limb: its path and colour, in paint order. */
export interface Seg {
  readonly p: Path;
  readonly c: string;
}

export const TAU = Math.PI * 2;
export const INK = "rgba(44,32,24,.92)";
const LW = 0.75;

const BIG: Path = (g) => g.rect(-99, -99, 198, 198);

interface PartOpt {
  readonly shade?: number;
  readonly off?: number;
  readonly ink?: boolean;
  readonly lw?: number;
}

/** A filled part with cel shading: rim shadow bottom-right, a soft highlight top-left, then ink. */
export function part(
  g: Ctx2D,
  path: Path,
  fill: string,
  opt: PartOpt = {},
): void {
  const sh = opt.shade ?? 0.3;
  const off = opt.off ?? 1.1;
  g.beginPath();
  path(g);
  g.fillStyle = fill;
  g.fill();
  g.save();
  g.beginPath();
  path(g);
  g.clip();
  g.fillStyle = mix(fill, -sh);
  g.fillRect(-60, -80, 120, 120);
  g.translate(-off, -off * 0.8);
  g.beginPath();
  path(g);
  g.fillStyle = fill;
  g.fill();
  g.translate(-off * 0.6, -off * 0.6);
  g.globalAlpha = 0.22;
  g.beginPath();
  path(g);
  g.fillStyle = mix(fill, 0.35);
  g.translate(off * 1.7, off * 1.5);
  g.fill();
  g.restore();
  if (opt.ink !== false) {
    g.beginPath();
    path(g);
    g.strokeStyle = INK;
    g.lineWidth = opt.lw ?? LW;
    g.lineJoin = "round";
    g.stroke();
  }
}

/** Tapered capsule a to b with radii r1, r2. */
export const capsule =
  (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    r1: number,
    r2: number,
  ): Path =>
  (g) => {
    const a = Math.atan2(by - ay, bx - ax);
    const n = a + Math.PI / 2;
    g.moveTo(ax + Math.cos(n) * r1, ay + Math.sin(n) * r1);
    g.lineTo(bx + Math.cos(n) * r2, by + Math.sin(n) * r2);
    g.arc(bx, by, r2, n, n + Math.PI, true);
    g.lineTo(ax - Math.cos(n) * r1, ay - Math.sin(n) * r1);
    g.arc(ax, ay, r1, n + Math.PI, n, true);
    g.closePath();
  };

export const ell =
  (x: number, y: number, rx: number, ry: number, rot = 0): Path =>
  (g) =>
    g.ellipse(x, y, rx, ry, rot, 0, TAU);

export const poly =
  (pts: readonly Point[]): Path =>
  (g) => {
    const [first, ...rest] = pts;
    if (!first) throw new Error("characters: poly needs points");
    g.moveTo(first[0], first[1]);
    for (const p of rest) g.lineTo(p[0], p[1]);
    g.closePath();
  };

/** Closed smooth shape through points. */
export const smooth =
  (pts: readonly Point[]): Path =>
  (g) => {
    const n = pts.length;
    const at = (i: number): Point => {
      const p = pts[i % n];
      if (!p) throw new Error("characters: smooth needs points");
      return p;
    };
    const mid = (i: number): Point => {
      const a = at(i);
      const b = at(i + 1);
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    };
    let m = mid(n - 1);
    g.moveTo(m[0], m[1]);
    for (let i = 0; i < n; i++) {
      m = mid(i);
      const c = at(i);
      g.quadraticCurveTo(c[0], c[1], m[0], m[1]);
    }
    g.closePath();
  };

interface LimbOpt {
  readonly shade?: number;
  readonly off?: number;
  readonly lw?: number;
  /** Inside `body` the outline fades out towards `at`, so the limb grows out of the torso. */
  readonly merge?: {
    readonly at: Point;
    readonly r: number;
    readonly body: Path;
  };
  /** Extra paths counted as "inside" when shading (where the limb merges into a body). */
  readonly lit?: readonly Path[];
}

/**
 * ONE shape out of overlapping pieces — a whole arm, a whole leg. A single outline goes round the
 * union of the pieces and the cel shading is taken on the union, so nothing shows where two pieces
 * meet: elbows and knees bend, they are not pinned.
 */
export function limb(g: Ctx2D, segs: readonly Seg[], opt: LimbOpt = {}): void {
  const off = opt.off ?? 0.75;
  const sh = opt.shade ?? 0.3;
  const lw = opt.lw ?? LW;
  // 1. outline pass: every piece stroked at twice the width; the fills then cover its inner half
  const stroke = (style: string | CanvasGradient) => {
    g.beginPath();
    for (const s of segs) s.p(g);
    g.strokeStyle = style;
    g.lineWidth = lw * 1.7;
    g.lineJoin = "round";
    g.stroke();
  };
  if (opt.merge) {
    const { at, r, body } = opt.merge;
    g.save();
    g.beginPath();
    BIG(g);
    body(g);
    g.clip("evenodd");
    stroke(INK);
    g.restore();
    const fade = g.createRadialGradient(
      at[0],
      at[1],
      r * 0.45,
      at[0],
      at[1],
      r,
    );
    fade.addColorStop(0, "rgba(44,32,24,0)");
    fade.addColorStop(1, INK);
    g.save();
    g.beginPath();
    body(g);
    g.clip();
    stroke(fade);
    g.restore();
  } else stroke(INK);
  // 2. fill pass: each piece in its shadow tone, then lit wherever the whole union, shifted up-left, still covers it
  const lit = segs.map((s) => s.p).concat(opt.lit ?? []);
  const fillAll = (col: string) => {
    g.fillStyle = col;
    for (const p of lit) {
      g.beginPath();
      p(g);
      g.fill();
    }
  };
  for (const s of segs) {
    g.save();
    g.beginPath();
    s.p(g);
    g.clip();
    g.fillStyle = mix(s.c, -sh);
    g.fillRect(-99, -99, 198, 198);
    g.translate(-off, -off * 0.8);
    fillAll(s.c);
    g.translate(-off * 0.6, -off * 0.6);
    g.globalAlpha = 0.22;
    fillAll(mix(s.c, 0.35));
    g.restore();
  }
}

/** Soft cloth / skin line — a fold, a seam, a crease — never a dark band. */
export function softLine(
  g: Ctx2D,
  a: Point,
  c: Point,
  b: Point,
  alpha: number,
  w = 0.42,
): void {
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.quadraticCurveTo(c[0], c[1], b[0], b[1]);
  g.strokeStyle = `rgba(44,32,24,${alpha})`;
  g.lineWidth = w;
  g.lineCap = "round";
  g.stroke();
  g.lineCap = "butt";
}

export const unit = (a: Point, b: Point): Point => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
};

/** A seam across a limb at m (the end of a sleeve, a trouser cuff), bowing down the limb along `dir`. */
export function seam(
  g: Ctx2D,
  m: Point,
  dir: Point,
  r: number,
  alpha = 0.3,
): void {
  const n: Point = [-dir[1], dir[0]];
  softLine(
    g,
    [m[0] + n[0] * r * 0.85, m[1] + n[1] * r * 0.85],
    [m[0] + dir[0] * r * 0.6, m[1] + dir[1] * r * 0.6],
    [m[0] - n[0] * r * 0.85, m[1] - n[1] * r * 0.85],
    alpha,
    0.38,
  );
}

/** The crease on the inside of a bent joint j (between a and b), stronger the more it bends. */
export function crease(
  g: Ctx2D,
  j: Point,
  a: Point,
  b: Point,
  r: number,
  bend: number,
): void {
  if (bend < 0.25) return;
  const u = unit(j, a);
  const f = unit(j, b);
  const bi = unit([0, 0], [u[0] + f[0], u[1] + f[1]]);
  const n: Point = [-bi[1], bi[0]];
  const p0: Point = [j[0] + bi[0] * r * 0.95, j[1] + bi[1] * r * 0.95];
  const p1: Point = [
    j[0] + bi[0] * r * 0.2 + n[0] * 0.3,
    j[1] + bi[1] * r * 0.2 + n[1] * 0.3,
  ];
  softLine(
    g,
    p0,
    [(p0[0] + p1[0]) / 2 + n[0] * 0.35, (p0[1] + p1[1]) / 2 + n[1] * 0.35],
    p1,
    Math.min(0.32, 0.12 + bend * 0.2),
  );
}
