import { describe, expect, test } from "bun:test";
import {
  APP_CATEGORIES,
  type AppCategory,
} from "@plugins/primitives/plugins/pane/core";
import type { Setting } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import { fnv1a32 } from "@plugins/packages/plugins/string-hash/core";
import { layoutWorld } from "./layout";
import {
  EMPTY_PLACEMENT,
  islandsInPlay,
  placeResidents,
  plotById,
  signHalfWidth,
  type Placement,
  type Resident,
} from "./placement";
import { plotsClash } from "./sites";
import { findPath, walkable, walkGrid } from "./walk";
import { WorldModel } from "./world-model";

const CAT_SETTING: Record<AppCategory, readonly Setting[]> = {
  data: ["shore", "harbour"],
  system: ["hill"],
  life: ["square"],
  music: ["square"],
  work: ["lane"],
  create: ["forest"],
  play: ["lane", "square"],
};

/** A made-up app with a building of a size seeded from its id (no painting needed). */
function fakeResident(i: number): Resident {
  const id = `x-app-${i}`;
  const h = fnv1a32(id);
  const category = APP_CATEGORIES[i % APP_CATEGORIES.length]!;
  const half = [60, 75, 100, 85, 110][h % 5]!;
  const top = -(150 + (h % 140));
  return {
    id,
    category,
    footprint: {
      w: half * 1.6,
      depth: 60,
      ground: [-half - 30, -112, half + 40, 46],
      upper: [-half, top, half, -112],
    },
    setting: CAT_SETTING[category],
    signHalf: signHalfWidth(`App ${i}`),
  };
}

const residents = (n: number) =>
  Array.from({ length: n }, (_, i) => fakeResident(i));

function placedPlots(P: Placement, rs: readonly Resident[]) {
  return rs.map((r) => {
    const p = plotById(P, P.occupant[r.id]);
    if (!p) throw new Error(`${r.id} has no plot`);
    return p;
  });
}

function expectNoOverlap(P: Placement, rs: readonly Resident[]) {
  const plots = placedPlots(P, rs);
  for (let i = 0; i < plots.length; i++) {
    for (let j = i + 1; j < plots.length; j++) {
      const a = plots[i]!;
      const b = plots[j]!;
      if (plotsClash(a, b))
        throw new Error(`plots ${a.id} and ${b.id} overlap`);
    }
  }
}

