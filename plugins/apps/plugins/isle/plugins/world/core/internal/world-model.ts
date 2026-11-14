// The archipelago: an endless, deterministic world from one seed. Home is the
// hand-shaped Equin Isle; more islands are generated around it, each with
// district slots. Everything here is a pure function of the seed — slot n of an
// island is always in the same place — and is computed lazily (an island's
// shape is rasterised only when something reads it), then memoised.

import { fnv1a32 } from "@plugins/packages/plugins/string-hash/core";
import { mulberry32 } from "@plugins/packages/plugins/seeded-random/core";
import type { Setting } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import type { Pt } from "./geometry";
import {
  DOCK_ROOT,
  HOME_CX,
  HOME_CY,
  HOME_HILLS,
  HOME_RX,
  HOME_RY,
  HOME_SHAPE_SEED,
  HOME_SLOTS,
  LAKE,
  RIVER,
  homeCarve,
} from "./home";
import { planIsland, type IslandPlan, type IslandShape } from "./island-shape";
import { fbm } from "./noise";

/** How many islands the archipelago holds. */
export const ISLAND_COUNT = 18;
const ISLAND_NAMES = [
  "Brindle Isle",
  "Saltmarsh Key",
  "Heron Isle",
  "Cobble Rock",
  "Lantern Isle",
  "Fernholm",
  "Gull Point",
  "Mossy Key",
  "Tern Isle",
  "Driftwood Isle",
  "Amber Holm",
  "Wren Isle",
  "Otter Holm",
  "Bramble Key",
  "Sorrel Isle",
  "Kestrel Rock",
  "Linden Isle",
  "Puffin Rock",
];
const SEA_MARGIN = 240;

export interface Hill {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** Height at the top. */
  readonly a: number;
}

/** A district slot: where a district (a square and its streets) may open. */
export class Slot {
  private pos: Pt | null = null;
  constructor(
    /** `<island>.<k>` */
    readonly id: string,
    readonly island: Island,
    readonly k: number,
    /** The square's radius. */
    readonly r: number,
    private readonly resolve: (s: Slot) => Pt,
  ) {}
  get x(): number {
    this.pos ??= this.resolve(this);
    return this.pos[0];
  }
  get y(): number {
    this.pos ??= this.resolve(this);
    return this.pos[1];
  }
}

export class Island {
  slots: readonly Slot[] = [];
  private shapeMemo: IslandShape | null = null;
  private hillsMemo: readonly Hill[] | null = null;
  private slotPtsMemo: readonly Pt[] | null = null;
  constructor(
    readonly id: number,
    readonly name: string,
    /** Centre, world px. */
    readonly cx: number,
    readonly cy: number,
    readonly rx: number,
    readonly ry: number,
    readonly home: boolean,
    readonly plan: IslandPlan,
    /** The island it was grown from (null for home). */
    readonly parent: number | null,
    /** How it is reached from its parent. */
    readonly link: "bridge" | "ferry" | null,
    private readonly hillsOf: (I: Island) => readonly Hill[],
  ) {}

  get shape(): IslandShape {
    this.shapeMemo ??= this.plan.build();
    return this.shapeMemo;
  }
  /** The island's extent once built, world px: where its height reads above open sea. */
  get bounds(): readonly [number, number, number, number] {
    const b = this.shape.bbox;
    return [
      this.cx + b[0] - 24,
      this.cy + b[1] - 24,
      this.cx + b[2] + 24,
      this.cy + b[3] + 24,
    ];
  }
  get hills(): readonly Hill[] {
    this.hillsMemo ??= this.hillsOf(this);
    return this.hillsMemo;
  }
  /** How many districts it holds. */
  get slotCount(): number {
    return this.home
      ? HOME_SLOTS.length
      : this.plan.kind === "crescent" || this.plan.kind === "fingers"
        ? 3
        : this.rx > 1250
          ? 4
          : 3;
  }
  /** The slots' points (n + 2: the last two are where hills go), world px. */
  slotPoints(): readonly Pt[] {
    if (this.slotPtsMemo) return this.slotPtsMemo;
    const n = this.slotCount;
    const S = this.shape;
    const P: Pt[] = S.sites(n + 2, 0.3).map(
      ([x, y]) => [x + this.cx, y + this.cy] as const,
    );
    while (P.length < n + 2)
      P.push([this.cx + S.heart[0] + P.length * 160, this.cy + S.heart[1]]);
    this.slotPtsMemo = P;
    return P;
  }
}

