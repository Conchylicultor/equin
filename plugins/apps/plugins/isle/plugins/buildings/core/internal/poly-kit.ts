// The polygon kit: the painting kit's second hand. Where the main kit fills
// rectangles (stones in a box, planks in a box) and washes a path, this one
// fills POLYGONS — a face is a list of points, and stone, boards, log courses
// and slates are clipped to it — with flatter, palette-driven colour, ink that
// strokes the current path, and a box helper that builds a high-3/4 house
// (front wall, a sliver of side, a roof plane) in one call. Half the bespoke
// buildings (the archive barn, the clock tower, the conservatory, the launch
// tower, the inventor's cabin, the schoolhouse, the windmill) are drawn with it.
// Like the main kit, every helper draws its randomness from the `rnd` it is
// handed, in a fixed order.

import type { Ctx2D } from "../spec";
import type { Rnd } from "./colour";
import { bbox, poly, type Pt } from "./draw";

type Pts = readonly Pt[];

const INK = "rgba(48,38,28,.85)";

/** The element of a palette `rnd` lands on. */
function pick<T>(r: Rnd, arr: readonly T[]): T {
  return arr[(r() * arr.length) | 0]!;
}

function parse(c: string): [number, number, number] {
  if (c.startsWith("#")) {
    const n = parseInt(c.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/[\d.]+/g);
  if (!m || m.length < 3) throw new Error(`polyKit: unparseable colour "${c}"`);
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

const rgbOf = (a: readonly number[]) => `rgb(${a.map(Math.round).join(",")})`;

/** `a` toward `b` by `k`, as `rgb(…)`. */
function mix(a: string, b: string, k: number): string {
  const p = parse(a);
  const q = parse(b);
  return rgbOf(p.map((v, i) => v + (q[i]! - v) * k));
}

/** The app hue as an accent: desaturated toward grey and darkened by `dark`. */
function accent(hue: string, dark = 0.15): string {
  const c = parse(hue);
  const l = (c[0] + c[1] + c[2]) / 3;
  return rgbOf(c.map((v) => (v + (l - v) * 0.38) * (1 - dark)));
}

/** A Park–Miller stream (the prototype's `seeded`): the polygon kit's grain pass is seeded with it. */
function parkMiller(n: number): Rnd {
  let s = n | 0 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Strokes the current path in ink (sets round joins). */
function ink(g: Ctx2D, w = 1.3, a = 0.85): void {
  g.strokeStyle = `rgba(48,38,28,${a})`;
  g.lineWidth = w;
  g.lineJoin = g.lineCap = "round";
  g.stroke();
}

/** A watercolour wash: `base` fill + `n` mottled translucent blobs of `tones`, clipped to the shape. */
function wash(
  g: Ctx2D,
  pts: Pts,
  base: string,
  tones: readonly string[],
  r: Rnd,
  n = 40,
  size = 10,
): void {
  poly(g, pts);
  g.fillStyle = base;
  g.fill();
  const [x0, y0, x1, y1] = bbox(pts);
  g.save();
  poly(g, pts);
  g.clip();
  for (let i = 0; i < n; i++) {
    g.globalAlpha = 0.12 + r() * 0.22;
    g.fillStyle = pick(r, tones);
    g.beginPath();
    g.ellipse(
      x0 + r() * (x1 - x0),
      y0 + r() * (y1 - y0),
      size * (0.5 + r()),
      size * (0.3 + r() * 0.5),
      r() * 3,
      0,
      7,
    );
    g.fill();
  }
  g.restore();
  g.globalAlpha = 1;
}

/** Hatching in shadow: short parallel strokes, clipped to the shape. */
function hatch(g: Ctx2D, pts: Pts, r: Rnd, gap = 4, a = 0.22, ang = 0.9): void {
  const [x0, y0, x1, y1] = bbox(pts);
  g.save();
  poly(g, pts);
  g.clip();
  g.strokeStyle = `rgba(48,38,28,${a})`;
  g.lineWidth = 0.8;
  const dx = Math.cos(ang) * 8;
  const dy = Math.sin(ang) * 8;
  for (let x = x0 - 20; x < x1 + 20; x += gap)
    for (let y = y0; y < y1; y += 9 + r() * 6) {
      if (r() < 0.25) continue;
      const ox = x + (r() - 0.5) * 2;
      g.beginPath();
      g.moveTo(ox, y);
      g.lineTo(ox + dx, y + dy);
      g.stroke();
    }
  g.restore();
}

/** A flat cast shadow (bottom-right). */
function castShadow(g: Ctx2D, pts: Pts): void {
  poly(g, pts);
  g.fillStyle = "rgba(44,46,24,.26)";
  g.fill();
}

/** Contact darkness along the foot of a wall, from x0 to x1 at y. */
function ao(g: Ctx2D, x0: number, x1: number, y: number): void {
  const gr = g.createLinearGradient(0, y - 10, 0, y + 4);
  gr.addColorStop(0, "rgba(40,36,20,0)");
  gr.addColorStop(1, "rgba(40,36,20,.35)");
  g.fillStyle = gr;
  g.fillRect(x0, y - 10, x1 - x0, 14);
}

const STONE = ["#bcb5a5", "#aaa392", "#c7c0ae", "#9d9686", "#b3ab98"] as const;

/** Irregular coursed stone, clipped to a shape. */
function stones(
  g: Ctx2D,
  pts: Pts,
  r: Rnd,
  pal: readonly string[] = STONE,
  rowH = 9,
): void {
  const [x0, y0, x1, y1] = bbox(pts);
  g.save();
  poly(g, pts);
  g.clip();
  g.fillStyle = "#857e70";
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  for (let y = y1; y > y0 - rowH; y -= rowH) {
    let x = x0 - r() * 12;
    const rh = rowH * (0.85 + r() * 0.3);
    while (x < x1) {
      const w = 9 + r() * 15;
      g.fillStyle = pick(r, pal);
      g.beginPath();
      g.roundRect(x + 0.8, y - rh + 0.8, w - 1.6, rh - 1.6, 2.6);
      g.fill();
      g.fillStyle = "rgba(255,250,235,.18)";
      g.fillRect(x + 1.5, y - rh + 1.2, w - 4, 1.4);
      g.strokeStyle = "rgba(48,38,28,.55)";
      g.lineWidth = 0.8;
      g.stroke();
      x += w;
    }
  }
  g.restore();
}

const BOARD = ["#8a7254", "#7b6549", "#9c845f", "#6e5a42"] as const;

/** Weathered vertical boards, clipped to a shape. */
function boards(
  g: Ctx2D,
  pts: Pts,
  r: Rnd,
  pal: readonly string[] = BOARD,
  bw = 9,
): void {
  const [x0, y0, x1, y1] = bbox(pts);
  g.save();
  poly(g, pts);
  g.clip();
  for (let x = x0; x < x1; x += bw) {
    const w = bw * (0.8 + r() * 0.4);
    g.fillStyle = pick(r, pal);
    g.fillRect(x, y0, w, y1 - y0);
    g.strokeStyle = "rgba(40,30,20,.6)";
    g.lineWidth = 0.9;
    g.beginPath();
    g.moveTo(x, y0);
    g.lineTo(x, y1);
    g.stroke();
    g.strokeStyle = "rgba(240,225,190,.14)";
    for (let k = 0; k < 3; k++) {
      const gx = x + 2 + r() * (w - 4);
      g.beginPath();
      g.moveTo(gx, y0 + r() * 10);
      g.lineTo(gx + (r() - 0.5) * 2, y1);
      g.stroke();
    }
    if (r() < 0.3) {
      g.fillStyle = "rgba(40,30,20,.5)";
      g.beginPath();
      g.ellipse(x + w / 2, y0 + r() * (y1 - y0), 1.4, 2.2, 0, 0, 7);
      g.fill();
    }
  }
  g.restore();
}

const COURSE = ["#8a7254", "#7b6549", "#937a58"] as const;

/** Horizontal log / plank courses, clipped to a shape. */
function courses(
  g: Ctx2D,
  pts: Pts,
  r: Rnd,
  pal: readonly string[] = COURSE,
  ch = 8,
): void {
  const [x0, y0, x1, y1] = bbox(pts);
  g.save();
  poly(g, pts);
  g.clip();
  for (let y = y1; y > y0 - ch; y -= ch) {
    g.fillStyle = pick(r, pal);
    g.fillRect(x0, y - ch, x1 - x0, ch);
    g.fillStyle = "rgba(240,225,190,.16)";
    g.fillRect(x0, y - ch, x1 - x0, 1.6);
    g.fillStyle = "rgba(40,30,20,.45)";
    g.fillRect(x0, y - 1.2, x1 - x0, 1.2);
    for (let k = 0; k < 4; k++) {
      g.strokeStyle = "rgba(40,30,20,.22)";
      g.lineWidth = 0.7;
      const gx = x0 + r() * (x1 - x0);
      g.beginPath();
      g.moveTo(gx, y - ch * 0.5);
      g.lineTo(gx + 14 + r() * 20, y - ch * 0.5 + (r() - 0.5));
      g.stroke();
    }
  }
  g.restore();
}

/** Overlapping shingles / slates in rows, from a palette (its first colour the underlay). */
function shingles(
  g: Ctx2D,
  pts: Pts,
  r: Rnd,
  pal: readonly string[],
  rowH = 7,
  sw = 10,
): void {
  const [x0, y0, x1, y1] = bbox(pts);
  poly(g, pts);
  g.fillStyle = pal[0]!;
  g.fill();
  g.save();
  poly(g, pts);
  g.clip();
  for (let y = y0; y < y1 + rowH; y += rowH) {
    let x = x0 - r() * sw;
    while (x < x1) {
      const w = sw * (0.7 + r() * 0.6);
      g.fillStyle = pick(r, pal);
      g.fillRect(x, y, w - 0.8, rowH + 1);
      g.fillStyle = "rgba(30,24,18,.4)";
      g.fillRect(x, y + rowH - 0.6, w, 1.3);
      g.fillStyle = "rgba(30,24,18,.35)";
      g.fillRect(x + w - 1, y, 0.9, rowH);
      if (r() < 0.07) {
        g.fillStyle = "rgba(90,110,50,.4)";
        g.fillRect(x, y, w, rowH);
      }
      x += w;
    }
  }
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  gr.addColorStop(0, "rgba(255,245,220,.12)");
  gr.addColorStop(1, "rgba(30,25,15,.2)");
  g.fillStyle = gr;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.restore();
  poly(g, pts);
  ink(g, 1.2, 0.75);
}

const SLATE = ["#6d7178", "#5e636b", "#7b8087", "#676b72", "#565a61"] as const;
const SHAKE = ["#6e5c45", "#7d6a50", "#5f4f3b", "#86725a", "#695740"] as const;

/** Grass tufts along y between x0 and x1. */
function tufts(
  g: Ctx2D,
  x0: number,
  x1: number,
  y: number,
  r: Rnd,
  n = 10,
): void {
  for (let i = 0; i < n; i++) {
    const x = x0 + r() * (x1 - x0);
    g.strokeStyle = pick(r, ["#5c6838", "#6f7a42", "#8b9455"]);
    g.lineWidth = 1.1;
    g.beginPath();
    for (let k = -2; k <= 2; k++) {
      g.moveTo(x + k * 1.4, y + r() * 2);
      g.lineTo(x + k * 2.4 + (r() - 0.5) * 2, y - 4 - r() * 6);
    }
    g.stroke();
  }
}

/** Moss along the foot of a wall. */
function moss(g: Ctx2D, x0: number, x1: number, y: number, r: Rnd): void {
  for (let i = 0; i < (x1 - x0) / 6; i++) {
    g.fillStyle = pick(r, [
      "rgba(90,104,52,.55)",
      "rgba(110,122,62,.5)",
      "rgba(70,84,40,.5)",
    ]);
    g.beginPath();
    g.ellipse(
      x0 + r() * (x1 - x0),
      y - r() * 7,
      2 + r() * 4,
      1.5 + r() * 2.5,
      0,
      0,
      7,
    );
    g.fill();
  }
}

/** Ivy climbing `h` px up from (x, y). */
function ivy(g: Ctx2D, x: number, y: number, h: number, r: Rnd): void {
  g.strokeStyle = "rgba(60,70,35,.8)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, y);
  let cx = x;
  let cy = y;
  for (let i = 0; i < h / 6; i++) {
    cx += (r() - 0.5) * 6;
    cy -= 6;
    g.lineTo(cx, cy);
  }
  g.stroke();
  for (let i = 0; i < h / 3; i++) {
    g.fillStyle = pick(r, ["#4f5d33", "#6b7a42", "#5c6a38"]);
    g.beginPath();
    g.ellipse(x + (r() - 0.5) * 12, y - r() * h, 2.4, 1.6, r() * 3, 0, 7);
    g.fill();
  }
}

interface WindowAtOptions {
  /** Shutter colour: louvred shutters either side. */
  readonly shutter?: string;
  readonly arch?: boolean;
  readonly panes?: number;
}

/** A window, (x, y) its TOP-left; lit warm at night. */
function windowAt(
  g: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  s: { readonly night: boolean },
  opts: WindowAtOptions = {},
): void {
  const { shutter, arch, panes = 2 } = opts;
  if (shutter)
    for (const [sx, sw] of [
      [x - w * 0.55, w * 0.5],
      [x + w + 0.05 * w, w * 0.5],
    ] as const) {
      g.fillStyle = shutter;
      g.fillRect(sx, y, sw, h);
      g.strokeStyle = "rgba(30,20,15,.35)";
      g.lineWidth = 0.7;
      for (let k = 2; k < h; k += 3) {
        g.beginPath();
        g.moveTo(sx + 1, y + k);
        g.lineTo(sx + sw - 1, y + k);
        g.stroke();
      }
      g.beginPath();
      g.rect(sx, y, sw, h);
      ink(g, 0.9, 0.7);
    }
  g.fillStyle = "#5c4a36";
  g.beginPath();
  if (arch) {
    g.moveTo(x - 2, y + h + 2);
    g.lineTo(x - 2, y + w / 2);
    g.arc(x + w / 2, y + w / 2, w / 2 + 2, Math.PI, 0);
    g.lineTo(x + w + 2, y + h + 2);
  } else g.rect(x - 2, y - 2, w + 4, h + 4);
  g.fill();
  g.beginPath();
  if (arch) {
    g.moveTo(x, y + h);
    g.lineTo(x, y + w / 2);
    g.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0);
    g.lineTo(x + w, y + h);
  } else g.rect(x, y, w, h);
  g.closePath();
  if (s.night) {
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, "#ffe2a0");
    gr.addColorStop(1, "#f0a850");
    g.fillStyle = gr;
  } else {
    const gr = g.createLinearGradient(x, y, x + w, y + h);
    gr.addColorStop(0, "#58646a");
    gr.addColorStop(1, "#2f383e");
    g.fillStyle = gr;
  }
  g.fill();
  if (!s.night) {
    g.fillStyle = "rgba(220,235,240,.25)";
    g.fillRect(x + 1, y + 1, w * 0.35, h * 0.4);
  }
  g.strokeStyle = "#4a3a2a";
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(x + w / 2, y + (arch ? 2 : 0));
  g.lineTo(x + w / 2, y + h);
  if (panes > 1) {
    g.moveTo(x, y + h * 0.5);
    g.lineTo(x + w, y + h * 0.5);
  }
  g.stroke();
  g.fillStyle = "#8a7a64";
  g.fillRect(x - 3, y + h + 1, w + 6, 3);
  g.beginPath();
  g.rect(x - 3, y + h + 1, w + 6, 3);
  ink(g, 0.8, 0.6);
}

/** A plank door with a stone surround and sill; (x, y) its bottom-centre. */
function plankDoor(
  g: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  r: Rnd,
  arch = true,
): void {
  const L = x - w / 2;
  const T = y - h;
  g.fillStyle = "#6b6252";
  g.beginPath();
  if (arch) {
    g.moveTo(L - 4, y);
    g.lineTo(L - 4, T + w / 2);
    g.arc(x, T + w / 2, w / 2 + 4, Math.PI, 0);
    g.lineTo(L + w + 4, y);
  } else g.rect(L - 4, T - 4, w + 8, h + 4);
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 1;
  g.stroke();
  g.save();
  g.beginPath();
  if (arch) {
    g.moveTo(L, y);
    g.lineTo(L, T + w / 2);
    g.arc(x, T + w / 2, w / 2, Math.PI, 0);
    g.lineTo(L + w, y);
  } else g.rect(L, T, w, h);
  g.closePath();
  g.clip();
  g.fillStyle = color;
  g.fillRect(L, T, w, h);
  for (let k = L; k < L + w; k += 5) {
    g.fillStyle = `rgba(30,20,10,${0.12 + r() * 0.12})`;
    g.fillRect(k, T, 0.9, h);
    g.fillStyle = `rgba(255,240,210,${r() * 0.08})`;
    g.fillRect(k + 1, T, 3, h);
  }
  g.fillStyle = "rgba(30,20,10,.25)";
  g.fillRect(L, T, w, h);
  g.fillStyle = "rgba(255,240,210,.08)";
  g.fillRect(L, T, w * 0.4, h);
  g.restore();
  g.fillStyle = "#3a332c";
  for (const hy of [T + h * 0.3, T + h * 0.75])
    g.fillRect(L, hy, w * 0.55, 2.2);
  g.beginPath();
  g.arc(x + w * 0.3, y - h * 0.45, 1.6, 0, 7);
  g.fillStyle = "#c9a35a";
  g.fill();
  g.fillStyle = "#9d9686";
  g.fillRect(L - 7, y - 1, w + 14, 4);
  g.beginPath();
  g.rect(L - 7, y - 1, w + 14, 4);
  ink(g, 0.8, 0.6);
}

/** The open door (animate only): warm light inside, the leaf swung in, light spilling out. */
function openDoor(
  g: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  arch = true,
): void {
  const L = x - w / 2;
  const T = y - h;
  g.save();
  g.beginPath();
  if (arch) {
    g.moveTo(L, y);
    g.lineTo(L, T + w / 2);
    g.arc(x, T + w / 2, w / 2, Math.PI, 0);
    g.lineTo(L + w, y);
  } else g.rect(L, T, w, h);
  g.closePath();
  g.clip();
  const gr = g.createLinearGradient(0, T, 0, y);
  gr.addColorStop(0, "#5a3a1c");
  gr.addColorStop(1, "#f2b860");
  g.fillStyle = gr;
  g.fillRect(L, T, w, h);
  g.restore();
  g.fillStyle = "#4e3a26";
  g.beginPath();
  g.moveTo(L, y);
  g.lineTo(L - w * 0.28, y + 3);
  g.lineTo(L - w * 0.28, T + w * 0.35);
  g.lineTo(L, T + (arch ? w * 0.45 : 0));
  g.closePath();
  g.fill();
  ink(g, 0.9, 0.7);
  const sp = g.createLinearGradient(0, y, 0, y + 22);
  sp.addColorStop(0, "rgba(255,200,120,.5)");
  sp.addColorStop(1, "rgba(255,200,120,0)");
  g.fillStyle = sp;
  g.beginPath();
  g.moveTo(L, y);
  g.lineTo(L + w, y);
  g.lineTo(L + w + 10, y + 22);
  g.lineTo(L - 10, y + 22);
  g.fill();
}

/** A crate of side `s`, its front-bottom-left at (x, y). */
function crate(g: Ctx2D, x: number, y: number, s: number): void {
  const top: Pts = [
    [x, y - s],
    [x + s, y - s],
    [x + s + 6, y - s - 5],
    [x + 6, y - s - 5],
  ];
  g.fillStyle = "#93785a";
  g.fillRect(x, y - s, s, s);
  g.fillStyle = "#7a6249";
  g.beginPath();
  g.moveTo(x + s, y);
  g.lineTo(x + s + 6, y - 5);
  g.lineTo(x + s + 6, y - s - 5);
  g.lineTo(x + s, y - s);
  g.fill();
  poly(g, top);
  g.fillStyle = "#a88c68";
  g.fill();
  ink(g, 0.8, 0.6);
  g.strokeStyle = "rgba(40,30,20,.55)";
  g.lineWidth = 0.8;
  for (let k = 1; k < 3; k++) {
    g.beginPath();
    g.moveTo(x, y - (s * k) / 3);
    g.lineTo(x + s, y - (s * k) / 3);
    g.stroke();
  }
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(x + 1, y - 1);
  g.lineTo(x + s - 1, y - s + 1);
  g.stroke();
  g.beginPath();
  g.rect(x, y - s, s, s);
  ink(g, 1, 0.8);
}

/** A barrel standing at (x, y). */
function barrel(g: Ctx2D, x: number, y: number): void {
  g.fillStyle = "rgba(44,46,24,.25)";
  g.beginPath();
  g.ellipse(x + 6, y, 11, 4, 0, 0, 7);
  g.fill();
  const gr = g.createLinearGradient(x - 9, 0, x + 9, 0);
  gr.addColorStop(0, "#8a6c4a");
  gr.addColorStop(0.4, "#a0805a");
  gr.addColorStop(1, "#5e4832");
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(x - 8, y);
  g.quadraticCurveTo(x - 10, y - 11, x - 8, y - 22);
  g.lineTo(x + 8, y - 22);
  g.quadraticCurveTo(x + 10, y - 11, x + 8, y);
  g.closePath();
  g.fill();
  ink(g, 1, 0.8);
  g.strokeStyle = "#4a443e";
  g.lineWidth = 1.6;
  for (const hy of [y - 5, y - 17]) {
    g.beginPath();
    g.moveTo(x - 9, hy);
    g.lineTo(x + 9, hy);
    g.stroke();
  }
  g.fillStyle = "#7d6347";
  g.beginPath();
  g.ellipse(x, y - 22, 8, 3, 0, 0, 7);
  g.fill();
  ink(g, 0.8, 0.7);
}

/** A sack standing at (x, y). */
function sack(g: Ctx2D, x: number, y: number): void {
  g.fillStyle = "#c2ad84";
  g.beginPath();
  g.moveTo(x - 8, y);
  g.quadraticCurveTo(x - 11, y - 10, x - 5, y - 16);
  g.lineTo(x - 2, y - 20);
  g.lineTo(x + 2, y - 20);
  g.lineTo(x + 5, y - 16);
  g.quadraticCurveTo(x + 11, y - 10, x + 8, y);
  g.closePath();
  g.fill();
  ink(g, 0.9, 0.7);
  g.fillStyle = "rgba(90,70,40,.25)";
  g.beginPath();
  g.ellipse(x + 3, y - 7, 4, 6, 0, 0, 7);
  g.fill();
  g.strokeStyle = "#6e5c45";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x - 4, y - 16);
  g.lineTo(x + 4, y - 16);
  g.stroke();
}