describe("isle world", () => {
  test("the same seed and apps give a deep-equal world", () => {
    const rs = residents(14);
    const a = placeResidents(new WorldModel(7), EMPTY_PLACEMENT, rs);
    const b = placeResidents(new WorldModel(7), EMPTY_PLACEMENT, rs);
    expect(a).toEqual(b);
    const Ma = new WorldModel(7);
    const Mb = new WorldModel(7);
    expect(
      Ma.islands.map((I) => [I.id, I.cx, I.cy, I.parent, I.link, I.plan.kind]),
    ).toEqual(
      Mb.islands.map((I) => [I.id, I.cx, I.cy, I.parent, I.link, I.plan.kind]),
    );
    expect(Ma.slots.map((s) => [s.id, s.x, s.y])).toEqual(
      Mb.slots.map((s) => [s.id, s.x, s.y]),
    );
    // and a different seed gives a different archipelago
    expect(new WorldModel(8).islands.map((I) => I.cx)).not.toEqual(
      Ma.islands.map((I) => I.cx),
    );
  });

  test("placement does not mutate its input and keeps placed apps", () => {
    const M = new WorldModel(3);
    const first = placeResidents(M, EMPTY_PLACEMENT, residents(5));
    const snapshot = structuredClone(first);
    const again = placeResidents(M, first, residents(5));
    expect(first).toEqual(snapshot);
    expect(again).toEqual(first);
  });

  test("adding an app never moves an existing plot: 40 → 41", () => {
    const M = new WorldModel(1);
    const P40 = placeResidents(M, EMPTY_PLACEMENT, residents(40));
    const P41 = placeResidents(M, P40, residents(41));
    for (const r of residents(40)) {
      expect(P41.occupant[r.id]).toBe(P40.occupant[r.id]!);
      expect(plotById(P41, P41.occupant[r.id])).toEqual(
        plotById(P40, P40.occupant[r.id])!,
      );
    }
    expect(plotById(P41, P41.occupant["x-app-40"])).not.toBeNull();
  }, 120_000);

  test("adding apps one by one, 14 → 142, never moves a plot and never overlaps", () => {
    const M = new WorldModel(1);
    let P = placeResidents(M, EMPTY_PLACEMENT, residents(14));
    expectNoOverlap(P, residents(14));
    for (let n = 15; n <= 142; n++) {
      const before = P;
      P = placeResidents(M, before, residents(n));
      for (const r of residents(n - 1)) {
        expect(plotById(P, P.occupant[r.id])).toEqual(
          plotById(before, before.occupant[r.id])!,
        );
      }
      if (n === 40 || n === 142) expectNoOverlap(P, residents(n));
    }
    // more than one island by then
    const islands = new Set(
      Object.keys(P.plots).map((slot) => slot.split(".")[0]),
    );
    expect(islands.size).toBeGreaterThan(1);
  }, 600_000);

  test("no overlapping footprints at 40 and 142 apps placed at once", () => {
    for (const n of [40, 142]) {
      const rs = residents(n);
      const P = placeResidents(new WorldModel(2), EMPTY_PLACEMENT, rs);
      expectNoOverlap(P, rs);
    }
  }, 600_000);

  test("a removed app leaves a lot, and the lot is never lost", () => {
    const M = new WorldModel(4);
    const rs = residents(12);
    const P = placeResidents(M, EMPTY_PLACEMENT, rs);
    const without = rs.filter((r) => r.id !== "x-app-3");
    const layout = layoutWorld(M, P, without);
    expect(layout.lots.map((p) => p.id)).toEqual([P.occupant["x-app-3"]!]);
    expect(layout.buildings).toHaveLength(11);
  }, 120_000);

  test("an A* path stays on walkable land", () => {
    const M = new WorldModel(5);
    const rs = residents(24);
    const P = placeResidents(M, EMPTY_PLACEMENT, rs);
    const layout = layoutWorld(M, P, rs);
    const G = walkGrid(M, layout);
    const doors = layout.buildings.map((b) => b.door);
    let walked = 0;
    for (let i = 0; i + 1 < doors.length; i += 3) {
      const [a, b] = [doors[i]!, doors[i + 1]!];
      const path = findPath(G, a[0], a[1], b[0], b[1]);
      if (!path) continue;
      walked++;
      // every leg, sampled every 4 px, stays on walkable cells
      for (let k = 1; k < path.length; k++) {
        const [x0, y0] = path[k - 1]!;
        const [x1, y1] = path[k]!;
        const L = Math.hypot(x1 - x0, y1 - y0);
        for (let t = 0; t <= L; t += 4) {
          const x = x0 + ((x1 - x0) * t) / (L || 1);
          const y = y0 + ((y1 - y0) * t) / (L || 1);
          // walkable = land, or a bridge's planks over water
          if (!walkable(G, x, y))
            throw new Error(
              `path ${i} leaves the land at (${x.toFixed(0)}, ${y.toFixed(0)}) leg ${k}/${path.length - 1} ${JSON.stringify(path[k - 1])}→${JSON.stringify(path[k])} t=${t.toFixed(0)}/${L.toFixed(0)}`,
            );
        }
      }
    }
    expect(walked).toBeGreaterThan(3);
  }, 120_000);
});

describe("islands in play", () => {
  test("cover what the layout shows and where the next apps land", () => {
    const M = new WorldModel(1);
    let P = EMPTY_PLACEMENT;
    for (const n of [14, 40, 80]) {
      const inPlay = new Set(islandsInPlay(M, P).map((I) => I.id));
      const next = placeResidents(M, P, residents(n));
      for (const plot of placedPlots(next, residents(n)))
        expect(inPlay.has(M.slotById.get(plot.slot)!.island.id)).toBe(true);
      P = next;
      const shown = layoutWorld(M, P, residents(n)).islands.map((I) => I.id);
      const now = new Set(islandsInPlay(M, P).map((I) => I.id));
      for (const id of shown) expect(now.has(id)).toBe(true);
    }
  }, 120_000);
});