function islandHeight(I: Island, x: number, y: number): number {
  let h = I.shape.height(x - I.cx, y - I.cy);
  if (I.home) {
    const c = homeCarve(x, y);
    h = h > 0 ? Math.min(h, c) : Math.min(h, Math.max(c, -0.015));
  }
  return h;
}

/** The world's islands and slots for a seed — everything else is derived from it. */
export class WorldModel {
  readonly islands: readonly Island[];
  readonly slots: readonly Slot[];
  readonly slotById: ReadonlyMap<string, Slot>;
  private dock: { at: Pt; nx: number; ny: number } | null = null;

  constructor(readonly seed: number) {
    this.islands = archipelago(seed);
    const slots: Slot[] = [];
    for (const I of this.islands) {
      const n = I.slotCount;
      I.slots = Array.from({ length: n }, (_, k) => {
        const s = new Slot(
          `${I.id}.${k}`,
          I,
          k,
          I.home && k === 0 ? 136 : 118,
          (sl) => this.slotPosition(sl),
        );
        slots.push(s);
        return s;
      });
    }
    this.slots = slots;
    this.slotById = new Map(slots.map((s) => [s.id, s]));
  }

  private slotPosition(s: Slot): Pt {
    const I = s.island;
    if (I.home) {
      const [u, v] = HOME_SLOTS[s.k]!;
      let x = HOME_CX + u * HOME_RX;
      let y = HOME_CY + v * HOME_RY;
      for (let t = 0; t < 12 && this.height(I, x, y) < 0.28; t++) {
        x += (I.cx - x) * 0.12;
        y += (I.cy - y) * 0.12;
      }
      return [x, y];
    }
    return I.slotPoints()[s.k]!;
  }

  island(id: number): Island {
    const I = this.islands[id];
    if (!I) throw new Error(`isle world: no island ${id}`);
    return I;
  }

