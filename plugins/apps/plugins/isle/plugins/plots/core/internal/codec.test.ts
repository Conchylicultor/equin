import { describe, expect, test } from "bun:test";
import { kitBuilding } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import {
  WorldModel,
  applyMove,
  moveTargets,
  placeResidents,
  residentOf,
  type Resident,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import { APP_CATEGORIES } from "@plugins/primitives/plugins/pane/core";
import { geometryOf, placementOfRows, placementWrites } from "./codec";
import type { PlotWrite } from "./endpoints";
import type { IslePlotRow } from "./schemas";

const M = new WorldModel(1);
const app = (i: number): Resident => {
  const a = {
    id: `app-${i}`,
    name: `App ${i}`,
    category: APP_CATEGORIES[i % APP_CATEGORIES.length]!,
  };
  return residentOf(a, kitBuilding(a, a.category));
};

/** A store of rows, applying writes with the server's compare-and-set. */
function store() {
  const rows = new Map<string, IslePlotRow>();
  return {
    rows: () => [...rows.values()],
    apply(writes: readonly PlotWrite[], moved = false): "applied" | "stale" {
      for (const w of writes) {
        const r = rows.get(w.plot.id);
        if (
          w.expect.kind === "absent" ? r : !r || r.occupant !== w.expect.appId
        )
          return "stale";
      }
      // as the server does: the written plots are vacated first, then each
      // takes its occupant — who must stand nowhere else (the unique index)
      const written = new Set(writes.map((w) => w.plot.id));
      for (const r of rows.values())
        if (written.has(r.plotId)) r.occupant = null;
      for (const w of writes) {
        for (const r of rows.values())
          if (w.occupant !== null && r.occupant === w.occupant)
            throw new Error(`unique: ${w.occupant} already on ${r.plotId}`);
        rows.set(w.plot.id, {
          world: "1",
          plotId: w.plot.id,
          slot: w.plot.slot,
          n: w.plot.n,
          seq: w.plot.seq,
          category: w.plot.category,
          geometry: geometryOf(w.plot),
          occupant: w.occupant,
          movedByUser: moved || (rows.get(w.plot.id)?.movedByUser ?? false),
        });
      }
      return "applied";
    },
  };
}

const normal = (p: unknown) => JSON.parse(JSON.stringify(p)) as unknown;

describe("isle plots codec", () => {
  test("round-trips placeResidents' placement exactly, lots reused and left empty", () => {
    const db = store();
    let apps = Array.from({ length: 12 }, (_, i) => app(i));
    const step = (present: Resident[]) => {
      const before = placementOfRows(db.rows());
      const next = placeResidents(M, before, present);
      expect(db.apply(placementWrites(before, next))).toBe("applied");
      const back = placementOfRows(db.rows());
      // what the store holds is what placement answered (bar stale mappings of absent apps)
      for (const r of present)
        expect(back.occupant[r.id]).toBe(next.occupant[r.id]);
      expect(normal(back.plots)).toEqual(normal(next.plots));
      // a second pass changes nothing
      expect(placementWrites(back, placeResidents(M, back, present))).toEqual(
        [],
      );
    };
    step(apps);
    // remove two apps: their plots stay, as empty lots
    apps = apps.filter((a) => a.id !== "app-3" && a.id !== "app-7");
    step(apps);
    const lots = placementOfRows(db.rows());
    expect(Object.values(lots.plots).flat().length).toBe(12);
    // a new app may take one of those lots
    apps = [...apps, app(20), app(21)];
    step(apps);
  });

  test("a stale writer loses: the second identical claim is stale", () => {
    const db = store();
    const apps = Array.from({ length: 5 }, (_, i) => app(i));
    const before = placementOfRows([]);
    const writes = placementWrites(before, placeResidents(M, before, apps));
    expect(db.apply(writes)).toBe("applied");
    expect(db.apply(writes)).toBe("stale");
  });

  test("a move round-trips, and swaps keep one app per plot", () => {
    const db = store();
    const apps = Array.from({ length: 10 }, (_, i) => app(i));
    db.apply(
      placementWrites(
        placementOfRows([]),
        placeResidents(M, placementOfRows([]), apps),
      ),
    );
    const before = placementOfRows(db.rows());
    const targets = moveTargets(M, before, apps, "app-0");
    expect(targets.length).toBeGreaterThan(0);
    for (const t of [
      targets.find((x) => x.kind === "new"),
      targets.find((x) => x.kind === "plot"),
    ]) {
      if (!t) continue;
      const cur = placementOfRows(db.rows());
      const fresh = moveTargets(M, cur, apps, "app-0").find(
        (x) => x.kind === t.kind && x.plot.id === t.plot.id,
      );
      if (!fresh) continue;
      const next = applyMove(M, cur, apps, "app-0", fresh);
      expect(db.apply(placementWrites(cur, next), true)).toBe("applied");
      const back = placementOfRows(db.rows());
      expect(back.occupant["app-0"]).toBe(fresh.plot.id);
      expect(normal(back.plots)).toEqual(normal(next.plots));
    }
  });
});