/** A small hanging lantern at (x, y); `lit` glows warm. */
function lantern(g: Ctx2D, x: number, y: number, lit: boolean): void {
  g.strokeStyle = "#3a332c";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, y - 6);
  g.lineTo(x, y - 10);
  g.stroke();
  g.fillStyle = lit ? "#ffd27a" : "#d8cfae";
  g.fillRect(x - 3, y - 6, 6, 8);
  g.beginPath();
  g.rect(x - 3, y - 6, 6, 8);
  ink(g, 0.9, 0.8);
  g.fillStyle = "#3a332c";
  g.fillRect(x - 4, y - 7, 8, 2);
  g.fillRect(x - 3, y + 2, 6, 1.5);
}

/** `n` small rocks scattered round (x, y). */
function rocks(g: Ctx2D, x: number, y: number, r: Rnd, n = 3): void {
  for (let i = 0; i < n; i++) {
    const rx = x + (r() - 0.5) * 30;
    const ry = y + (r() - 0.5) * 6;
    const s = 4 + r() * 6;
    g.fillStyle = "#868b92";
    g.beginPath();
    g.moveTo(rx - s, ry);
    g.lineTo(rx - s * 0.7, ry - s * 0.8);
    g.lineTo(rx + s * 0.3, ry - s);
    g.lineTo(rx + s, ry - s * 0.3);
    g.lineTo(rx + s * 0.8, ry);
    g.closePath();
    g.fill();
    ink(g, 0.8, 0.7);
    g.fillStyle = "#a9adb2";
    g.beginPath();
    g.moveTo(rx - s * 0.7, ry - s * 0.8);
    g.lineTo(rx + s * 0.3, ry - s);
    g.lineTo(rx, ry - s * 0.4);
    g.closePath();
    g.fill();
  }
}

