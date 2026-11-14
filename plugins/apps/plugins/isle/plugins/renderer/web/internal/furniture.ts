// Each island's fixed furniture, deterministic from (seed, island): the coast
// line (where surf curls), the boulders (on the coast, in the river, on land),
// the tree candidates, bushes and stumps. What of it stands is decided later,
// against the revealed roads and plots (scene.ts).

import {
  DOCK_ROOT,
  HOME_CX,
  HOME_CY,
  HOME_RX,
  HOME_RY,
  RIVER,
  fbm,
  riverWidth,
  type Island,
  type WorldModel,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import { ROCK_COUNT, rockSize, seeded, strHash, type Sprite } from "./kit";
import type { SpriteSet } from "./sprites";

export interface CoastPt {
  readonly x: number;
  readonly y: number;
  /** The outward normal (toward the sea). */
  readonly nx: number;
  readonly ny: number;
  readonly ph: number;
}

export interface RockSpot {
  readonly x: number;
  readonly y: number;
  readonly s: number;
  readonly sp: Sprite;
  readonly k?: number;
  readonly land?: boolean;
  readonly river?: boolean;
}

export interface TreeSpot {
  readonly x: number;
  readonly y: number;
  readonly s: Sprite;
  readonly k: number;
}

export interface ScatterSpot {
  readonly x: number;
  readonly y: number;
  readonly k: number;
  readonly v: number;
}

export interface Furniture {
  readonly coast: readonly CoastPt[];
  readonly rocks: readonly RockSpot[];
  readonly trees: readonly TreeSpot[];
  readonly bushes: readonly ScatterSpot[];
  readonly stumps: readonly ScatterSpot[];
}

/** A boulder as data: its sprite by index (`SpriteSet.rocks`). */
type RockData = Omit<RockSpot, "sp"> & { readonly ri: number };
/** A tree as data: its sprite by set and index. */
type TreeData = Omit<TreeSpot, "s"> & {
  readonly set: "trees" | "autumn";
  readonly i: number;
};

/**
 * An island's furniture as plain data (sprites by index): what a bake worker
 * builds and hands back, and what the page builds itself without workers.
 */
export interface FurnitureData {
  readonly coast: readonly CoastPt[];
  readonly rocks: readonly RockData[];
  readonly trees: readonly TreeData[];
  readonly bushes: readonly ScatterSpot[];
  readonly stumps: readonly ScatterSpot[];
}

/** Furniture per island, memoised per (world, island): built here, or adopted from a worker. */
export class FurnitureStore {
  private readonly memo = new Map<number, Furniture>();
  constructor(
    private readonly M: WorldModel,
    private readonly sprites: SpriteSet,
  ) {}

  of(I: Island): Furniture {
    let S = this.memo.get(I.id);
    if (!S)
      this.memo.set(I.id, (S = this.withSprites(buildFurniture(this.M, I))));
    return S;
  }

  has(I: Island): boolean {
    return this.memo.has(I.id);
  }

  /** The island's furniture built elsewhere (identical to what `of` builds); ignored once there is one. */
  adopt(I: Island, data: FurnitureData): void {
    if (!this.memo.has(I.id)) this.memo.set(I.id, this.withSprites(data));
  }

  private withSprites(d: FurnitureData): Furniture {
    const SP = this.sprites;
    return {
      coast: d.coast,
      rocks: d.rocks.map(({ ri, ...rk }) => ({ ...rk, sp: SP.rocks[ri]!.sp })),
      trees: d.trees.map(({ set, i, ...t }) => ({ ...t, s: SP[set][i]! })),
      bushes: d.bushes,
      stumps: d.stumps,
    };
  }
}

/** An island's furniture, deterministic from (seed, island). Pure: no sprite, no DOM. */
export function buildFurniture(M: WorldModel, I: Island): FurnitureData {
  const H = (x: number, y: number) => M.height(I, x, y);
  const r = seeded(strHash(`${M.seed}:stuff:${I.id}`));
  const coast: CoastPt[] = [];
  const Ld = I.shape.land;
  const mx = I.rx * 1.3 + 200;
  const my = I.ry * 1.3 + 200;
  const B = {
    x0: Math.min(I.cx + Ld[0] - 60, I.cx - mx),
    y0: Math.min(I.cy + Ld[1] - 60, I.cy - my),
    x1: Math.max(I.cx + Ld[2] + 60, I.cx + mx),
    y1: Math.max(I.cy + Ld[3] + 60, I.cy + my),
  };
  for (let y = I.cy + Ld[1] - 36; y < I.cy + Ld[3] + 36; y += 12)
    for (let x = I.cx + Ld[0] - 36; x < I.cx + Ld[2] + 36; x += 12) {
      const h0 = H(x, y);
      if (h0 < -0.25 || h0 > 0.25) continue;
      const h1 = H(x + 12, y);
      const h2 = H(x, y + 12);
      if (h0 > 0.02 === h1 > 0.02 && h0 > 0.02 === h2 > 0.02) continue;
      if (
        I.home &&
        Math.hypot((x - HOME_CX) / HOME_RX, (y - HOME_CY) / HOME_RY) < 0.66
      )
        continue;
      const gx = h1 - h0;
      const gy = h2 - h0;
      const L = Math.hypot(gx, gy) || 1;
      coast.push({ x, y, nx: -gx / L, ny: -gy / L, ph: r() * 7 });
    }
  const linkPts: (readonly [number, number])[] = [];
  for (const J of M.islands) {
    if (J.parent === I.id) linkPts.push(M.coastOn(I, J.cx, J.cy));
    if (I.parent === J.id) linkPts.push(M.coastOn(I, J.cx, J.cy));
  }
  if (I.home) linkPts.push(DOCK_ROOT);
  const clearOfLinks = (x: number, y: number, d: number) =>
    linkPts.every(([lx, ly]) => Math.hypot(x - lx, y - ly) > d);
  const rocks: RockData[] = [];
  const pick = (n: number) => {
    const ri = (r() * n) | 0;
    return { s: rockSize(ri), ri };
  };
  const riverEnd = RIVER[RIVER.length - 1]!;
  for (const f of coast) {
    if (r() > 0.09 || !clearOfLinks(f.x, f.y, 260)) continue;
    if (
      I.home &&
      Math.hypot(f.x - riverEnd[0], f.y - riverEnd[1]) < 200 &&
      r() < 0.6
    )
      continue;
    const n = 1 + ((r() * 4) | 0);
    for (let k = 0; k < n; k++) {
      const R = pick(ROCK_COUNT);
      const off = -10 + r() * 50;
      const side = (r() - 0.5) * 70;
      rocks.push({
        x: f.x + f.nx * off - f.ny * side,
        y: f.y + f.ny * off + f.nx * side,
        s: R.s,
        ri: R.ri,
      });
    }
  }
  if (I.home)
    for (let i = 0, made = 0; i < 400 && made < 9; i++) {
      const k = 2 + ((r() * (RIVER.length * 0.8)) | 0);
      const [x0r, y0r] = RIVER[k]!;
      const [x1r, y1r] = RIVER[k + 1]!;
      const L = Math.hypot(x1r - x0r, y1r - y0r);
      const w = riverWidth(k / (RIVER.length - 1));
      const o = (r() < 0.5 ? -1 : 1) * w * (0.45 + r() * 0.4);
      const x = x0r - ((y1r - y0r) / L) * o;
      const y = y0r + ((x1r - x0r) / L) * o;
      if (H(x, y) > -0.01) continue;
      const R = pick(3);
      rocks.push({ x, y, s: R.s * 0.8, ri: R.ri, k: 0.8, river: true });
      made++;
    }
  const area = (4 * mx * my) / (3624 * 2740);
  const rx = () => B.x0 + r() * (B.x1 - B.x0);
  const ry = () => B.y0 + r() * (B.y1 - B.y0);
  for (let i = 0; i < 40 * area; i++) {
    const x = rx();
    const y = ry();
    if (H(x, y) < 0.15) continue;
    const R = pick(6);
    rocks.push({ x, y, s: R.s, ri: R.ri, land: true });
  }
  const nearSquare = (x: number, y: number, pad: number) =>
    I.slots.some((s) => Math.hypot(x - s.x, y - s.y) < s.r + pad);
  const trees: TreeData[] = [];
  for (let i = 0; i < 12000 * area && trees.length < 1000 * area; i++) {
    const x = rx();
    const y = ry();
    const hv = H(x, y);
    if (hv < 0.13) continue;
    const forest = fbm(x / 280 + 40 + I.id * 13, y / 280, 3);
    if (forest < 0.5 && r() > 0.08) continue;
    if (
      nearSquare(x, y, 50) ||
      rocks.some((o) => Math.hypot(o.x - x, o.y - y) < o.s + 14) ||
      trees.some((t) => Math.hypot(t.x - x, (t.y - y) * 1.2) < 34)
    )
      continue;
    const autumn = fbm(x / 500 + 7, y / 500 + 3, 2) > 0.6 && r() < 0.45;
    const conif = fbm(x / 400 + 70, y / 400, 2) > 0.52;
    const s: { set: "trees" | "autumn"; i: number } = autumn
      ? { set: "autumn", i: (r() * 2) | 0 }
      : conif && r() < 0.75
        ? { set: "trees", i: 8 + ((r() * 3) | 0) }
        : { set: "trees", i: (r() * 8) | 0 };
    trees.push({ x, y, ...s, k: 0.82 + r() * 0.36 });
  }
  const scatter = (n: number, minH = 0.12): ScatterSpot[] => {
    const out: ScatterSpot[] = [];
    for (let i = 0; i < n * 3; i++) {
      const x = rx();
      const y = ry();
      if (
        H(x, y) > minH &&
        !nearSquare(x, y, 30) &&
        !trees.some((t) => Math.hypot(t.x - x, t.y - y) < 26)
      )
        out.push({ x, y, k: 0.8 + r() * 0.4, v: (r() * 4) | 0 });
      if (out.length >= n) break;
    }
    return out;
  };
  const bushes = scatter(Math.round(70 * area));
  const stumps = scatter(Math.round(18 * area));
  return { coast, rocks, trees, bushes, stumps };
}
