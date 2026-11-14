// The painting kit's drawing helpers: hand-inked outlines, watercolour washes,
// coursed stone, planks, roof coverings, foliage. Every one paints into a
// `Ctx2D` and draws its randomness from the `rnd` it is handed, in a fixed
// order, so the same stream always paints the same picture.

import type { Box, Ctx2D } from "../spec";
import { at, dark, jit, type Rnd } from "./colour";

export type Pt = readonly [number, number];

const INK = "rgba(48,38,28,.85)";

/** Traces the closed polygon `pts` as the current path. */
export function poly(g: Ctx2D, pts: readonly Pt[]): void {
  g.beginPath();
  pts.forEach(([x, y], i) => {
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.closePath();
}

/** The box around `pts`. */
export function bbox(pts: readonly Pt[]): Box {
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

export const rectPts = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Pt[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Sets the pen: warm dark ink, round joins. */
export function ink(g: Ctx2D, w = 1.3, a = 0.85): void {
  g.strokeStyle = `rgba(48,38,28,${a})`;
  g.lineWidth = w;
  g.lineJoin = "round";
  g.lineCap = "round";
}

/** A hand-drawn line: slight wobble through a mid point (strokes with the current pen). */
export function hline(
  g: Ctx2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rnd: Rnd,
  wob = 0.8,
): void {
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo(
    (x0 + x1) / 2 + (rnd() - 0.5) * wob * 2,
    (y0 + y1) / 2 + (rnd() - 0.5) * wob * 2,
    x1,
    y1,
  );
  g.stroke();
}

/** A sketchy ink outline: a wobbling main line plus a lighter second pass, like a pen gone over twice. */
export function sketch(
  g: Ctx2D,
  pts: readonly Pt[],
  rnd: Rnd,
  w = 1.4,
  closed = true,
): void {
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = at(pts, i);
    const b = at(pts, (i + 1) % n);
    ink(g, w, 0.85);
    hline(g, a[0], a[1], b[0], b[1], rnd, 1.1);
    ink(g, w * 0.55, 0.3);
    hline(g, a[0] + 0.7, a[1] + 0.5, b[0] + 0.4, b[1] + 0.7, rnd, 1.6);
  }
}

/** Watercolour granulation over everything painted so far (source-atop keeps it inside the drawing). */
export function grain(g: Ctx2D, box: Box, rnd: Rnd): void {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  g.save();
  g.globalCompositeOperation = "source-atop";
  for (let i = 0; i < (w * h) / 700; i++) {
    g.fillStyle = rnd() < 0.65 ? "rgba(90,66,36,.06)" : "rgba(255,244,214,.03)";
    g.beginPath();
    g.ellipse(
      x0 + rnd() * w,
      y0 + rnd() * h,
      6 + rnd() * 22,
      4 + rnd() * 14,
      rnd() * 3,
      0,
      7,
    );
    g.fill();
  }
  for (let i = 0; i < (w * h) / 26; i++) {
    g.fillStyle = rnd() < 0.55 ? "rgba(50,38,22,.13)" : "rgba(255,248,226,.11)";
    g.fillRect(x0 + rnd() * w, y0 + rnd() * h, 0.8 + rnd(), 0.8 + rnd());
  }
  g.fillStyle = "rgba(160,120,60,.07)";
  g.fillRect(x0, y0, w, h);
  g.restore();
}

const SHRUB_PALETTES = [
  ["#38432a", "#4f5c34", "#6a7744", "#8f9a5e"],
  ["#3f4728", "#58613a", "#77804c", "#a3a46a"],
  ["#40452c", "#5d5f38", "#82804a", "#b0a668"],
] as const;

/** A shrub of small leaf dabs, inked, darker at the bottom. `tone` picks one of three palettes. */
export function shrub(
  g: Ctx2D,
  x: number,
  y: number,
  sz: number,
  rnd: Rnd,
  tone = 0,
): void {
  const pal = at(SHRUB_PALETTES, tone % 3);
  g.fillStyle = "rgba(38,44,24,.28)";
  g.beginPath();
  g.ellipse(x + sz * 0.35, y + 2, sz * 1.05, sz * 0.32, 0, 0, 7);
  g.fill();
  const blobs: (readonly [number, number, number])[] = [];
  for (let i = 0; i < 4 + sz / 5; i++) {
    blobs.push([
      x + (rnd() - 0.5) * sz * 1.3,
      y - sz * 0.35 - rnd() * sz * 0.55,
      sz * (0.32 + rnd() * 0.22),
    ]);
  }
  ink(g, 2.4, 0.75);
  for (const [cx, cy, cr] of blobs) {
    g.beginPath();
    g.arc(cx, cy, cr + 0.6, 0, 7);
    g.stroke();
  }
  for (const [cx, cy, cr] of blobs) {
    g.fillStyle = pal[0];
    g.beginPath();
    g.arc(cx, cy, cr, 0, 7);
    g.fill();
  }
  for (let i = 0; i < sz * 7; i++) {
    const [cx, cy, cr] = at(blobs, (rnd() * blobs.length) | 0);
    const a = rnd() * 7;
    const d = Math.sqrt(rnd()) * cr;
    const lx = cx + Math.cos(a) * d;
    const ly = cy + Math.sin(a) * d * 0.9;
    const up = (cy - ly + cr) / (2 * cr) + (cx - lx) / (4 * cr);
    g.fillStyle = at(
      pal,
      Math.max(0, Math.min(3, Math.round(up * 2.2 + rnd() * 0.9))),
    );
    g.beginPath();
    g.ellipse(lx, ly, 1.6 + rnd() * 1.6, 1 + rnd(), rnd() * 3, 0, 7);
    g.fill();
  }
  if (rnd() < 0.4) {
    for (let i = 0; i < 5; i++) {
      const [cx, cy, cr] = at(blobs, (rnd() * blobs.length) | 0);
      g.fillStyle = rnd() < 0.5 ? "#d9d0b4" : "#c9a86a";
      g.fillRect(cx + (rnd() - 0.5) * cr, cy + (rnd() - 0.5) * cr, 1.6, 1.6);
    }
  }
}

export interface WashOptions {
  /** Number of colour blobs (default: from the area, at most 220). */
  blobs?: number;
  /** Blob colour variation. */
  var?: number;
  blobA?: number;
  /** Largest blob radius. */
  blob?: number;
  stipple?: number;
  /** Light from the top-left (default on). */
  shade?: boolean;
  shadeA?: number;
  /** Hatch strokes in the lower right. */
  hatch?: number;
  /** Outline the shape (default on). */
  outline?: boolean;
  /** Outline width. */
  lw?: number;
}

/** Fills a shape with a mottled watercolour wash, stipple and optional hatching in its lower right. */
export function wash(
  g: Ctx2D,
  path: () => void,
  box: Box,
  base: string,
  rnd: Rnd,
  o: WashOptions = {},
): void {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const area = w * h;
  g.save();
  path();
  g.fillStyle = base;
  g.fill();
  g.clip();
  const n = o.blobs ?? Math.min(220, area / 90);
  for (let i = 0; i < n; i++) {
    g.fillStyle = jit(base, rnd, o.var ?? 26, o.blobA ?? 0.22);
    g.beginPath();
    g.ellipse(
      x0 + rnd() * w,
      y0 + rnd() * h,
      3 + rnd() * (o.blob ?? 9),
      2 + rnd() * (o.blob ?? 9) * 0.6,
      rnd() * 3,
      0,
      7,
    );
    g.fill();
  }
  const st = o.stipple ?? area / 60;
  for (let i = 0; i < st; i++) {
    g.fillStyle = rnd() < 0.55 ? "rgba(40,32,22,.22)" : "rgba(255,250,235,.22)";
    g.fillRect(x0 + rnd() * w, y0 + rnd() * h, 0.9, 0.9);
  }
  if (o.shade !== false) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, "rgba(255,248,230,.10)");
    gr.addColorStop(0.55, "rgba(0,0,0,0)");
    gr.addColorStop(1, `rgba(30,26,20,${o.shadeA ?? 0.22})`);
    g.fillStyle = gr;
    g.fillRect(x0, y0, w, h);
  }
  if (o.hatch) {
    ink(g, 0.6, 0.22);
    for (let i = 0; i < o.hatch; i++) {
      const x = x0 + w * (0.45 + rnd() * 0.55);
      const y = y0 + h * (0.35 + rnd() * 0.65);
      hline(g, x, y, x + 5, y - 5, rnd, 0.3);
    }
  }
  g.restore();
  if (o.outline !== false) {
    path();
    ink(g, o.lw ?? 1.4);
    g.stroke();
  }
}

export interface StonesOptions {
  base?: string;
  mortar?: string;
  /** Clip the masonry to this path (and outline the path) instead of the rectangle. */
  clip?: () => void;
  rowH?: number;
  blockW?: number;
  outline?: boolean;
}

/** Irregular coursed stone in a rect (clipped to an optional path). */
export function stones(
  g: Ctx2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rnd: Rnd,
  o: StonesOptions = {},
): void {
  const base = o.base ?? "#b4ad9c";
  g.save();
  if (o.clip) {
    o.clip();
    g.clip();
  } else {
    g.beginPath();
    g.rect(x0, y0, x1 - x0, y1 - y0);
    g.clip();
  }
  g.fillStyle = o.mortar ?? "#6c6557";
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  let y = y1;
  while (y > y0 - 2) {
    const rh = (o.rowH ?? 10) * (0.8 + rnd() * 0.45);
    let x = x0 - rnd() * 14;
    while (x < x1) {
      const bw = (o.blockW ?? 18) * (0.65 + rnd() * 0.8);
      g.fillStyle = jit(base, rnd, 40);
      g.beginPath();
      g.roundRect(
        x + 0.9 + rnd() * 0.6,
        y - rh + 0.9 + rnd() * 0.6,
        bw - 1.8 - rnd(),
        rh - 1.8 - rnd() * 0.8,
        1.5 + rnd() * 2,
      );
      g.fill();
      g.strokeStyle = "rgba(30,25,20,.32)";
      g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(x + 2, y - 1.3);
      g.lineTo(x + bw - 1.6, y - 1.3);
      g.lineTo(x + bw - 1.6, y - rh + 2);
      g.stroke();
      g.strokeStyle = "rgba(255,250,235,.35)";
      g.lineWidth = 0.9;
      g.beginPath();
      g.moveTo(x + 2, y - 2);
      g.lineTo(x + 2, y - rh + 2);
      g.lineTo(x + bw - 3, y - rh + 2);
      g.stroke();
      g.strokeStyle = "rgba(48,38,28,.42)";
      g.lineWidth = 0.8;
      g.beginPath();
      g.roundRect(x + 0.9, y - rh + 0.9, bw - 1.8, rh - 1.8, 2.2);
      g.stroke();
      if (rnd() < 0.18) {
        g.strokeStyle = "rgba(48,38,28,.3)";
        hline(g, x + bw * 0.3, y - rh * 0.3, x + bw * 0.6, y - rh * 0.7, rnd); // a crack
      }
      x += bw;
    }
    y -= rh;
  }
  for (let i = 0; i < ((x1 - x0) * (y1 - y0)) / 50; i++) {
    g.fillStyle = rnd() < 0.5 ? "rgba(40,32,22,.18)" : "rgba(255,250,235,.16)";
    g.fillRect(x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0), 1, 1);
  }
  const gr = g.createLinearGradient(x0, 0, x1, 0);
  gr.addColorStop(0, "rgba(255,248,230,.08)");
  gr.addColorStop(1, "rgba(25,22,18,.22)");
  g.fillStyle = gr;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  const ao = g.createLinearGradient(0, y1 - 16, 0, y1);
  ao.addColorStop(0, "rgba(30,28,18,0)");
  ao.addColorStop(1, "rgba(30,28,18,.35)");
  g.fillStyle = ao;
  g.fillRect(x0, y1 - 16, x1 - x0, 16);
  g.restore();
  if (o.outline !== false) {
    if (o.clip) {
      o.clip();
      ink(g, 1.4);
      g.stroke();
    } else sketch(g, rectPts(x0, y0, x1, y1), rnd);
  }
}