/** Steam rising from (x, y) with time `t`, drifting toward `spread`'s sign. */
function steam(
  g: Ctx2D,
  x: number,
  y: number,
  t: number,
  n = 5,
  spread = 1,
): void {
  for (let i = 0; i < n; i++) {
    const k = (t * 0.35 + i / n) % 1;
    g.fillStyle = `rgba(236,234,226,${0.42 * (1 - k)})`;
    g.beginPath();
    g.ellipse(
      x + Math.sin(k * 5 + i) * 6 * spread + k * 18 * spread,
      y - k * 70,
      5 + k * 16,
      4 + k * 11,
      0,
      0,
      7,
    );
    g.fill();
  }
}

type Face = (g: Ctx2D, pts: Pts) => void;

interface BoxOptions {
  /** Front wall width, height. */
  readonly W: number;
  readonly h: number;
  /** How deep the side sliver is. */
  readonly sd?: number;
  /** How far the roof rises behind the eave. */
  readonly rd: number;
  /** Eave overhang. */
  readonly ov?: number;
  readonly wall: Face;
  readonly sideWall?: Face;
  readonly roof: (g: Ctx2D, slope: Pts, eave: Pts) => void;
}

/**
 * A box building in high 3/4: front wall, a sliver of right side, a roof plane
 * seen from above, its cast shadow. Returns the key coordinates.
 */