  /** The island's height at a world point: its shape, and on home the river and lake. */
  height(I: Island, x: number, y: number): number {
    return islandHeight(I, x, y);
  }
  /** The shape alone, without river and lake. */
  baseHeight(I: Island, x: number, y: number): number {
    return I.shape.height(x - I.cx, y - I.cy);
  }
  /** The highest island height at a world point (open sea: -1). */
  heightAt(
    x: number,
    y: number,
    islands: readonly Island[] = this.islands,
  ): number {
    let h = -1;
    for (const I of islands) {
      const b = I.bounds;
      if (x > b[0] && x < b[2] && y > b[1] && y < b[3]) {
        const v = this.height(I, x, y);
        if (v > h) h = v;
      }
    }
    return h;
  }
  /** Hill elevation at a world point (0 on flat ground). */
  elevation(I: Island, x: number, y: number): number {
    let e = 0;
    for (const h of I.hills) {
      const d2 = ((x - h.x) ** 2 + (y - h.y) ** 2) / (h.r * h.r);
      if (d2 < 9) e += h.a * Math.exp(-d2);
    }
    return e;
  }
  /** The field the trees grow from: > 0.55 is wood. */
  forest(I: Island, x: number, y: number): number {
    return fbm(x / 280 + 40 + I.id * 13, y / 280, 3);
  }
  /** Where a road reaches island I coming from (fx, fy): solid ground inside its nearest coast. */
  landingOn(I: Island, fx: number, fy: number): Pt {
    const p = I.shape.landingToward(fx - I.cx, fy - I.cy, 0.1, 36);
    return [p[0] + I.cx, p[1] + I.cy];
  }
  /** The coast point of I toward (fx, fy): where a bridge or a ferry pier starts. */
  coastOn(I: Island, fx: number, fy: number): Pt {
    const p = I.shape.coastToward(fx - I.cx, fy - I.cy);
    return [p[0] + I.cx, p[1] + I.cy];
  }
  /** The home dock: from the root road's start straight down the slope into the sea. */
  homeDock(): { at: Pt; nx: number; ny: number } {
    if (this.dock) return this.dock;
    const I = this.island(0);
    let [x, y] = DOCK_ROOT;
    const e = 6;
    const gx = this.height(I, x + e, y) - this.height(I, x - e, y);
    const gy = this.height(I, x, y + e) - this.height(I, x, y - e);
    const L = Math.hypot(gx, gy) || 1;
    const nx = -gx / L;
    const ny = -gy / L;
    while (this.height(I, x, y) > 0.05) {
      x += nx * 6;
      y += ny * 6;
    }
    this.dock = { at: [x - nx * 40, y - ny * 40], nx, ny };
    return this.dock;
  }
  /** Where island I's boats tie up: the home dock, or the pier toward its parent. */
  harbourOf(I: Island): Pt {
    if (I.home || I.parent === null) return this.homeDock().at;
    const P = this.island(I.parent);
    return this.coastOn(I, P.cx, P.cy);
  }
  /** How far (px) a point sits inside slot s's Voronoi cell on its island. */
  territoryMargin(s: Slot, x: number, y: number): number {
    const d0 = Math.hypot(x - s.x, y - s.y);
    let m = 1e9;
    for (const t of s.island.slots)
      if (t !== s) m = Math.min(m, (Math.hypot(x - t.x, y - t.y) - d0) / 2);
    return m;
  }
  /**
   * The terrain round a point: coast (the sea within reach), cape (sea on many
   * sides), shore (river or lake), harbour (by the dock / pier), hill, forest
   * (at a wood's edge). `square` and `lane` come from the plot, not the land.
   */
  terrainTags(I: Island, x: number, y: number): Set<Setting> {
    const tags = new Set<Setting>();
    let sea = 0;
    let seaFar = 0;
    let water = 0;
    let wood = 0;
    let n = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (const r of [110, 220, 340]) {
        const px = x + ca * r;
        const py = y - 30 + sa * r * 0.8;
        const hb = this.baseHeight(I, px, py);
        if (hb < 0.02) {
          sea++;
          if (r === 340) seaFar++;
        } else if (I.home && r < 340 && this.height(I, px, py) < 0.02) water++;
        else if (r > 110 && this.height(I, px, py) > 0.2) {
          n++;
          if (this.forest(I, px, py) > 0.55) wood++;
        }
      }
    }
    if (sea) tags.add("coast");
    if (seaFar >= 5) tags.add("cape");
    if (water) tags.add("shore");
    const H = this.harbourOf(I);
    if (Math.hypot(x - H[0], y - H[1]) < 560) tags.add("harbour");
    if (this.elevation(I, x, y) > 0.45) tags.add("hill");
    if (this.forest(I, x, y) < 0.52 && n && wood / n > 0.18) tags.add("forest");
    return tags;
  }
}

function homePlan(): IslandPlan {
  const L = (p: Pt): Pt => [p[0] - HOME_CX, p[1] - HOME_CY];
  return planIsland(HOME_SHAPE_SEED, {
    home: true,
    rx: HOME_RX,
    ry: HOME_RY,
    slope: 1100,
    keep: [
      {
        x: LAKE.c[0] - HOME_CX,
        y: LAKE.c[1] - HOME_CY,
        r: Math.max(LAKE.rx, LAKE.ry) + 200,
      },
      {
        pts: RIVER.filter((p) => p[0] < HOME_CX + 0.92 * HOME_RX).map(L),
        r: 170,
      },
      ...HOME_SLOTS.map(([u, v]) => ({
        x: u * HOME_RX,
        y: v * HOME_RY,
        r: 380,
      })),
      ...HOME_HILLS.map(([u, v]) => ({
        x: u * HOME_RX,
        y: v * HOME_RY,
        r: 260,
      })),
    ],
    cut: [{ x: 1.2 * HOME_RX, y: 0, r: 170 }],
    noLanding: RIVER.filter(
      (p, i) => p[0] > HOME_CX + 0.6 * HOME_RX && i % 4 === 0,
    ).map((p) => ({
      x: p[0] - HOME_CX,
      y: p[1] - HOME_CY,
      r: 360,
    })),
    harbour: {
      x: DOCK_ROOT[0] - HOME_CX,
      y: DOCK_ROOT[1] - HOME_CY + 60,
      nx: 0,
      ny: 1,
    },
  });
}