export interface PlanksOptions {
  base?: string;
  /** Vertical boards (default) or horizontal. */
  vertical?: boolean;
  /** Board width. */
  pw?: number;
}

/** Weathered planks. */
export function planks(
  g: Ctx2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rnd: Rnd,
  o: PlanksOptions = {},
): void {
  const base = o.base ?? "#8a7253";
  const vert = o.vertical !== false;
  const pw = o.pw ?? 7;
  g.save();
  g.beginPath();
  g.rect(x0, y0, x1 - x0, y1 - y0);
  g.clip();
  g.fillStyle = base;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  if (vert) {
    for (let x = x0; x < x1; x += pw) {
      g.fillStyle = jit(base, rnd, 22);
      g.fillRect(x, y0, pw - 0.8, y1 - y0);
      ink(g, 0.7, 0.45);
      hline(g, x, y0, x, y1, rnd, 0.4);
      ink(g, 0.5, 0.18);
      for (let k = 0; k < 3; k++) {
        const yy = y0 + rnd() * (y1 - y0);
        hline(
          g,
          x + 1.5 + rnd() * (pw - 3),
          yy,
          x + 1.5 + rnd() * (pw - 3),
          yy + 4 + rnd() * 8,
          rnd,
          0.3,
        );
      }
    }
  } else {
    for (let y = y0; y < y1; y += pw) {
      g.fillStyle = jit(base, rnd, 22);
      g.fillRect(x0, y, x1 - x0, pw - 0.8);
      ink(g, 0.7, 0.45);
      hline(g, x0, y, x1, y, rnd, 0.4);
      ink(g, 0.5, 0.18);
      for (let k = 0; k < 3; k++) {
        const xx = x0 + rnd() * (x1 - x0);
        hline(
          g,
          xx,
          y + 2 + rnd() * (pw - 4),
          xx + 6 + rnd() * 10,
          y + 2 + rnd() * (pw - 4),
          rnd,
          0.3,
        );
      }
    }
  }
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  gr.addColorStop(0, "rgba(255,248,230,.08)");
  gr.addColorStop(1, "rgba(25,22,18,.25)");
  g.fillStyle = gr;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.restore();
  sketch(g, rectPts(x0, y0, x1, y1), rnd, 1.2);
}

