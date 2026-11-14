// The ground's per-pixel colour, apart from the canvas: water / sand / grass /
// hills coloured from the island heights, and the water mask (where animated
// water may paint). Pure arithmetic over the world into byte arrays — no DOM —
// so the very same code runs on the page and in the bake workers
// (`bake.worker.ts`): a tile coloured in a worker is bit-identical to one
// coloured here. The texture drawn over it (surf, grass, pebbles, …) is
// canvas work and stays in `ground.ts`.

import {
  fbm,
  vnoise,
  type Island,
  type WorldModel,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import { ss } from "./kit";

/** A ground tile's side, world px. */
export const GT = 512;
/** World px per ground pixel: a tile's colour is baked at half resolution (plus a 1 px margin). */
const S = 2;

export type Rgb = [number, number, number];
const hex = (h: string): Rgb => {
  const n = parseInt(h.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
export const mixTo = (o: Rgb, a: Rgb, b: Rgb, t: number): Rgb => {
  o[0] = a[0] + (b[0] - a[0]) * t;
  o[1] = a[1] + (b[1] - a[1]) * t;
  o[2] = a[2] + (b[2] - a[2]) * t;
  return o;
};

export const DEEP_C = hex("#2d6c9b");
export const ABYSS_C = hex("#25608f");
const G_DARK = hex("#66713d");
const G_LIGHT = hex("#a2a663");
const G_DEEP = hex("#55612f");
const DRY = hex("#bab27a");
const DIRT = hex("#b9a77b");
const EDGE = hex("#5d6836");
const SAND1 = hex("#dccca0");
const SAND2 = hex("#cbb688");
const WET = hex("#b5a47e");
const SHAL = hex("#93c6cf");
const MID = hex("#4f90b8");
const FOAM: Rgb = [236, 242, 238];
const LIGHT_T: Rgb = [178, 176, 116];
const DARK_T: Rgb = [86, 98, 50];
const TUFT_EDGE: Rgb = [70, 74, 40];
const DIRT_EDGE: Rgb = [92, 82, 54];
const BANK: Rgb = [52, 50, 30];
const HILL_LIT: Rgb = [214, 206, 150];
const HILL_SHADE: Rgb = [58, 64, 34];
const CONTOUR: Rgb = [70, 66, 40];

export type HeightFn = (x: number, y: number) => number;
type PixelFn = (
  X: number,
  Y: number,
  d: Uint8ClampedArray,
  i: number,
) => number;

/** → (X, Y, data, i): writes the colour of world point (X, Y); `E` = hill elevation. */
function groundPixel(H: HeightFn, E: HeightFn | null): PixelFn {
  const col: Rgb = [0, 0, 0];
  return (X, Y, d, i) => {
    const hv = H(X, Y);
    if (hv < -0.47) {
      d[i + 3] = 0; // open sea: the ocean texture shows through
      return hv;
    }
    const grain = vnoise(X / 3.1, Y / 3.1) - 0.5;
    let alpha = 255;
    if (hv < 0.02) {
      const dep = Math.max(0, -hv);
      const streak = vnoise(X / 70, Y / 14) - 0.5;
      const wob = fbm(X / 90, Y / 90, 2) - 0.5;
      if (dep < 0.1) mixTo(col, SHAL, MID, ss(0, 0.1, dep + wob * 0.04));
      else if (dep < 0.3)
        mixTo(col, MID, DEEP_C, ss(0.1, 0.3, dep + wob * 0.07));
      else mixTo(col, DEEP_C, ABYSS_C, ss(0.3, 0.65, dep));
      for (let k = 0; k < 3; k++) col[k] = col[k]! + streak * 14 + grain * 6;
      if (hv > -0.012) mixTo(col, col, FOAM, ss(-0.012, 0.02, hv) * 0.6);
      alpha = Math.round((1 - ss(0.26, 0.46, dep)) * 255);
    } else if (hv < 0.075) {
      const n = fbm(X / 40, Y / 40, 2);
      mixTo(col, SAND1, SAND2, n);
      if (hv < 0.032) mixTo(col, WET, col, ss(0.02, 0.032, hv));
      for (let k = 0; k < 3; k++) col[k] = col[k]! + grain * 12;
    } else {
      const m = fbm(X / 230 + 9, Y / 230, 3);
      const p = fbm(X / 85 + 3, Y / 85 + 7, 3);
      const dry = fbm(X / 160 + 20, Y / 160, 3);
      const q = vnoise(X / 18, Y / 18);
      mixTo(col, G_DARK, G_LIGHT, ss(0.3, 0.75, m * 0.8 + q * 0.2));
      if (p < 0.34) mixTo(col, col, G_DEEP, ss(0.34, 0.24, p) * 0.8);
      if (dry > 0.57) mixTo(col, col, DRY, ss(0.57, 0.68, dry) * 0.75);
      if (p > 0.66) mixTo(col, col, DIRT, ss(0.66, 0.7, p) * 0.9);
      const f2 = fbm(X / 34 + 11, Y / 34 + 5, 2);
      if (f2 > 0.62) mixTo(col, col, LIGHT_T, ss(0.62, 0.66, f2) * 0.55);
      else if (f2 < 0.3) mixTo(col, col, DARK_T, ss(0.3, 0.26, f2) * 0.5);
      if (Math.abs(f2 - 0.62) < 0.007 || Math.abs(f2 - 0.3) < 0.006)
        mixTo(col, col, TUFT_EDGE, 0.35);
      if (Math.abs(p - 0.66) < 0.006) mixTo(col, col, DIRT_EDGE, 0.55);
      if (hv < 0.095)
        mixTo(col, col, EDGE, ss(0.095, 0.078, hv + (q - 0.5) * 0.02) * 0.85);
      if (hv < 0.084) mixTo(col, col, BANK, ss(0.084, 0.077, hv) * 0.7);
      if (E) {
        const e = E(X, Y);
        if (e > 0.04) {
          // a hill: lit from the north-west, drier on top, ink contour lines round it
          const ex = (E(X + 6, Y) - E(X - 6, Y)) / 12;
          const ey = (E(X, Y + 6) - E(X, Y - 6)) / 12;
          const gl = Math.hypot(ex, ey);
          const lit = (-ex - ey * 0.8) * 260;
          if (lit > 0) mixTo(col, col, HILL_LIT, Math.min(0.5, lit * 0.45));
          else mixTo(col, col, HILL_SHADE, Math.min(0.45, -lit * 0.5));
          mixTo(col, col, DRY, ss(0.5, 0.95, e) * 0.28);
          const lv = e * 7;
          const fr = lv - Math.floor(lv);
          const dpx = Math.min(fr, 1 - fr) / Math.max(1e-5, 7 * gl);
          if (Math.floor(lv) >= 1 && dpx < 1.3)
            mixTo(col, col, CONTOUR, 0.42 * (1 - dpx / 1.3));
        }
      }
      for (let k = 0; k < 3; k++) col[k] = col[k]! + grain * 16;
    }
    d[i] = col[0];
    d[i + 1] = col[1];
    d[i + 2] = col[2];
    d[i + 3] = alpha;
    return hv;
  };
}

/** The highest island height at a point, over a set of islands (open sea: -1). */
export function heightOver(
  M: WorldModel,
  islands: readonly Island[],
): HeightFn {
  return (X, Y) => M.heightAt(X, Y, islands);
}

/** The highest hill elevation at a point, over the islands that have hills. */
export function elevationOver(
  M: WorldModel,
  islands: readonly Island[],
): HeightFn {
  return (X, Y) => {
    let e = 0;
    for (const I of islands) {
      if (!I.hills.length) continue;
      const b = I.bounds;
      if (X > b[0] && X < b[2] && Y > b[1] && Y < b[3])
        e = Math.max(e, M.elevation(I, X, Y));
    }
    return e;
  };
}

/** The islands whose heights reach tile (tx, ty): their bounds within 140 px of it. */
export function islandsNearTile(
  islands: readonly Island[],
  tx: number,
  ty: number,
): Island[] {
  const X0 = tx * GT;
  const Y0 = ty * GT;
  return islands.filter((I) => {
    const [bx0, by0, bx1, by1] = I.bounds;
    return !(
      bx1 < X0 - 140 ||
      bx0 > X0 + GT + 140 ||
      by1 < Y0 - 140 ||
      by0 > Y0 + GT + 140
    );
  });
}

/** A pixel grid being coloured a band of rows at a time. */
export interface PixelKernel {
  readonly w: number;
  readonly h: number;
  /** RGBA, w × h. */
  readonly img: Uint8ClampedArray<ArrayBuffer>;
  /** Colours rows [y0, y1). */
  rows(y0: number, y1: number): void;
}

/** A ground tile's colour (`img`) and water mask (`mask`, alpha only), (GT / 2 + 2)² px with a 1 px margin. */
export interface GroundKernel extends PixelKernel {
  readonly mask: Uint8ClampedArray<ArrayBuffer>;
}

export function groundKernel(
  M: WorldModel,
  tx: number,
  ty: number,
  near: readonly Island[],
): GroundKernel {
  const X0 = tx * GT;
  const Y0 = ty * GT;
  const n = GT / S + 2;
  const H = heightOver(M, near);
  const E = near.some((J) => J.hills.length) ? elevationOver(M, near) : null;
  const px = groundPixel(H, E);
  const img = new Uint8ClampedArray(n * n * 4);
  const mask = new Uint8ClampedArray(n * n * 4);
  return {
    w: n,
    h: n,
    img,
    mask,
    rows(y0, y1) {
      for (let y = y0; y < y1; y++)
        for (let x = 0; x < n; x++) {
          const i = (y * n + x) * 4;
          const hv = px(X0 + (x - 1) * S, Y0 + (y - 1) * S, img, i);
          mask[i + 3] = Math.round((1 - ss(0, 0.02, hv)) * 255);
        }
    },
  };
}

/** An island's coarse preview, 1 px per {@link PREVIEW_Q} world px, from (x, y). */
export interface PreviewKernel extends PixelKernel {
  readonly x: number;
  readonly y: number;
}

export const PREVIEW_Q = 8;

export function previewKernel(M: WorldModel, I: Island): PreviewKernel {
  const Q = PREVIEW_Q;
  const [bx0, by0, bx1, by1] = I.bounds;
  const X0 = Math.floor(bx0);
  const Y0 = Math.floor(by0);
  const qw = Math.ceil((bx1 - bx0) / Q);
  const qh = Math.ceil((by1 - by0) / Q);
  const px = groundPixel(
    (X, Y) => M.height(I, X, Y),
    (X, Y) => M.elevation(I, X, Y),
  );
  const img = new Uint8ClampedArray(qw * qh * 4);
  return {
    w: qw,
    h: qh,
    x: X0,
    y: Y0,
    img,
    rows(y0, y1) {
      for (let y = y0; y < y1; y++)
        for (let x = 0; x < qw; x++)
          px(X0 + x * Q, Y0 + y * Q, img, (y * qw + x) * 4);
    },
  };
}
