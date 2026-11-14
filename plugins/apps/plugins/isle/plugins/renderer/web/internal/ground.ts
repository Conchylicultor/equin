// The ground: water / sand / grass coloured per pixel from the island heights
// (`ground-pixels.ts`, in a bake worker when there are some), baked per 512 px
// world tile with its texture (surf, grass strokes, pebbles,
// wildflowers, hill hachures, the river's streaks), plus the tile's water mask
// (where animated water may paint) and the reeds that stand at the water's edge.
// Bakes are generators: they yield between slices so a frame stays within its
// budget. Each tile is self-contained, so tiles bake in any order and join
// seamlessly.

import {
  LAKE,
  RIVER,
  hash,
  riverWidth,
  type Island,
  type WorldModel,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import { blob, canvas, ctx2d, seeded, type Ctx, type Rnd } from "./kit";
import type { FurnitureStore } from "./furniture";
import {
  ABYSS_C,
  DEEP_C,
  GT,
  elevationOver,
  groundKernel,
  heightOver,
  mixTo,
  PREVIEW_Q,
  previewKernel,
  type GroundKernel,
  type PixelKernel,
  type PreviewKernel,
  type Rgb,
} from "./ground-pixels";
import type { Pixels } from "./bake-protocol";

export { GT, heightOver };

const sm = (t: number) => t * t * (3 - 2 * t);

/** What a bake step yields while a worker colours its pixels: nothing to do on the page meanwhile. */
export const WAIT = Symbol("isle bake: waiting on a worker");
export type BakeStep = typeof WAIT | undefined;

/**
 * Pixels being coloured elsewhere (a bake worker): `null` while pending,
 * `"failed"` when the worker could not (the page colours them itself).
 */
export interface PixelJob<K extends PixelKernel> {
  done: Pixels<K> | "failed" | null;
}

/** The kernel's pixels: the worker's when it coloured them, else coloured here a row at a time within `sliceMs`. */
function* coloured<K extends PixelKernel>(
  job: PixelJob<K> | null,
  make: () => K,
  sliceMs: number,
): Generator<BakeStep, Pixels<K>, void> {
  while (job && job.done === null) yield WAIT;
  if (job && job.done !== null && job.done !== "failed") return job.done;
  const k = make();
  let t0 = performance.now();
  for (let y = 0; y < k.h; y++) {
    k.rows(y, y + 1);
    if (performance.now() - t0 > sliceMs) {
      yield;
      t0 = performance.now();
    }
  }
  return k;
}

/** Bytes as a canvas. */
function pixelCanvas(
  img: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
) {
  const c = canvas(w, h);
  ctx2d(c).putImageData(new ImageData(img, w, h), 0, 0);
  return c;
}

function periodicNoise(x: number, y: number, P: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = sm(x - xi);
  const v = sm(y - yi);
  const m = (n: number) => ((n % P) + P) % P;
  const a = hash(m(xi), m(yi));
  const b = hash(m(xi + 1), m(yi));
  const c = hash(m(xi), m(yi + 1));
  const d = hash(m(xi + 1), m(yi + 1));
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** The open sea: one seamless 512 px texture, tiled under everything. */
export function oceanTexture(): HTMLCanvasElement {
  const N = 512;
  const c = canvas(N, N);
  const g = ctx2d(c);
  const img = g.createImageData(N, N);
  const d = img.data;
  const col: Rgb = [0, 0, 0];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const streak = periodicNoise(x / 64, y / 16, 8) - 0.5;
      const wob = periodicNoise(x / 128, y / 128, 4) - 0.5;
      const grain = periodicNoise(x / 3.2, y / 3.2, 160) - 0.5;
      mixTo(col, DEEP_C, ABYSS_C, 0.55 + wob * 0.5);
      const i = (y * N + x) * 4;
      d[i] = col[0] + streak * 14 + grain * 6;
      d[i + 1] = col[1] + streak * 14 + grain * 6;
      d[i + 2] = col[2] + streak * 14 + grain * 6;
      d[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}

/** An island's coarse preview (1/8 resolution), shown where a tile is not baked yet. */
export interface Preview {
  readonly c: HTMLCanvasElement;
  readonly x: number;
  readonly y: number;
  /** Preview px per world px. */
  readonly k: number;
}

export function* bakePreview(
  M: WorldModel,
  I: Island,
  job: PixelJob<PreviewKernel> | null,
): Generator<BakeStep, Preview, void> {
  const p = yield* coloured(job, () => previewKernel(M, I), 4);
  return { c: pixelCanvas(p.img, p.w, p.h), x: p.x, y: p.y, k: 1 / PREVIEW_Q };
}

/** A seeded stream that knows its seed and how many numbers it handed out, so a draw can be replayed. */
interface Counted extends Rnd {
  seed: number;
  n: number;
}
function counted(seed: number): Counted {
  const r = seeded(seed);
  const f = (() => {
    f.n++;
    return r();
  }) as Counted;
  f.seed = seed;
  f.n = 0;
  return f;
}

/** A reed clump, replayed from its stream's seed and position. */
export interface Reed {
  readonly x: number;
  readonly y: number;
  readonly s: number;
  readonly n: number;
}

export interface GroundTile {
  readonly c: HTMLCanvasElement;
  /** Where animated water may paint: opaque on water, fading to nothing at the sand line (n × n, 1 px margin). */
  readonly mask: HTMLCanvasElement;
  readonly reeds: readonly Reed[];
}

const DEN = 1 / (3200 * 2400); // texture densities below are "per home island of the old size"

export function* bakeGroundTile(
  M: WorldModel,
  tx: number,
  ty: number,
  near: readonly Island[],
  furniture: FurnitureStore,
  job: PixelJob<GroundKernel> | null,
): Generator<BakeStep, GroundTile, void> {
  const X0 = tx * GT;
  const Y0 = ty * GT;
  const H = heightOver(M, near);
  const E = near.some((J) => J.hills.length) ? elevationOver(M, near) : null;
  const reeds: Reed[] = [];
  const px = yield* coloured(job, () => groundKernel(M, tx, ty, near), 5);
  const n = px.w;
  const lo = pixelCanvas(px.img, n, n);
  const mask = pixelCanvas(px.mask, n, n);
  const c = canvas(GT, GT);
  const g = ctx2d(c);
  g.imageSmoothingQuality = "high";
  g.drawImage(lo, 1, 1, n - 2, n - 2, 0, 0, GT, GT);
  g.save();
  g.beginPath();
  g.rect(0, 0, GT, GT);
  g.clip();
  g.translate(-X0, -Y0);
  g.lineCap = "round";
  const inT = (x: number, y: number, m: number) =>
    x > X0 - m && x < X0 + GT + m && y > Y0 - m && y < Y0 + GT + m;
  // surf: lacy curls along the beach, thinning out to sea
  for (const I of near)
    furniture.of(I).coast.forEach((f, ci) => {
      if (!inT(f.x, f.y, 110)) return;
      const rnd = seeded(I.id * 1000003 + ci * 7919 + 17);
      const tx2 = -f.ny;
      const ty2 = f.nx;
      for (let k = 0; k < 7; k++) {
        const off = k < 3 ? rnd() * 10 : 10 + rnd() * 70;
        const len = 5 + rnd() * 14;
        const a = k < 3 ? 0.75 + rnd() * 0.2 : 0.55 * (1 - off / 85);
        const cx = f.x + f.nx * off + tx2 * (rnd() - 0.5) * 14;
        const cy = f.y + f.ny * off + ty2 * (rnd() - 0.5) * 14;
        const curl = (rnd() - 0.3) * 7;
        const lw = k < 3 ? 1.8 + rnd() * 1.6 : 0.8 + rnd() * 1;
        const hook = rnd() < 0.35;
        g.strokeStyle = `rgba(250,252,250,${a})`;
        g.lineWidth = lw;
        g.beginPath();
        g.moveTo(cx - tx2 * len, cy - ty2 * len);
        g.quadraticCurveTo(
          cx + f.nx * curl,
          cy + f.ny * curl,
          cx + tx2 * len,
          cy + ty2 * len,
        );
        if (hook)
          g.quadraticCurveTo(
            cx + tx2 * len * 1.4 - f.nx * 4,
            cy + ty2 * len * 1.4 - f.ny * 4,
            cx + tx2 * len * 0.9 - f.nx * 6,
            cy + ty2 * len * 0.9 - f.ny * 6,
          );
        g.stroke();
      }
      if (rnd() < 0.6) {
        g.fillStyle = "rgba(255,255,255,.28)";
        g.beginPath();
        g.ellipse(
          f.x + f.nx * 4,
          f.y + f.ny * 4,
          6 + rnd() * 8,
          3 + rnd() * 3,
          Math.atan2(ty2, tx2),
          0,
          7,
        );
        g.fill();
      }
    });
  yield;
  // grass strokes, darker clumps, pebbles, wildflowers: each 512 px cell places its own, neighbours' reach in
  const area = GT * GT * DEN;
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      const cx = tx + di;
      const cy = ty + dj;
      const bx = cx * GT;
      const by = cy * GT;
      const base = ((cx * 73856093) ^ (cy * 19349663)) >>> 0;
      let r = seeded(base + 1);
      const grass = [new Path2D(), new Path2D(), new Path2D()] as const;
      for (let k = 0, nn = Math.round(60000 * area); k < nn; k++) {
        const x = bx + r() * GT;
        const y = by + r() * GT;
        const a = r();
        const b = r();
        const e = r();
        if (!inT(x, y, 6)) continue;
        if (H(x, y) < 0.09) continue;
        const P = grass[a < 0.55 ? 0 : a < 0.85 ? 1 : 2];
        P.moveTo(x, y);
        P.lineTo(x + (b - 0.5) * 3, y - 2.5 - e * 4);
      }
      g.lineWidth = 1;
      [
        "rgba(58,68,32,.45)",
        "rgba(150,158,92,.45)",
        "rgba(196,190,130,.5)",
      ].forEach((col, i) => {
        g.strokeStyle = col;
        g.stroke(grass[i as 0 | 1 | 2]);
      });
      r = seeded(base + 2);
      for (let k = 0, nn = Math.round(2600 * area); k < nn; k++) {
        const x = bx + r() * GT;
        const y = by + r() * GT;
        const rr = r();
        const ks = r();
        if (!inT(x, y, 12) || H(x, y) < 0.1) continue;
        const ri = seeded((ks * 4294967296) >>> 0);
        g.fillStyle = "rgba(70,82,40,.55)";
        blob(g, x, y, 3 + rr * 5, ri, 7, 0.5);
        g.fill();
        g.strokeStyle = "rgba(40,44,24,.35)";
        g.lineWidth = 0.8;
        g.beginPath();
        g.arc(x, y + 1, 4, 0.2, 2.9);
        g.stroke();
      }
      r = seeded(base + 3);
      for (let k = 0, nn = Math.round(5200 * area); k < nn; k++) {
        const x = bx + r() * GT;
        const y = by + r() * GT;
        const keep = r();
        const rr = r();
        const t = r();
        const rot = r();
        if (!inT(x, y, 6)) continue;
        const hv = H(x, y);
        if (hv < 0.025 || (hv > 0.075 && keep > 0.15)) continue;
        const rad = 1.2 + rr * 2.4;
        g.fillStyle = `rgb(${(150 + t * 50) | 0},${(148 + t * 46) | 0},${(140 + t * 40) | 0})`;
        g.beginPath();
        g.ellipse(x, y, rad, rad * 0.75, rot * 3, 0, 7);
        g.fill();
        g.strokeStyle = "rgba(52,48,44,.55)";
        g.lineWidth = 0.7;
        g.stroke();
      }
      r = seeded(base + 4);
      for (let k = 0, nn = Math.round(1600 * area); k < nn; k++) {
        const x = bx + r() * GT;
        const y = by + r() * GT;
        const col = r();
        const o = [r(), r(), r(), r(), r(), r()] as const;
        if (!inT(x, y, 6) || H(x, y) < 0.12) continue;
        g.fillStyle = [
          "rgba(236,232,214,.85)",
          "rgba(196,184,214,.8)",
          "rgba(222,196,120,.8)",
        ][(col * 3) | 0]!;
        for (let q = 0; q < 3; q++) {
          g.beginPath();
          g.arc(
            x + (o[q * 2]! - 0.5) * 6,
            y + (o[q * 2 + 1]! - 0.5) * 4,
            1.1,
            0,
            7,
          );
          g.fill();
        }
      }
      // hachures down the hills' slopes, the old map-maker's way
      if (E) {
        r = seeded(base + 5);
        g.lineWidth = 1;
        g.strokeStyle = "rgba(62,56,34,.34)";
        g.beginPath();
        for (let k = 0, nn = Math.round(9000 * area); k < nn; k++) {
          const x = bx + r() * GT;
          const y = by + r() * GT;
          const keep = r();
          const len = 5 + r() * 7;
          if (!inT(x, y, 14) || H(x, y) < 0.12) continue;
          const ex = (E(x + 6, y) - E(x - 6, y)) / 12;
          const ey = (E(x, y + 6) - E(x, y - 6)) / 12;
          const gl = Math.hypot(ex, ey);
          if (gl < 0.0007 || keep > gl * 900) continue;
          g.moveTo(x, y);
          g.lineTo(x - (ex / gl) * len, y - (ey / gl) * len);
        }
        g.stroke();
      }
      yield; // a neighbouring cell at a time, so a bake step stays within a frame's budget
    }
  yield;
  const home = near.find((I) => I.home);
  if (home) {
    // the river: streaks following the current, reeds along the banks and round the lake
    for (let i = 1; i < RIVER.length; i++) {
      const [ax, ay] = RIVER[i - 1]!;
      const [bx, by] = RIVER[i]!;
      const L = Math.hypot(bx - ax, by - ay);
      const ux = (bx - ax) / L;
      const uy = (by - ay) / L;
      const w = riverWidth(i / (RIVER.length - 1));
      if (!inT(ax, ay, 220) && !inT(bx, by, 220)) continue;
      for (let s = 0, k = 0; s < L; s += 7, k++) {
        const rnd = seeded(i * 100003 + k * 31 + 5);
        const x = ax + ux * s;
        const y = ay + uy * s;
        for (let q = 0; q < 2; q++) {
          const o = (rnd() - 0.5) * w * 1.5;
          const px2 = x - uy * o;
          const py2 = y + ux * o;
          const len = 14 + rnd() * 36;
          const light = rnd() < 0.5;
          const al = rnd();
          const lw = 1.5 + rnd() * 3;
          if (!inT(px2, py2, 40) || M.height(home, px2, py2) > -0.012) continue;
          g.strokeStyle = light
            ? `rgba(240,250,250,${0.05 + al * 0.07})`
            : `rgba(28,70,110,${0.05 + al * 0.06})`;
          g.lineWidth = lw;
          g.beginPath();
          g.moveTo(px2 - (ux * len) / 2, py2 - (uy * len) / 2);
          g.quadraticCurveTo(
            px2 + uy * 2,
            py2 - ux * 2,
            px2 + (ux * len) / 2,
            py2 + (uy * len) / 2,
          );
          g.stroke();
        }
      }
    }
    const reed = (x: number, y: number, rnd: Counted) =>
      reeds.push({ x, y, s: rnd.seed, n: rnd.n });
    for (let i = 0; i < 9000; i++) {
      const rnd = counted(i * 2654435761 + 99);
      const a = rnd();
      const k = Math.min(RIVER.length - 2, (a * (RIVER.length - 1)) | 0);
      const f = rnd();
      const side = rnd() < 0.5 ? -1 : 1;
      const oo = rnd();
      const keep = rnd();
      if (keep >= 0.09 || k / (RIVER.length - 1) >= 0.86) continue;
      const [ax, ay] = RIVER[k]!;
      const [bx, by] = RIVER[k + 1]!;
      const w = riverWidth(k / (RIVER.length - 1));
      const L = Math.hypot(bx - ax, by - ay);
      const o = side * (w + oo * 16);
      const x = ax + (bx - ax) * f - ((by - ay) / L) * o;
      const y = ay + (by - ay) * f + ((bx - ax) / L) * o;
      if (!inT(x, y, 24)) continue;
      const hv = M.height(home, x, y);
      if (hv > 0.02 && hv < 0.11) reed(x, y, rnd);
    }
    for (let i = 0; i < 260; i++) {
      const rnd = counted(i * 40503 + 7);
      const a = rnd() * 7;
      const rr = 0.92 + rnd() * 0.22;
      const keep = rnd();
      const x = LAKE.c[0] + Math.cos(a) * LAKE.rx * rr;
      const y = LAKE.c[1] + Math.sin(a) * LAKE.ry * rr;
      if (keep >= 0.5 || !inT(x, y, 24)) continue;
      const hv = M.height(home, x, y);
      if (hv > 0.02 && hv < 0.11) reed(x, y, rnd);
    }
    yield;
  }
  // foam swirling round the boulders that stand in water
  for (const I of near)
    furniture.of(I).rocks.forEach((rk, ri) => {
      if (
        rk.land ||
        !inT(rk.x, rk.y, rk.s * 2) ||
        M.height(I, rk.x, rk.y) > 0.02
      )
        return;
      const rnd = seeded(I.id * 7777 + ri * 131 + 3);
      for (let k = 0; k < 3; k++) {
        const rr = rk.s * (1.15 + k * 0.28);
        g.strokeStyle = `rgba(248,250,248,${0.7 - k * 0.2})`;
        g.lineWidth = 2.2 - k * 0.5;
        for (
          let a = rnd() * 6, end = Math.PI * 2 + rnd() * 6;
          a < end;
          a += 0.55 + rnd() * 0.5
        ) {
          g.beginPath();
          g.ellipse(
            rk.x,
            rk.y + rk.s * 0.2,
            rr,
            rr * 0.45,
            0,
            a,
            a + 0.3 + rnd() * 0.4,
          );
          g.stroke();
        }
      }
    });
  g.restore();
  return { c, mask, reeds };
}

function reedDraw(g: Ctx, x: number, y: number, rnd: Rnd): void {
  const nn = 4 + ((rnd() * 6) | 0);
  for (let k = 0; k < nn; k++) {
    const bx = x + (rnd() - 0.5) * 12;
    const hh = 8 + rnd() * 11;
    const lean = (rnd() - 0.5) * 5;
    const dark = rnd() < 0.6;
    const cat = rnd() < 0.25;
    g.strokeStyle = dark ? "rgba(70,78,38,.9)" : "rgba(150,140,82,.9)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(bx, y);
    g.quadraticCurveTo(bx + lean * 0.3, y - hh * 0.6, bx + lean, y - hh);
    g.stroke();
    if (cat) {
      g.fillStyle = "#5a4330";
      g.beginPath();
      g.ellipse(bx + lean * 0.9, y - hh + 1.5, 1.2, 2.6, 0, 0, 7);
      g.fill();
    }
  }
  g.strokeStyle = "rgba(40,40,24,.4)";
  g.lineWidth = 0.7;
  g.beginPath();
  g.moveTo(x - 6, y + 0.5);
  g.lineTo(x + 6, y + 0.5);
  g.stroke();
}

/** Reeds stand over the water, so they belong to a tile's object layer, not its ground. → whether any was drawn. */
export function drawReeds(
  g: Ctx,
  reeds: readonly Reed[],
  X0: number,
  Y0: number,
  X1: number,
  Y1: number,
): boolean {
  let any = false;
  for (const o of reeds) {
    if (o.x < X0 - 24 || o.x > X1 + 24 || o.y < Y0 - 4 || o.y > Y1 + 30)
      continue;
    const rnd = seeded(o.s);
    for (let k = 0; k < o.n; k++) rnd();
    reedDraw(g, o.x, o.y, rnd);
    any = true;
  }
  return any;
}