export interface ShinglesOptions {
  base?: string;
  rowH?: number;
  /** Shingle width. */
  w?: number;
  /** Colour variation. */
  var?: number;
  /** Rounded (fish-scale) tiles. */
  round?: boolean;
  /** A polygon of the roof shaded darker (a side plane). */
  shadeSide?: readonly Pt[];
}

/** Shingles/tiles inside a roof polygon, rows running from the eave (y high) to the ridge. */
export function shingles(
  g: Ctx2D,
  pts: readonly Pt[],
  rnd: Rnd,
  o: ShinglesOptions = {},
): void {
  const base = o.base ?? "#6f6a62";
  const [x0, y0, x1, y1] = bbox(pts);
  const rh = o.rowH ?? 6.5;
  const sw = o.w ?? 9;
  g.save();
  poly(g, pts);
  g.fillStyle = dark(base, 0.25);
  g.fill();
  g.clip();
  let row = 0;
  for (let y = y1 + rh; y > y0 - rh; y -= rh * 0.82, row++) {
    for (
      let x = x0 - sw + (row % 2) * sw * 0.5 + rnd() * 2;
      x < x1 + sw;
      x += sw * (0.85 + rnd() * 0.3)
    ) {
      const c = jit(base, rnd, o.var ?? 38);
      const ww = sw * (0.75 + rnd() * 0.5);
      const dy = (rnd() - 0.5) * 1.6;
      g.fillStyle = c;
      g.beginPath();
      if (o.round) {
        g.moveTo(x, y - rh + dy);
        g.lineTo(x + ww - 1, y - rh + dy);
        g.lineTo(x + ww - 1, y - 2 + dy);
        g.quadraticCurveTo(x + ww / 2, y + 2 + dy, x, y - 2 + dy);
        g.closePath();
      } else {
        g.moveTo(x, y - rh + dy);
        g.lineTo(x + ww - 1, y - rh + dy);
        g.lineTo(x + ww - 1 + (rnd() - 0.5), y + dy);
        g.lineTo(x + (rnd() - 0.5), y + dy + (rnd() - 0.5));
        g.closePath();
      }
      g.fill();
      g.strokeStyle = "rgba(34,27,20,.62)";
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(x, y + dy);
      g.lineTo(x + ww - 1, y + dy + (rnd() - 0.5));
      g.stroke();
      g.strokeStyle = "rgba(34,27,20,.3)";
      g.lineWidth = 0.7;
      g.beginPath();
      g.moveTo(x + ww - 1, y - rh + dy);
      g.lineTo(x + ww - 1, y + dy);
      g.stroke();
      g.strokeStyle = "rgba(255,250,235,.18)";
      g.beginPath();
      g.moveTo(x + 1, y - rh + 1);
      g.lineTo(x + sw - 2, y - rh + 1);
      g.stroke();
      if (rnd() < 0.05) {
        g.fillStyle = "rgba(110,130,70,.45)";
        g.beginPath();
        g.ellipse(x + sw / 2, y - rh / 2, 3, 2, 0, 0, 7);
        g.fill(); // moss
      }
    }
  }
  for (let i = 0; i < ((x1 - x0) * (y1 - y0)) / 500; i++) {
    g.fillStyle = rnd() < 0.5 ? "rgba(30,26,20,.12)" : "rgba(240,232,210,.1)";
    g.beginPath();
    g.ellipse(
      x0 + rnd() * (x1 - x0),
      y0 + rnd() * (y1 - y0),
      6 + rnd() * 16,
      3 + rnd() * 7,
      rnd() * 3,
      0,
      7,
    );
    g.fill();
  }
  for (let i = 0; i < (x1 - x0) / 6; i++) {
    g.strokeStyle = "rgba(40,34,26,.12)";
    g.lineWidth = 1.5 + rnd() * 2;
    const x = x0 + rnd() * (x1 - x0);
    const y = y0 + rnd() * (y1 - y0);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 2, y + 6 + rnd() * 14);
    g.stroke();
  }
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  gr.addColorStop(0, "rgba(255,248,230,.16)");
  gr.addColorStop(1, "rgba(20,18,15,.3)");
  g.fillStyle = gr;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  if (o.shadeSide) {
    g.fillStyle = "rgba(20,18,15,.18)";
    poly(g, o.shadeSide);
    g.fill();
  }
  g.restore();
  sketch(g, pts, rnd, 1.5);
}

