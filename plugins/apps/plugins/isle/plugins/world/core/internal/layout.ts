// The revealed world: from the placement, which islands show, which roads are
// built (the trunks the districts need, their streets as far as their last
// plot, every door's lane, bridges and ferries), which squares, buildings and
// empty lots stand. Pure data — what the renderer draws and the walker walks.

import { fnv1a32 } from "@plugins/packages/plugins/string-hash/core";
import type { Box } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import { arcsOf, cutAt, roadCurve, type Pt } from "./geometry";
import { vnoise } from "./noise";
import {
  districtCategory,
  type Placement,
  type Plot,
  type Resident,
} from "./placement";
import { ROAD_R, trunkOf } from "./roads";
import { plotBox, sitesOf } from "./sites";
import type { Island, Slot, WorldModel } from "./world-model";

export type RoadKind = "trunk" | "street" | "lane" | "spur" | "link";

export interface RoadSample {
  readonly x: number;
  readonly y: number;
  /** The road's direction here. */
  readonly ux: number;
  readonly uy: number;
  /** Half-width here, px. */
  readonly r: number;
  /** On or right beside water: a bridge plank. */
  readonly bridge: boolean;
}

export interface Road {
  /** Stable across layouts while the road is the same. */
  readonly key: string;
  readonly pts: readonly Pt[];
  readonly kind: RoadKind;
  /** Half-width, px. */
  readonly R: number;
  /** Samples every 4 px. */
  readonly samples: readonly RoadSample[];
  readonly bbox: Box;
}

export interface Square {
  readonly key: string;
  readonly slot: string;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** Busy enough for a well. */
  readonly well: boolean;
  /** The busiest home square holds the campfire. */
  readonly camp: boolean;
  readonly n: number;
}

export interface PlacedBuilding {
  readonly appId: string;
  readonly plot: Plot;
  readonly x: number;
  readonly y: number;
  /** Its solid base (from the footprint). */
  readonly w: number;
  readonly depth: number;
  /** Its signpost's x, door-relative. */
  readonly signX: number;
  /** Everything its plot reserves, world px. */
  readonly box: Box;
  readonly door: Pt;
}

export interface Ferry {
  readonly key: string;
  readonly a: Pt;
  readonly b: Pt;
  /** Phase offset of the crossing, 0..1. */
  readonly ph: number;
}

export interface Pier {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly ang: number;
}

export interface Layout {
  readonly islands: readonly Island[];
  /** Districts with at least one shown plot. */
  readonly active: readonly Slot[];
  readonly roads: readonly Road[];
  readonly squares: readonly Square[];
  readonly buildings: readonly PlacedBuilding[];
  /** Plots nobody present stands on. */
  readonly lots: readonly Plot[];
  readonly ferries: readonly Ferry[];
  readonly piers: readonly Pier[];
  /** The home dock, when home shows. */
  readonly dock: {
    readonly at: Pt;
    readonly nx: number;
    readonly ny: number;
  } | null;
  /** The world's extent: every revealed island, with sea round it. */
  readonly rect: Box;
}

function roadSamples(
  pts: readonly Pt[],
  R: number,
  height: (x: number, y: number) => number,
): { samples: RoadSample[]; bbox: Box } {
  const out: {
    x: number;
    y: number;
    ux: number;
    uy: number;
    r: number;
    wet: boolean;
  }[] = [];
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!;
    const [bx, by] = pts[i]!;
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 0.01) continue;
    const ux = (bx - ax) / L;
    const uy = (by - ay) / L;
    for (let s = 0; s < L; s += 4) {
      const x = ax + ux * s;
      const y = ay + uy * s;
      out.push({
        x,
        y,
        ux,
        uy,
        r: R * (0.75 + vnoise(x / 26, y / 26) * 0.5),
        wet: height(x, y) < 0.04,
      });
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const samples = out.map((s, i) => ({
    x: s.x,
    y: s.y,
    ux: s.ux,
    uy: s.uy,
    r: s.r,
    bridge:
      s.wet ||
      out[Math.max(0, i - 4)]!.wet ||
      out[Math.min(out.length - 1, i + 4)]!.wet,
  }));
  return { samples, bbox: [x0 - 40, y0 - 40, x1 + 40, y1 + 40] };
}

