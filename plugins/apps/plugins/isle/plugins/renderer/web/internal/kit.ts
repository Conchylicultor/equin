// The renderer's small drawing kit: canvases, sprites (drawn once at 2×,
// placed by their ground anchor), the solid cut-out of a painted canvas, inked
// lines and irregular blobs.

import { mulberry32 } from "@plugins/packages/plugins/seeded-random/core";
import { fnv1a32 } from "@plugins/packages/plugins/string-hash/core";

export type Ctx = CanvasRenderingContext2D;
export type Rnd = () => number;

export const INK = "rgba(48,38,28,.82)";

/** A seeded random stream (the prototype's `seeded`). */
export const seeded = (s: number): Rnd => mulberry32(s);
/** FNV-1a of a string (the prototype's `strHash`). */
export const strHash = (s: string): number => fnv1a32(s);

/** How many boulder sprites there are, and each one's size (px): the furniture places them by index. */
export const ROCK_COUNT = 20;
export const rockSize = (i: number): number => 14 + (i % 7) * 7;

/** A detached canvas of the given pixel size. */
export function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/** A canvas's 2D context, loudly. */
export function ctx2d(
  c: HTMLCanvasElement,
  opts?: CanvasRenderingContext2DSettings,
): Ctx {
  const g = c.getContext("2d", opts);
  if (!g) throw new Error("isle renderer: no 2D context");
  return g;
}

/** A sprite: drawn once at 2× into its own canvas, placed by its anchor (ax, ay = the ground point). */
export interface Sprite {
  readonly c: HTMLCanvasElement;
  readonly w: number;
  readonly h: number;
  readonly ax: number;
  readonly ay: number;
}

export function sprite(
  w: number,
  h: number,
  ax: number,
  ay: number,
  draw: (g: Ctx) => void,
): Sprite {
  const c = canvas(w * 2, h * 2);
  const g = ctx2d(c);
  g.scale(2, 2);
  g.translate(ax, ay);
  draw(g);
  return { c, w, h, ax, ay };
}

/**
 * What of a painted canvas hides a person standing behind it: its alpha, the
 * near-transparent parts (a cast shadow, washes) cut away. Read once per canvas.
 */
const SOLID_A = 100;
const solidMasks = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
export function solidOf(c: HTMLCanvasElement): HTMLCanvasElement {
  const hit = solidMasks.get(c);
  if (hit) return hit;
  const m = canvas(c.width, c.height);
  const mg = ctx2d(m, { willReadFrequently: true });
  mg.drawImage(c, 0, 0);
  const im = mg.getImageData(0, 0, m.width, m.height);
  const d = im.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]! < SOLID_A) d[i] = 0;
  mg.putImageData(im, 0, 0);
  solidMasks.set(c, m);
  return m;
}

/** Places a sprite with its anchor at (x, y), scaled by k; `solid`: its cut-out only. */
export function put(
  g: Ctx,
  s: Sprite,
  x: number,
  y: number,
  k = 1,
  solid = false,
): void {
  g.drawImage(
    solid ? solidOf(s.c) : s.c,
    x - s.ax * k,
    y - s.ay * k,
    s.w * k,
    s.h * k,
  );
}

export function blobPath(
  x: number,
  y: number,
  r: number,
  rnd: Rnd,
  n = 9,
  jit = 0.28,
): Path2D {
  const P = new Path2D();
  for (let i = 0; i <= n; i++) {
    const a = ((i % n) / n) * Math.PI * 2;
    const rr = r * (1 - jit / 2 + rnd() * jit);
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr * 0.92;
    if (i) P.lineTo(px, py);
    else P.moveTo(px, py);
  }
  P.closePath();
  return P;
}

/** An irregular closed shape, as the current path. */
export function blob(
  g: Ctx,
  x: number,
  y: number,
  r: number,
  rnd: Rnd,
  n = 9,
  jit = 0.28,
): void {
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = ((i % n) / n) * Math.PI * 2;
    const rr = r * (1 - jit / 2 + rnd() * jit);
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr * 0.92;
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  g.closePath();
}

export function inkLine(
  g: Ctx,
  pts: readonly (readonly [number, number])[],
  w = 1.1,
  col = INK,
): void {
  g.strokeStyle = col;
  g.lineWidth = w;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.stroke();
}

/** A soft round glow of one colour, drawn once and stamped. */
const GLOWS = new Map<string, HTMLCanvasElement>();
export function glowSprite(col: string): HTMLCanvasElement {
  const hit = GLOWS.get(col);
  if (hit) return hit;
  const c = canvas(128, 128);
  const g = ctx2d(c);
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, col);
  gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  GLOWS.set(col, c);
  return c;
}

/** Smoothstep of x between a and b. */
export const ss = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