/** A soft cast shadow of the polygon `pts` on the ground (a few widening strokes and a fill). */
export function castShadow(g: Ctx2D, pts: readonly Pt[], a = 0.26): void {
  g.save();
  g.lineJoin = "round";
  for (const [lw, k] of [
    [14, 0.12],
    [8, 0.2],
    [3, 0.3],
  ] as const) {
    g.strokeStyle = `rgba(34,40,22,${a * k})`;
    g.lineWidth = lw;
    poly(g, pts);
    g.stroke();
  }
  g.fillStyle = `rgba(34,40,22,${a * 0.85})`;
  poly(g, pts);
  g.fill();
  g.restore();
}

/** Grass tufts scattered along `y` between `x0` and `x1`. */
export function tufts(
  g: Ctx2D,
  x0: number,
  x1: number,
  y: number,
  rnd: Rnd,
  n = 14,
): void {
  for (let i = 0; i < n; i++) {
    const x = x0 + rnd() * (x1 - x0);
    const yy = y + rnd() * 4;
    g.strokeStyle = rnd() < 0.5 ? "rgba(84,98,48,.85)" : "rgba(140,148,84,.85)";
    g.lineWidth = 1.1;
    g.beginPath();
    for (let k = -2; k <= 2; k++) {
      g.moveTo(x + k, yy);
      g.lineTo(x + k * 1.8 + (rnd() - 0.5) * 2, yy - 4 - rnd() * 6);
    }
    g.stroke();
  }
}