/**
 * Lays the world out for the present residents (`residents` — the apps shown;
 * a plot whose app is absent is an empty lot).
 */
export function layoutWorld(
  M: WorldModel,
  placement: Placement,
  residents: readonly Resident[],
): Layout {
  const byId = new Map(residents.map((r) => [r.id, r]));
  const occupantOf = new Map<string, string>();
  for (const r of residents) {
    const pid = placement.occupant[r.id];
    if (pid && !occupantOf.has(pid)) occupantOf.set(pid, r.id);
  }
  const shownOf = (s: Slot): readonly Plot[] => placement.plots[s.id] ?? [];
  const active = M.slots.filter(
    (s) => districtCategory(placement, s.id) !== null && shownOf(s).length,
  );
  const activeSet = new Set(active);
  const isl = new Set([0]);
  for (const s of active) {
    let I: Island | null = s.island;
    while (I && !isl.has(I.id)) {
      isl.add(I.id);
      I = I.parent !== null ? M.island(I.parent) : null;
    }
  }
  const islands = M.islands.filter((I) => isl.has(I.id));
  type RawRoad = { key: string; pts: readonly Pt[]; kind: RoadKind; R: number };
  const roads: RawRoad[] = [];
  const squares: Square[] = [];
  const lots: Plot[] = [];
  const buildings: PlacedBuilding[] = [];
  const ferries: Ferry[] = [];
  const piers: Pier[] = [];
  const frontLandings = new Set<number>();
  for (const I of islands) {
    const T = trunkOf(M, I);
    const need = new Set<number>();
    const mark = (k0: number) => {
      let k = k0;
      while (k > 0 && !need.has(k)) {
        need.add(k);
        k = T.par[k]!;
      }
    };
    I.slots.forEach((s, k) => {
      if (!activeSet.has(s)) return;
      mark(k + 1);
      for (const p of shownOf(s)) {
        if (p.edge) mark(p.edge);
        if (p.landing !== null) frontLandings.add(p.landing);
      }
    });
    for (const l of T.landings) {
      if (isl.has(l.island) || frontLandings.has(l.island)) {
        mark(l.slotNode);
        roads.push({
          key: `ld:${M.seed}:${l.island}`,
          pts: l.pts,
          kind: "trunk",
          R: 21,
        });
      }
    }
    if (I.home && !need.size && I.slots.length) mark(1);
    need.forEach((k) =>
      roads.push({
        key: `tr:${M.seed}:${I.id}:${k}`,
        pts: T.edges[k - 1]!.pts,
        kind: "trunk",
        R: 22,
      }),
    );
    // a square only where buildings surround it (no empty squares with just a well)
    for (const s of I.slots) {
      if (!activeSet.has(s)) continue;
      const sh = shownOf(s);
      const ring = sh.filter((p) => p.ring).length;
      const near = sh.filter(
        (p) => Math.hypot(p.x - s.x, p.y - s.y) < 560,
      ).length;
      if (ring >= 2 && near >= 3) {
        squares.push({
          key: `${M.seed}:${s.id}`,
          slot: s.id,
          x: s.x,
          y: s.y,
          r: s.r,
          well: near >= 4,
          camp: false,
          n: sh.length,
        });
      }
    }
    if (I.parent !== null) {
      const P = M.island(I.parent);
      const la = M.landingOn(I, P.cx, P.cy);
      const lb = M.landingOn(P, I.cx, I.cy);
      if (I.link === "bridge") {
        roads.push({
          key: `br:${M.seed}:${I.id}`,
          pts: roadCurve(la, lb, `${M.seed}:br:${I.id}`, 0.08),
          kind: "link",
          R: 20,
        });
      } else {
        const a = M.coastOn(I, P.cx, P.cy);
        const b = M.coastOn(P, I.cx, I.cy);
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const u: Pt = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
        const pa: Pt = [a[0] + u[0] * 150, a[1] + u[1] * 150];
        const pb: Pt = [b[0] - u[0] * 150, b[1] - u[1] * 150];
        roads.push(
          { key: `pa:${M.seed}:${I.id}`, pts: [la, a], kind: "trunk", R: 18 },
          { key: `pb:${M.seed}:${I.id}`, pts: [lb, b], kind: "trunk", R: 18 },
        );
        piers.push(
          {
            key: `pier:${M.seed}:${I.id}:a`,
            x: a[0] - u[0] * 20,
            y: a[1] - u[1] * 20,
            ang: Math.atan2(u[1], u[0]),
          },
          {
            key: `pier:${M.seed}:${I.id}:b`,
            x: b[0] + u[0] * 20,
            y: b[1] + u[1] * 20,
            ang: Math.atan2(-u[1], -u[0]),
          },
        );
        ferries.push({
          key: `fy:${M.seed}:${I.id}`,
          a: pa,
          b: pb,
          ph: (I.id * 0.37) % 1,
        });
      }
    }
  }
  // the campfire burns on the busiest home square
  const homeSquares = squares.filter(
    (q) => M.slotById.get(q.slot)!.island.home,
  );
  const camp = homeSquares.sort(
    (p, q) =>
      q.n - p.n || M.slotById.get(p.slot)!.k - M.slotById.get(q.slot)!.k,
  )[0];
  const finalSquares = squares.map((q) =>
    q === camp ? { ...q, camp: true } : q,
  );
  for (const s of active) {
    const shown = shownOf(s);
    const D = sitesOf(M, s.island).sites.get(s.id)!;
    // each street runs out of the square as far as its last plot
    D.streets.forEach((S, i) => {
      const far = Math.max(
        -1,
        ...shown.filter((p) => p.street === i).map((p) => p.arc ?? -1),
      );
      if (far < 0) return;
      const L = Math.min(S.arcs[S.arcs.length - 1]!, far + 30);
      roads.push({
        key: `st:${M.seed}:${s.id}:${i}:${Math.round(L)}`,
        pts: cutAt(S.pts, S.arcs, L),
        kind: "street",
        R: ROAD_R.street,
      });
    });
    for (const p of shown) {
      roads.push({
        key: `ln:${M.seed}:${p.id}`,
        pts: p.lane,
        kind: arcsOf(p.lane).at(-1)! > 300 ? "lane" : "spur",
        R: ROAD_R.spur,
      });
      const appId = occupantOf.get(p.id);
      const app = appId ? byId.get(appId) : undefined;
      if (appId && app) {
        buildings.push({
          appId,
          plot: p,
          x: p.x,
          y: p.y,
          w: app.footprint.w,
          depth: app.footprint.depth,
          signX: p.sx,
          box: plotBox(p),
          door: [p.x, p.y + 18],
        });
      } else lots.push(p);
    }
  }
  const height = (x: number, y: number) => M.heightAt(x, y, islands);
  const built: Road[] = roads.map((r) => ({
    ...r,
    ...roadSamples(r.pts, r.R, height),
  }));
  const bounds = islands.map((I) => I.bounds);
  const rect: Box = [
    Math.min(...bounds.map((b) => b[0])) - 300,
    Math.min(...bounds.map((b) => b[1])) - 300,
    Math.max(...bounds.map((b) => b[2])) + 300,
    Math.max(...bounds.map((b) => b[3])) + 300,
  ];
  return {
    islands,
    active,
    roads: built,
    squares: finalSquares,
    buildings,
    lots,
    ferries,
    piers,
    dock: islands[0]?.home ? M.homeDock() : null,
    rect,
  };
}

/** A stable small number per road key (for per-road variation in the renderer). */
export const roadHash = (key: string): number => fnv1a32(key) % 9973;