function hillsOf(seed: number) {
  return (I: Island): readonly Hill[] => {
    if (I.home) {
      return HOME_HILLS.map(([u, v, r, a]) => ({
        x: HOME_CX + u * HOME_RX,
        y: HOME_CY + v * HOME_RY,
        r,
        a,
      }));
    }
    const r = mulberry32(seed * 53 + I.id * 4099);
    const n = 1 + (r() < 0.6 ? 1 : 0);
    const P = I.slotPoints();
    const m = P.length - 2;
    return Array.from({ length: n }, (_, k) => ({
      x: P[m + k]![0],
      y: P[m + k]![1],
      r: 260 + r() * 120,
      a: 0.7 + r() * 0.3,
    }));
  };
}

/** Home, then ISLAND_COUNT - 1 islands spiralling out, each spaced from its nearest by its outline. */
function archipelago(seed: number): Island[] {
  const r = mulberry32(seed * 7919 + 13);
  const hills = hillsOf(seed);
  const out: Island[] = [
    new Island(
      0,
      "Equin Isle",
      HOME_CX,
      HOME_CY,
      HOME_RX,
      HOME_RY,
      true,
      homePlan(),
      null,
      null,
      hills,
    ),
  ];
  const radiusTo = (P: IslandPlan, a: number) => P.radiusTo(a) + SEA_MARGIN;
  let ang = -0.5 + r() * 0.6;
  for (let i = 1; i < ISLAND_COUNT; i++) {
    const rx = 1080 + r() * 380;
    const ry = rx * (0.68 + r() * 0.12);
    const far = r() < 0.35;
    const want = far ? 560 + r() * 240 : 190 + r() * 90;
    const plan = planIsland(fnv1a32(`${seed}:isle:${i}`), { rx, ry });
    let best: { cx: number; cy: number; parent: Island; gap: number } | null =
      null;
    for (let tries = 0; tries < 30 && !best; tries++) {
      const a = ang + (tries % 2 ? 1 : -1) * Math.ceil(tries / 2) * 0.28;
      for (let d = 500; d < 20000; d += 40) {
        const cx = HOME_CX + Math.cos(a) * d;
        const cy = HOME_CY + Math.sin(a) * d * 0.9;
        let minGap = 1e9;
        let parent: Island | null = null;
        for (const J of out) {
          const dx = cx - J.cx;
          const dy = cy - J.cy;
          const a2 = Math.atan2(dy, dx);
          const gap =
            Math.hypot(dx, dy) -
            radiusTo(J.plan, a2) -
            radiusTo(plan, a2 + Math.PI);
          if (gap < minGap) {
            minGap = gap;
            parent = J;
          }
        }
        if (minGap >= want && parent) {
          best = { cx, cy, parent, gap: minGap };
          break;
        }
      }
    }
    if (!best) throw new Error(`isle world ${seed}: no room for island ${i}`);
    ang += 2.39996;
    out.push(
      new Island(
        i,
        ISLAND_NAMES[(i - 1) % ISLAND_NAMES.length]!,
        best.cx,
        best.cy,
        rx,
        ry,
        false,
        plan,
        best.parent.id,
        best.gap < 430 ? "bridge" : "ferry",
        hills,
      ),
    );
  }
  return out;
}