/** Moss patches along `y` between `x0` and `x1`. */
export function moss(
  g: Ctx2D,
  x0: number,
  x1: number,
  y: number,
  rnd: Rnd,
  n = 10,
): void {
  for (let i = 0; i < n; i++) {
    g.fillStyle = rnd() < 0.5 ? "rgba(98,112,58,.55)" : "rgba(124,134,70,.5)";
    g.beginPath();
    g.ellipse(
      x0 + rnd() * (x1 - x0),
      y - rnd() * 6,
      3 + rnd() * 5,
      1.5 + rnd() * 2.5,
      0,
      0,
      7,
    );
    g.fill();
  }
}

const IVY_LEAVES = ["#4c5a2e", "#5f6e37", "#76844a", "#3d4a26"] as const;

/** Ivy climbing from `y0` up to `y1` around `x`. */
export function ivy(
  g: Ctx2D,
  x: number,
  y0: number,
  y1: number,
  rnd: Rnd,
  spread = 18,
): void {
  ink(g, 0.9, 0.6);
  let px = x;
  const py = y0;
  g.beginPath();
  g.moveTo(px, py);
  for (let y = y0; y > y1; y -= 6) {
    px = x + Math.sin(y * 0.15) * spread * 0.3 + (rnd() - 0.5) * 4;
    g.lineTo(px, y);
  }
  g.stroke();
  for (let y = y0; y > y1; y -= 3) {
    const lx = x + Math.sin(y * 0.15) * spread * 0.3 + (rnd() - 0.5) * spread;
    g.fillStyle = at(IVY_LEAVES, (rnd() * 4) | 0);
    g.beginPath();
    g.ellipse(lx, y, 2.6 + rnd() * 1.6, 1.8 + rnd(), rnd() * 3, 0, 7);
    g.fill();
  }
}