function box(
  g: Ctx2D,
  r: Rnd,
  o: BoxOptions,
): { L: number; R: number; h: number; eY: number; rY: number; sd: number } {
  const { W, h, sd = 18, rd, ov = 9, wall, sideWall, roof } = o;
  const L = -W / 2;
  const R = W / 2;
  const front: Pts = [
    [L, 0],
    [R, 0],
    [R, -h],
    [L, -h],
  ];
  const side: Pts = [
    [R, 0],
    [R + sd, -sd * 0.7],
    [R + sd, -h - sd * 0.7],
    [R, -h],
  ];
  castShadow(g, [
    [L + 10, 2],
    [R + sd + 40, 6],
    [R + sd + 60, -rd * 0.4],
    [R + sd + 10, -h * 0.3],
    [R, -2],
  ]);
  wall(g, front);
  (sideWall ?? wall)(g, side);
  g.fillStyle = "rgba(30,26,20,.32)";
  poly(g, side);
  g.fill();
  hatch(g, side, r, 3.5, 0.18);
  poly(g, front);
  ink(g, 1.3);
  poly(g, side);
  ink(g, 1.2);
  // roof: front slope from eave up to the ridge, plus the right gable sliver
  const eY = -h + 5;
  const rY = -h - rd;
  const eave: Pts = [
    [L - ov, eY],
    [R + ov, eY],
  ];
  const slope: Pts = [
    [L - ov, eY],
    [R + ov, eY],
    [R + ov + sd * 0.6, rY],
    [L - ov + sd * 0.6, rY],
  ];
  const gable: Pts = [
    [R + ov, eY],
    [R + ov + sd, eY - sd * 0.7],
    [R + ov + sd * 0.6, rY],
  ];
  // the eave's shadow on the wall
  g.fillStyle = "rgba(30,24,16,.3)";
  g.fillRect(L, -h, W, 9);
  roof(g, slope, eave);
  poly(g, gable);
  g.fillStyle = "rgba(40,32,22,.55)";
  g.fill();
  ink(g, 1, 0.7);
  g.strokeStyle = "rgba(40,32,22,.8)";
  g.lineWidth = 2.2;
  g.beginPath();
  g.moveTo(L - ov + sd * 0.6, rY);
  g.lineTo(R + ov + sd * 0.6, rY);
  g.stroke(); // ridge
  return { L, R, h, eY, rY, sd };
}

