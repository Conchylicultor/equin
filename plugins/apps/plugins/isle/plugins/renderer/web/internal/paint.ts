// What is painted onto a tile from the layout: roads (packed earth, ruts,
// grass at the verges, pebbles), bridges (planks over the water), district
// squares (flagstones), empty lots (a fenced patch with a blank stake), and the
// signposts drawn over everything.

import {
  hash,
  roadHash,
  vnoise,
  type Plot,
  type Road,
  type Square,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import { INK, blob, seeded, strHash, type Ctx } from "./kit";

const inBox =
  (bx0: number, by0: number, bx1: number, by1: number) =>
  (s: { x: number; y: number }, m: number) =>
    s.x > bx0 - m && s.x < bx1 + m && s.y > by0 - m && s.y < by1 + m;

const visibleRoads = (
  roads: readonly Road[],
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
) =>
  roads.filter(
    (r) =>
      !(
        r.bbox[2] < bx0 ||
        r.bbox[0] > bx1 ||
        r.bbox[3] < by0 ||
        r.bbox[1] > by1
      ),
  );

export function paintRoads(
  g: Ctx,
  roads: readonly Road[],
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): void {
  const inB = inBox(bx0, by0, bx1, by1);
  const vis = visibleRoads(roads, bx0, by0, bx1, by1);
  g.fillStyle = "rgba(96,84,52,.22)";
  for (const r of vis) {
    g.beginPath();
    for (const s of r.samples) {
      if (s.bridge || !inB(s, 40)) continue;
      g.moveTo(s.x + s.r + 3, s.y);
      g.ellipse(s.x, s.y, s.r + 3, (s.r + 3) * 0.85, 0, 0, 7);
    }
    g.fill();
  }
  for (const r of vis)
    for (const s of r.samples) {
      if (s.bridge || !inB(s, 40)) continue;
      const n = vnoise(s.x / 12, s.y / 12);
      g.fillStyle = `rgb(${(200 + n * 22) | 0},${(184 + n * 20) | 0},${(140 + n * 16) | 0})`;
      g.beginPath();
      g.ellipse(s.x, s.y, s.r, s.r * 0.85, 0, 0, 7);
      g.fill();
    }
  for (const r of vis) {
    if (r.kind === "spur") continue;
    const h = roadHash(r.key);
    g.fillStyle = "rgba(150,130,90,.35)";
    r.samples.forEach((s, i) => {
      if (s.bridge || !inB(s, 10) || hash(i, h) < 0.45) return;
      for (const o of [-7, 7]) g.fillRect(s.x - s.uy * o, s.y + s.ux * o, 2, 2);
    });
  }
  g.strokeStyle = "rgba(70,82,40,.6)";
  g.lineWidth = 1;
  for (const r of vis) {
    const h = roadHash(r.key);
    g.beginPath();
    for (let i = 0; i < r.samples.length; i += 2) {
      const s = r.samples[i]!;
      if (s.bridge || !inB(s, 30)) continue;
      for (let k = 0; k < 2; k++) {
        const hv = hash(i * 2 + k, h + 7);
        const o = (hv < 0.5 ? -1 : 1) * (r.R * 0.55 + hash(i, k + h) * 10);
        const gx = s.x - s.uy * o;
        const gy = s.y + s.ux * o;
        g.moveTo(gx, gy);
        g.lineTo(gx + (hash(k, i) - 0.5) * 3, gy - 4);
      }
    }
    g.stroke();
  }
  for (const r of vis) {
    const h = roadHash(r.key);
    for (let i = 0; i < r.samples.length; i += 3) {
      const s = r.samples[i]!;
      if (s.bridge || !inB(s, 10)) continue;
      if (hash(i, h + 3) > 0.35) continue;
      const o = (hash(i, h + 4) - 0.5) * s.r * 1.4;
      const x = s.x - s.uy * o;
      const y = s.y + s.ux * o;
      const rr = 1.2 + hash(i, h + 5) * 3;
      const t = hash(i, h + 6);
      g.fillStyle = `rgb(${(150 + t * 50) | 0},${(148 + t * 46) | 0},${(140 + t * 40) | 0})`;
      g.beginPath();
      g.ellipse(x, y, rr, rr * 0.75, t * 3, 0, 7);
      g.fill();
      g.strokeStyle = "rgba(52,48,44,.55)";
      g.lineWidth = 0.7;
      g.stroke();
    }
  }
}

/** Bridges: weathered planks, piles where they meet the bank, a rope rail. → whether any was drawn. */
export function paintBridges(
  g: Ctx,
  roads: readonly Road[],
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): boolean {
  const inB = inBox(bx0, by0, bx1, by1);
  let any = false;
  for (const r of visibleRoads(roads, bx0, by0, bx1, by1)) {
    const h = roadHash(r.key);
    const list = r.samples;
    for (let i = 0; i < list.length; i += 2) {
      const s = list[i]!;
      if (!s.bridge || !inB(s, 40)) continue;
      const t = hash(i, h + 11);
      const bw = r.kind === "link" ? 22 : 20;
      g.save();
      g.translate(s.x, s.y);
      g.rotate(Math.atan2(s.uy, s.ux));
      g.fillStyle = "rgba(20,40,55,.3)";
      g.fillRect(-4, bw - 2, 9, 10);
      g.fillStyle = `rgb(${(118 + t * 30) | 0},${(100 + t * 24) | 0},${(76 + t * 18) | 0})`;
      g.fillRect(-4, -bw, 8, bw * 2);
      g.strokeStyle = INK;
      g.lineWidth = 0.9;
      g.strokeRect(-4, -bw, 8, bw * 2);
      const prev = list[Math.max(0, i - 2)]!;
      const nxt = list[Math.min(list.length - 1, i + 2)]!;
      if (prev.bridge !== nxt.bridge || hash(i, h + 12) < 0.07) {
        g.fillStyle = "#4e3e2c";
        g.fillRect(-2, -bw - 10, 5, 12);
        g.fillRect(-2, bw - 2, 5, 12);
        g.strokeStyle = INK;
        g.strokeRect(-2, -bw - 10, 5, 12);
        g.strokeRect(-2, bw - 2, 5, 12);
      }
      g.strokeStyle = "rgba(86,70,50,.9)";
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(-4, -bw - 4);
      g.lineTo(5, -bw - 4);
      g.moveTo(-4, bw + 4);
      g.lineTo(5, bw + 4);
      g.stroke();
      g.restore();
      any = true;
    }
  }
  return any;
}

/** A district square: packed earth and a few worn flagstones. */
export function paintSquare(g: Ctx, q: Square): void {
  const rnd = seeded(strHash(`sq:${q.key}`));
  g.fillStyle = "rgba(96,84,52,.25)";
  blob(g, q.x, q.y, q.r + 10, rnd, 16, 0.12);
  g.fill();
  g.fillStyle = "#c9b68e";
  blob(g, q.x, q.y, q.r, rnd, 16, 0.1);
  g.fill();
  const n = Math.round(140 * (q.r / 140) ** 2);
  for (let i = 0; i < n; i++) {
    const a = rnd() * 7;
    const r = q.r * 0.2 + Math.sqrt(rnd()) * q.r * 0.72;
    const x = q.x + Math.cos(a) * r;
    const y = q.y + Math.sin(a) * r * 0.7;
    const t = rnd();
    g.fillStyle = `rgb(${(168 + t * 30) | 0},${(160 + t * 26) | 0},${(140 + t * 22) | 0})`;
    g.beginPath();
    g.moveTo(x - 7, y - 4);
    g.lineTo(x + 6 + rnd() * 3, y - 5);
    g.lineTo(x + 7, y + 4);
    g.lineTo(x - 6, y + 4 + rnd() * 2);
    g.closePath();
    g.fill();
    g.strokeStyle = "rgba(70,60,45,.45)";
    g.lineWidth = 0.8;
    g.stroke();
  }
}

/** An empty lot: a fenced patch of turned earth with weeds and a bare stake — room for the next app. */
export function paintLot(g: Ctx, p: Plot): void {
  const rnd = seeded(strHash(`lot:${p.id}`));
  const w = (p.g[2] - p.g[0]) * 0.72;
  const x0 = p.x - w / 2;
  const x1 = p.x + w / 2;
  const y0 = p.y - 70;
  const y1 = p.y + 4;
  g.fillStyle = "rgba(120,100,64,.32)";
  blob(g, p.x, (y0 + y1) / 2, w * 0.52, rnd, 12, 0.18);
  g.fill();
  for (let i = 0; i < 26; i++) {
    const x = x0 + rnd() * w;
    const y = y0 + rnd() * (y1 - y0);
    g.strokeStyle = rnd() < 0.5 ? "rgba(70,82,40,.65)" : "rgba(150,150,90,.6)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 4, y - 4 - rnd() * 5);
    g.stroke();
  }
  const post = (x: number, y: number) => {
    g.fillStyle = "#6d5638";
    g.fillRect(x - 2, y - 14, 4, 14);
    g.strokeStyle = INK;
    g.lineWidth = 0.8;
    g.strokeRect(x - 2, y - 14, 4, 14);
  };
  const rail = (ax: number, ay: number, bx: number, by: number) => {
    g.strokeStyle = "rgba(122,100,70,.95)";
    g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(ax, ay - 10);
    g.lineTo(bx, by - 10);
    g.moveTo(ax, ay - 5);
    g.lineTo(bx, by - 5);
    g.stroke();
  };
  const n = Math.max(2, Math.round(w / 34));
  for (let i = 0; i <= n; i++) {
    const x = x0 + (w * i) / n;
    if (i < n && rnd() > 0.2) rail(x, y0, x0 + (w * (i + 1)) / n, y0);
    post(x, y0);
  }
  for (const x of [x0, x1]) {
    if (rnd() > 0.25) rail(x, y0, x, y1 - 14);
    post(x, (y0 + y1 - 14) / 2);
    post(x, y1 - 14);
  }
  g.fillStyle = "#7b6549";
  g.fillRect(p.x + w * 0.22 - 1.5, y1 - 34, 3, 30);
  g.fillStyle = "#e8dcc0";
  g.beginPath();
  g.roundRect(p.x + w * 0.22 - 9, y1 - 40, 18, 11, 2);
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 0.9;
  g.stroke();
}

export const SIGN_FONT = "800 14px Nunito, sans-serif";

/** A building's signpost as the sign painter sees it. */
export interface SignInfo {
  readonly x: number;
  readonly y: number;
  readonly name: string;
  /** Half the board's width + 4 (placement's `signHalfWidth`). */
  readonly signHalf: number;
  /** The icon tile's colour. */
  readonly tile: string;
  /** The app's glyph, white, square. */
  readonly glyph: CanvasImageSource;
}

/** The signpost; hover 0..1 lifts and brightens the board. The name is fitted to the board placement reserved. */
export function drawSign(g: Ctx, s: SignInfo, hover: number): void {
  g.save();
  g.translate(s.x, s.y);
  g.fillStyle = "rgba(30,30,20,.28)";
  g.beginPath();
  g.ellipse(5, 1, 12, 4, 0, 0, 7);
  g.fill();
  g.fillStyle = "#6d5638";
  g.fillRect(-2.5, -38, 5, 38);
  g.strokeStyle = INK;
  g.lineWidth = 1;
  g.strokeRect(-2.5, -38, 5, 38);
  g.font = SIGN_FONT;
  const bw = (s.signHalf - 4) * 2;
  const room = bw - 44;
  const tw = g.measureText(s.name).width;
  const bx = -bw / 2;
  const by = -68 - 3 * hover;
  g.fillStyle = "rgba(30,25,15,.3)";
  g.beginPath();
  g.roundRect(bx + 2, by + 3, bw, 30, 4);
  g.fill();
  g.fillStyle = "#5a4630";
  g.beginPath();
  g.roundRect(bx - 2, by - 2, bw + 4, 34, 5);
  g.fill();
  g.fillStyle = "#ece0c2";
  g.beginPath();
  g.roundRect(bx, by, bw, 30, 3.5);
  g.fill();
  if (hover > 0) {
    g.globalAlpha *= hover;
    g.fillStyle = "#f8f0dc";
    g.fill();
    g.globalAlpha /= hover;
  }
  g.fillStyle = "rgba(120,96,60,.14)";
  g.fillRect(bx + 2, by + 22, bw - 4, 6);
  g.fillStyle = s.tile;
  g.beginPath();
  g.roundRect(bx + 5, by + 4, 22, 22, 4);
  g.fill();
  g.drawImage(s.glyph, bx + 8, by + 7.5, 16, 16);
  g.fillStyle = "#2e2418";
  g.textAlign = "left";
  g.textBaseline = "middle";
  if (tw > room) {
    g.translate(bx + 33, by + 16);
    g.scale(room / tw, 1);
    g.fillText(s.name, 0, 0);
  } else g.fillText(s.name, bx + 33, by + 16);
  g.restore();
}