const THATCH_TONES = [
  "#a48a52",
  "#7f6a3d",
  "#c2a86a",
  "#8d7646",
  "#b49a5e",
  "#6f5c34",
] as const;

/**
 * Thatch inside the polygon `pts`; `eave` (two points) draws the ragged eave
 * edge along it. `r` is the random stream.
 */
export function thatch(
  g: Ctx2D,
  pts: readonly Pt[],
  r: Rnd,
  eave?: readonly [Pt, Pt] | null,
): void {
  const [x0, y0, x1, y1] = bbox(pts);
  poly(g, pts);
  g.fillStyle = "#9c8350";
  g.fill();
  g.save();
  poly(g, pts);
  g.clip();
  for (let i = 0; i < ((x1 - x0) * (y1 - y0)) / 14; i++) {
    const x = x0 + r() * (x1 - x0);
    const y = y0 + r() * (y1 - y0);
    const L = 7 + r() * 12;
    g.strokeStyle = at(THATCH_TONES, (r() * THATCH_TONES.length) | 0);
    g.globalAlpha = 0.55 + r() * 0.4;
    g.lineWidth = 0.9 + r() * 0.8;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(
      x + (r() - 0.5) * 3,
      y + L / 2,
      x + (r() - 0.5) * 4,
      y + L,
    );
    g.stroke();
  }
  g.globalAlpha = 1;
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, "rgba(255,240,200,.16)");
  gr.addColorStop(1, "rgba(50,35,15,.25)");
  g.fillStyle = gr;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.fillStyle = "rgba(80,100,40,.25)";
  for (let i = 0; i < 12; i++) {
    g.beginPath();
    g.ellipse(
      x0 + r() * (x1 - x0),
      y0 + r() * (y1 - y0),
      4 + r() * 8,
      2 + r() * 4,
      0,
      0,
      7,
    );
    g.fill(); // moss
  }
  g.restore();
  poly(g, pts);
  ink(g, 1.2, 0.7);
  if (eave) {
    const [[ax, ay], [bx, by]] = eave;
    for (let x = ax; x < bx; x += 2.2) {
      const y = ay + ((by - ay) * (x - ax)) / (bx - ax);
      g.strokeStyle = at(THATCH_TONES, (r() * 3) | 0);
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(x, y - 3);
      g.lineTo(x + (r() - 0.5) * 2, y + 2 + r() * 4);
      g.stroke();
    }
    g.strokeStyle = INK;
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(ax, ay + 3);
    g.lineTo(bx, by + 3);
    g.stroke();
  }
}