/** A wall of log courses from a palette. */
const courseWall =
  (r: Rnd, pal: readonly string[]): Face =>
  (g, pts) =>
    courses(g, pts, r, pal);

const GRAIN_TONES = [
  "#5a4a2e",
  "#c9b88a",
  "#6f7a52",
  "#8a6a4a",
  "#e8dcc0",
  "#4a5560",
] as const;

/** A watercolour pass over everything already painted: pigment pooling, warm/cool drift, paper speckle. */
function grain(
  g: Ctx2D,
  bounds: readonly [number, number, number, number],
  r: Rnd,
): void {
  const [x0, y0, x1, y1] = bounds;
  g.save();
  g.globalCompositeOperation = "source-atop";
  const n = ((x1 - x0) * (y1 - y0)) / 260;
  for (let i = 0; i < n; i++) {
    g.globalAlpha = 0.04 + r() * 0.08;
    g.fillStyle = pick(r, GRAIN_TONES);
    g.beginPath();
    g.ellipse(
      x0 + r() * (x1 - x0),
      y0 + r() * (y1 - y0),
      6 + r() * 26,
      4 + r() * 16,
      r() * 3,
      0,
      7,
    );
    g.fill();
  }
  for (let i = 0; i < n * 3; i++) {
    g.globalAlpha = 0.18 + r() * 0.25;
    g.fillStyle = r() < 0.6 ? "#3a2e22" : "#f4ecd6";
    g.fillRect(x0 + r() * (x1 - x0), y0 + r() * (y1 - y0), 0.8, 0.8);
  }
  // top-left light, bottom-right shade, across the whole building
  g.globalAlpha = 1;
  const lg = g.createLinearGradient(x0, y0, x1, y1);
  lg.addColorStop(0, "rgba(255,244,214,.10)");
  lg.addColorStop(1, "rgba(40,30,20,.14)");
  g.fillStyle = lg;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.restore();
}

/**
 * The polygon kit. Its helpers are namespaced (`polyKit.stones(g, pts, r)`)
 * because several share a name with the main kit's rectangle-based ones and
 * draw differently.
 */
export const polyKit = {
  INK,
  SLATE,
  SHAKE,
  pick,
  mix,
  accent,
  parkMiller,
  ink,
  wash,
  hatch,
  castShadow,
  ao,
  stones,
  boards,
  courses,
  courseWall,
  shingles,
  tufts,
  moss,
  ivy,
  windowAt,
  plankDoor,
  openDoor,
  crate,
  barrel,
  sack,
  lantern,
  rocks,
  steam,
  box,
  grain,
} as const;
