// The drawable world from the layout: what stands on the ground (rocks,
// trees, bushes, stumps, lamp posts, the well and campfire, the buildings, the
// dock and piers) filtered against the revealed roads, plots and squares,
// sorted by depth and indexed per tile; the night lights; the solids the
// walker goes round; and the keyed items whose appearing or vanishing marks
// tiles stale.

import type { Box } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import {
  plotBox,
  pointIndex,
  type Layout,
  type Solid,
  type WorldModel,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import type { SceneBuilding } from "./buildings";
import type { FurnitureStore } from "./furniture";
import { put, type Ctx, type Sprite } from "./kit";
import { DOCK_LEN, type SpriteSet } from "./sprites";

export const TILE = 512;

/** Something drawn into a tile's object layer, and re-drawn as a cut-out over a person behind it. */
export interface Static {
  readonly key: string;
  /** Its depth: the ground line it stands on. */
  readonly y: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly draw: (g: Ctx, solid?: boolean) => void;
  readonly tree?: boolean;
  readonly building?: SceneBuilding;
}

export interface Scene {
  readonly layout: Layout;
  readonly buildings: readonly SceneBuilding[];
  readonly statics: readonly Static[];
  readonly tileObjs: ReadonlyMap<string, readonly Static[]>;
  /** Every keyed thing on a tile, for dirty tracking. */
  readonly items: ReadonlyMap<string, Box>;
  /** Night lights: [x, y, r]. */
  readonly lights: readonly (readonly [number, number, number])[];
  readonly solids: readonly Solid[];
}

/** What a static's draw reads at draw time (it changes with the time of day). */
export interface SceneEnv {
  lamp(): Sprite;
  drawBuilding(g: Ctx, b: SceneBuilding, solid: boolean): void;
}

const boxesHit = (a: Box, b: Box) =>
  !(a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3]);

