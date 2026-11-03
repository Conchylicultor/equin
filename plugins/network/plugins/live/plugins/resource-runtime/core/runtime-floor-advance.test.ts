/**
 * Advancing a persisted alias's L2 floor to a routed cut (`routedCut`,
 * `PersistMeta` mode `advance` — research/2026-10-30-global-boot-catch-up-
 * per-key-floors.md, part B).
 *
 * A floor persist may SET the row's position to the cut only when, after the
 * cut resolved, the tuple is settled — a snapshot and base floor, no pending,
 * not draining, no change a drain took without applying — and the entry's
 * every change comes through the router. Every doubt writes the plain floor
 * persist (the snapshot's base floor, `LEAST`ed by the store), which these
 * cases pin one by one:
 *
 *   - settled + a cut → `advance` at the cut, the FULL-equal value;
 *   - an `unproven` cut, a throwing cut → `floor`;
 *   - a change routed before the cut resolved, still draining when the link
 *     runs → `floor` (the boundary: before the cut resolves is "below");
 *   - a change whose drain failed (unapplied) → `floor` until a whole read
 *     rebuilds the snapshot, then `advance` again;
 *   - a base floor above the cut (a FULL read after the cut's capture) → `floor`;
 *   - a drifted entry → `floor`;
 *   - a replace or a shutdown while the cut is in flight → nothing written by
 *     the window;
 *   - floor windows firing together share ONE cut.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createHarness, tick } from "./test-support";
import { defineRoutedTable } from "./testing/routed-fixture";
import type { PersistMeta, RoutedCut } from "./runtime";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));

interface Persisted {
  key: string;
  value: unknown;
  wm: string;
  mode: PersistMeta["mode"];
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

// A controllable cut: each call parks until `resolveCut` answers it.
function cutControl() {
  const waiting: Array<(c: RoutedCut) => void> = [];
  let calls = 0;
  return {
    routedCut: () =>
      new Promise<RoutedCut>((resolve) => {
        calls++;
        waiting.push(resolve);
      }),
    resolveCut(c: RoutedCut) {
      for (const r of waiting.splice(0)) r(c);
    },
    calls: () => calls,
  };
}

function fixture(
  routedCut: () => Promise<RoutedCut>,
  keys: readonly string[] = ["rows"],
) {
  const table = new Map<string, number>([
    ["a", 1],
    ["b", 2],
  ]);
  const full = () =>
    [...table.entries()]
      .map(([id, n]) => ({ id, n }))
      .sort((x, y) => (x.id < y.id ? -1 : 1));
  const persisted: Persisted[] = [];
  let wm = "100";
  let failFull = false;
  let parkScoped: Promise<void> | null = null;
  const h = createHarness({
    shouldPersist: (k) => keys.includes(k),
    persistWindowMs: 0,
    captureWatermark: async () => wm,
    persistSnapshot: async (key, _pk, value, w, meta) => {
      persisted.push({ key, value, wm: w, mode: meta.mode });
    },
    routedCut,
  });
  const feeds = keys.map((key) =>
    defineRoutedTable(h, {
      key,
      table: "row_table",
      membership: "alias",
      schema: rowsSchema,
      orderOf: async () => full().map((r) => r.id),
      loader: async (_p, c) => {
        if (!c) {
          if (failFull) throw new Error("FULL read failed");
          return full();
        }
        const park = parkScoped;
        parkScoped = null;
        if (park) await park;
        if (failFull) throw new Error("scoped read failed");
        return c.affectedIds
          .filter((id) => table.has(id))
          .map((id) => ({ id, n: table.get(id)! }));
      },
    }),
  );
  return {
    h,
    table,
    full,
    persisted,
    feed: feeds[0]!,
    setWm: (w: string) => {
      wm = w;
    },
    setFailFull: (f: boolean) => {
      failFull = f;
    },
    parkNextScoped: () => {
      let release!: () => void;
      parkScoped = new Promise<void>((r) => (release = r));
      return release;
    },
  };
}

// Subscribe (FULL seed at base floor "100"), then clear the replace persist.
async function seeded(f: ReturnType<typeof fixture>) {
  await f.h.subscribe("rows");
  await settle();
  f.persisted.length = 0;
}

describe("floor advance — the settled tuple takes the cut", () => {
  test("a settled tuple under a proven cut writes `advance` at the cut, with the FULL-equal value", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut);
    await seeded(f);
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle(); // drained; the window fired and waits on the cut
    expect(f.persisted).toEqual([]);
    expect(c.calls()).toBe(1);
    c.resolveCut({ kind: "cut", cutXid: "250" });
    await settle();
    expect(f.persisted).toEqual([
      { key: "rows", value: f.full(), wm: "250", mode: "advance" },
    ]);
  });

  test("an `unproven` cut lowers the floor as before (the snapshot's base)", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut);
    await seeded(f);
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle();
    c.resolveCut({ kind: "unproven", reason: "boot catch-up not done" });
    await settle();
    expect(f.persisted).toEqual([
      { key: "rows", value: f.full(), wm: "100", mode: "floor" },
    ]);
  });

  test("a cut that throws is an unproven cut: `floor`, nothing rejects", async () => {
    const f = fixture(() => Promise.reject(new Error("no LISTEN session")));
    await seeded(f);
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle();
    expect(f.persisted).toEqual([
      { key: "rows", value: f.full(), wm: "100", mode: "floor" },
    ]);
  });
});

describe("floor advance — doubt keeps the old floor", () => {
  test("a change routed before the cut resolved and still draining when the link runs → `floor`", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut);
    await seeded(f);
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle(); // the first window waits on the cut
    // A change lands just before the cut resolves; its refill parks, so the
    // tuple is draining when the floor link judges it.
    const release = f.parkNextScoped();
    f.table.set("b", 9);
    f.feed.feed("U", ["b"]);
    await tick();
    c.resolveCut({ kind: "cut", cutXid: "250" });
    await settle();
    expect(f.persisted.map((p) => [p.mode, p.wm])).toEqual([["floor", "100"]]);
    release();
    await settle();
    // Its own window then takes a fresh cut, and the tuple is settled.
    c.resolveCut({ kind: "cut", cutXid: "260" });
    await settle();
    expect(f.persisted.at(-1)).toEqual({
      key: "rows",
      value: f.full(),
      wm: "260",
      mode: "advance",
    });
  });

  test("a change routed while the cut runs and still pending → `floor`", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut);
    await seeded(f);
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle();
    // Routed in the same synchronous step that resolves the cut: its pending
    // exists when the link runs (the flush has not drained it yet).
    f.table.set("b", 9);
    f.feed.feed("U", ["b"]);
    c.resolveCut({ kind: "cut", cutXid: "250" });
    await tick();
    await tick();
    expect(f.persisted[0]?.mode).toBe("floor");
    expect(f.persisted[0]?.wm).toBe("100");
  });

  test("a change a drain took and failed to apply blocks every advance until a whole read rebuilds the snapshot", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut);
    await seeded(f);
    // The scoped refill AND its FULL fallback fail: the kept snapshot stays,
    // missing the change, and the pending is consumed.
    f.setFailFull(true);
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle();
    f.setFailFull(false);
    // A later change applies, and its window takes a proven cut — but the
    // snapshot still misses the first change.
    f.table.set("b", 9);
    f.feed.feed("U", ["b"]);
    await settle();
    c.resolveCut({ kind: "cut", cutXid: "250" });
    await settle();
    expect(f.persisted.map((p) => [p.mode, p.wm])).toEqual([["floor", "100"]]);
    // A whole read (the compact's recompute) rebuilds it at a new base…
    f.setWm("300");
    f.h.runtime.recomputeResource("rows");
    await settle();
    expect(f.persisted.at(-1)?.mode).toBe("replace");
    f.persisted.length = 0;
    // …after which a settled change advances again.
    f.table.set("a", 6);
    f.feed.feed("U", ["a"]);
    await settle();
    c.resolveCut({ kind: "cut", cutXid: "400" });
    await settle();
    expect(f.persisted).toEqual([
      { key: "rows", value: f.full(), wm: "400", mode: "advance" },
    ]);
  });

  test("a base floor above the cut (a FULL read after its capture) → `floor` at that base", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut);
    f.setWm("500");
    await seeded(f);
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle();
    c.resolveCut({ kind: "cut", cutXid: "250" });
    await settle();
    expect(f.persisted.map((p) => [p.mode, p.wm])).toEqual([["floor", "500"]]);
  });

  test("a drifted entry (a read no route names) never advances — no cut is even taken", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut);
    await seeded(f);
    f.h.runtime.seedRouteDrift([
      { key: "rows", tablesRead: ["row_table", "other_table"] },
    ]);
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle();
    expect(c.calls()).toBe(0);
    expect(f.persisted.map((p) => [p.mode, p.wm])).toEqual([["floor", "100"]]);
  });
  test("a snapshot read before the boot catch-up (the boot seed is skipped) never advances until a whole read", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut);
    // A sub-ack served before the LISTEN session: its snapshot predates the
    // catch-up, which judges the key by its row's (possibly advanced) floor.
    await seeded(f);
    expect(
      f.h.runtime.seedPersistedSnapshot("rows", "{}", f.full(), {
        position: "900",
        positionAt: null,
      }).kind,
    ).toBe("skipped");
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle();
    c.resolveCut({ kind: "cut", cutXid: "950" });
    await settle();
    expect(f.persisted.map((p) => [p.mode, p.wm])).toEqual([["floor", "100"]]);
  });
});

describe("floor advance — the window waiting on its cut", () => {
  test("a replace while the cut is in flight cancels the window: only the replace is written", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut);
    await seeded(f);
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle(); // the window waits on the cut
    f.setWm("300");
    f.h.runtime.recomputeResource("rows");
    await settle();
    c.resolveCut({ kind: "cut", cutXid: "250" });
    await settle();
    expect(f.persisted.map((p) => [p.mode, p.wm])).toEqual([
      ["replace", "300"],
    ]);
  });

  test("a replace cancels EVERY window of the slot still waiting on a cut", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut);
    await seeded(f);
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle(); // window 1 waits on the cut
    f.table.set("b", 6);
    f.feed.feed("U", ["b"]);
    await settle(); // window 2 joins the same cut
    f.setWm("300");
    f.h.runtime.recomputeResource("rows");
    await settle();
    c.resolveCut({ kind: "cut", cutXid: "250" });
    await settle();
    expect(f.persisted.map((p) => [p.mode, p.wm])).toEqual([
      ["replace", "300"],
    ]);
  });

  test("dropPendingPersists cancels a window waiting on its cut", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut);
    await seeded(f);
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]);
    await settle();
    expect(f.h.runtime.dropPendingPersists()).toBe(1);
    c.resolveCut({ kind: "cut", cutXid: "250" });
    await settle();
    expect(f.persisted).toEqual([]);
  });

  test("windows firing together share ONE cut", async () => {
    const c = cutControl();
    const f = fixture(c.routedCut, ["rows", "rows2"]);
    await f.h.subscribe("rows");
    await f.h.subscribe("rows2");
    await settle();
    f.persisted.length = 0;
    f.table.set("a", 5);
    f.feed.feed("U", ["a"]); // one table: both aliases route it
    await settle();
    expect(c.calls()).toBe(1);
    c.resolveCut({ kind: "cut", cutXid: "250" });
    await settle();
    expect(f.persisted.map((p) => [p.key, p.mode, p.wm]).sort()).toEqual([
      ["rows", "advance", "250"],
      ["rows2", "advance", "250"],
    ]);
  });
});