export function realizeScene(
  M: WorldModel,
  layout: Layout,
  buildings: readonly SceneBuilding[],
  furniture: FurnitureStore,
  SP: SpriteSet,
  env: SceneEnv,
): Scene {
  const H = (x: number, y: number) => M.heightAt(x, y, layout.islands);
  const occ = pointIndex(48);
  for (const rd of layout.roads) occ.addLine(rd.pts, 8);
  // nothing else may stand in a plot's box (buildings and empty lots alike)
  const pboxes: Box[] = [
    ...layout.buildings.map((b) => b.box),
    ...layout.lots.map((p) => plotBox(p)),
  ];
  const boxClear = (o: Box) => !pboxes.some((B) => boxesHit(o, B));
  const inSq = (x: number, y: number, pad: number) =>
    layout.squares.some(
      (q) => Math.hypot(x - q.x, (y - q.y) * 1.1) < q.r + pad,
    );
  const box = (x: number, y: number, sp: Sprite, k = 1): Box => [
    x - sp.ax * k,
    y - sp.ay * k,
    x - sp.ax * k + sp.w * k,
    y - sp.ay * k + sp.h * k,
  ];
  const statics: Static[] = [];
  const solids: Solid[] = [];
  const stat = (
    key: string,
    y: number,
    b: Box,
    draw: Static["draw"],
    extra: Partial<Static> = {},
  ) =>
    statics.push({
      key,
      y,
      x0: b[0],
      y0: b[1],
      x1: b[2],
      y1: b[3],
      draw,
      ...extra,
    });
  for (const I of layout.islands) {
    const S = furniture.of(I);
    S.rocks.forEach((rk, i) => {
      const k = rk.k ?? 1;
      const o = box(rk.x, rk.y, rk.sp, k);
      if (
        occ.near(rk.x, rk.y, rk.s + 18) ||
        !boxClear(o) ||
        (rk.land && inSq(rk.x, rk.y, 20))
      )
        return;
      stat(`r:${M.seed}:${I.id}:${i}`, rk.y, o, (g, solid) =>
        put(g, rk.sp, rk.x, rk.y, k, solid),
      );
      if (rk.land) solids.push([rk.x, rk.y, rk.s * 0.6]);
    });
    S.trees.forEach((t, i) => {
      const o = box(t.x, t.y, t.s, t.k);
      if (occ.near(t.x, t.y, 36) || !boxClear(o) || inSq(t.x, t.y, 50)) return;
      stat(
        `t:${M.seed}:${I.id}:${i}`,
        t.y,
        o,
        (g, solid) => put(g, t.s, t.x, t.y, t.k, solid),
        { tree: true },
      );
      solids.push([t.x, t.y - 2, 6 * t.k]);
    });
    S.bushes.forEach((o, i) => {
      const sp = SP.props.bushes[o.v]!;
      const b = box(o.x, o.y, sp, o.k);
      if (occ.near(o.x, o.y, 28) || !boxClear(b) || inSq(o.x, o.y, 20)) return;
      stat(`bu:${M.seed}:${I.id}:${i}`, o.y, b, (g, solid) =>
        put(g, sp, o.x, o.y, o.k, solid),
      );
      solids.push([o.x, o.y, 10]);
    });
    S.stumps.forEach((o, i) => {
      const sp = SP.props.stump;
      const b = box(o.x, o.y, sp);
      if (occ.near(o.x, o.y, 28) || !boxClear(b) || inSq(o.x, o.y, 20)) return;
      stat(`su:${M.seed}:${I.id}:${i}`, o.y, b, (g, solid) =>
        put(g, sp, o.x, o.y, 1, solid),
      );
      solids.push([o.x, o.y, 7]);
    });
  }
  const lights: [number, number, number][] = [];
  // lamp posts along the roads, alternating sides, every ~230 px of road
  const lampDay = SP.props.lamp.day;
  for (const rd of layout.roads) {
    if (rd.kind === "spur" || rd.kind === "link") continue;
    const list = rd.samples;
    for (let i = 30, n = 0; i < list.length - 10; i += 58, n++) {
      const s = list[i]!;
      const side = n % 2 ? 1 : -1;
      const x = s.x - s.uy * 32 * side;
      const y = s.y + s.ux * 32 * side;
      const b = box(x, y, lampDay);
      if (H(x, y) < 0.1 || !boxClear(b) || inSq(x, y, 0) || occ.near(x, y, 16))
        continue;
      stat(`l:${rd.key}:${n}`, y, b, (g, solid) =>
        put(g, env.lamp(), x, y, 1, solid),
      );
      solids.push([x, y, 5]);
      lights.push([x, y - 52, 58]);
    }
  }
  for (const q of layout.squares) {
    if (q.camp) {
      stat(`camp:${q.key}`, q.y - 4, box(q.x, q.y, SP.campStones), (g, solid) =>
        put(g, SP.campStones, q.x, q.y, 1, solid),
      );
      solids.push([q.x, q.y, 22]);
      (
        [
          [-118, 20, SP.props.barrel],
          [-100, 40, SP.props.sacks],
          [120, 52, SP.props.crates],
        ] as const
      ).forEach(([dx, dy, sp], j) => {
        const x = q.x + dx;
        const y = q.y + dy;
        stat(`campd:${q.key}:${j}`, y, box(x, y, sp), (g, solid) =>
          put(g, sp, x, y, 1, solid),
        );
        solids.push([x, y, 10]);
      });
    }
    if (!q.well) continue;
    const wx = q.x + q.r * 0.55;
    const wy = q.y - q.r * 0.25;
    stat(`well:${q.key}`, wy, box(wx, wy, SP.props.well), (g, solid) =>
      put(g, SP.props.well, wx, wy, 1, solid),
    );
    solids.push([wx, wy, 20]);
  }
  for (const b of buildings) {
    const [x0, y0, x1, y1] = b.bounds;
    stat(
      b.key,
      b.y,
      [b.x + x0, b.y + y0, b.x + x1, b.y + y1],
      (g, solid) => env.drawBuilding(g, b, solid ?? false),
      {
        building: b,
      },
    );
  }
  const dock = layout.dock;
  if (dock) {
    const [x, y] = dock.at;
    const da = Math.atan2(dock.ny, dock.nx);
    const ex = x + Math.cos(da) * DOCK_LEN;
    const ey = y + Math.sin(da) * DOCK_LEN;
    stat(
      "dock",
      -1e6,
      [
        Math.min(x, ex) - 40,
        Math.min(y, ey) - 40,
        Math.max(x, ex) + 40,
        Math.max(y, ey) + 40,
      ],
      (g, solid) => {
        g.save();
        g.translate(x, y);
        g.rotate(da);
        put(g, SP.dock, 0, 0, 1, solid);
        g.restore();
      },
    );
  }
  for (const p of layout.piers)
    stat(
      p.key,
      -1e6 + 1,
      [p.x - 220, p.y - 220, p.x + 220, p.y + 220],
      (g, solid) => {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.ang);
        g.scale(0.75, 1);
        put(g, SP.dock, 0, 0, 1, solid);
        g.restore();
      },
    );
  // the ground overlays, keyed too, for dirty tracking
  const items = new Map<string, Box>();
  for (const rd of layout.roads) items.set(rd.key, rd.bbox);
  for (const q of layout.squares)
    items.set(`sq:${q.key}:${q.r.toFixed(0)}`, [
      q.x - q.r - 20,
      q.y - q.r - 20,
      q.x + q.r + 20,
      q.y + q.r + 20,
    ]);
  for (const p of layout.lots) items.set(`lot:${p.id}`, plotBox(p));
  for (const f of layout.ferries)
    items.set(f.key, [
      Math.min(f.a[0], f.b[0]) - 20,
      Math.min(f.a[1], f.b[1]) - 20,
      Math.max(f.a[0], f.b[0]) + 20,
      Math.max(f.a[1], f.b[1]) + 20,
    ]);
  for (const o of statics) items.set(o.key, [o.x0, o.y0, o.x1, o.y1]);
  const order = statics.map((o, i) => ({ o, i }));
  order.sort((a, b) => a.o.y - b.o.y || a.i - b.i);
  const sorted = order.map((e) => e.o);
  const tileObjs = new Map<string, Static[]>();
  for (const o of sorted)
    for (let ty = Math.floor(o.y0 / TILE); ty <= Math.floor(o.y1 / TILE); ty++)
      for (
        let tx = Math.floor(o.x0 / TILE);
        tx <= Math.floor(o.x1 / TILE);
        tx++
      ) {
        const k = `${tx}:${ty}`;
        let a = tileObjs.get(k);
        if (!a) tileObjs.set(k, (a = []));
        a.push(o);
      }
  return {
    layout,
    buildings,
    statics: sorted,
    tileObjs,
    items,
    lights,
    solids,
  };
}
