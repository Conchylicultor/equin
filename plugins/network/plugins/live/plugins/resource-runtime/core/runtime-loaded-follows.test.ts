/**
 * Loaded follow routes (`RouteVia.loaded` — network/live's dependent
 * `follow.from`): a follower tuple's match on them is what its last load
 * noted (`LoadRun.noteLoaded`), handed back to `usesOf(params, loaded)`.
 * Pinned here:
 *
 * - before a load noted anything, a loaded route reaches the tuple past its
 *   match (gate only);
 * - after one, only the rows the note names reach it;
 * - while a load is in flight, the route reaches it past its match again —
 *   the load may be naming a row a skipped change touched — and the change
 *   re-runs the tuple once the flight settles;
 * - a failed load drops the note: the tuple's loaded routes are open again
 *   until a load notes one (a stale note could skip a newly named row);
 * - a loader is handed a `LoadRun` only when its plan has loaded routes;
 * - mint refuses a follow whose routes disagree on `loaded`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { mintReachPlan, type TableChange, type TupleUse } from "./routing";
import { createHarness, tick, type Harness } from "./test-support";
import type { LoadRun, ResourceParams } from "./runtime";

const settle = async () => {
  await tick();
  await tick();
};

const REASON = "the follow re-reads its follower whole";

/**
 * A follower of `owner_files` (scoped by `owner_id`, from its params) and of
 * `files` by the ids its load named (`loaded`): the reach a dependent
 * `follow.from` compiles to.
 */
function dependentReach() {
  return mintReachPlan<ResourceParams>({
    routes: [
      {
        id: "links:base",
        table: "owner_files",
        map: { kind: "full", reason: REASON },
        columns: ["owner_id", "file_id"],
        match: ["owner_id"],
        via: { name: "links", collection: "links" },
      },
      {
        id: "files:base",
        table: "files",
        map: { kind: "full", reason: REASON },
        columns: ["id", "name"],
        match: ["id"],
        via: { name: "files", collection: "files:rows", loaded: true },
      },
    ],
    usesOf: (p, loaded) => {
      const uses = new Map<string, TupleUse>([
        [
          "links:base",
          { role: "membership", match: { owner_id: new Set([p.owner!]) } },
        ],
      ]);
      const ids = (loaded as { files?: string[] } | undefined)?.files;
      if (ids !== undefined && ids.length > 0) {
        uses.set("files:base", {
          role: "membership",
          match: { id: new Set(ids) },
        });
      }
      return uses;
    },
  });
}

const fileChange = (ids: string[]): TableChange => ({
  source: "feed",
  table: "files",
  op: "U",
  ids,
  keys: { id: ids },
  unchanged: null,
});

/**
 * A follower whose loader notes `names()` as the files it read, and can be
 * held mid-flight (`hold()` → the next load waits for `release()`).
 */
function follower(h: Harness, names: () => string[]) {
  const loads: string[] = [];
  const runs: (LoadRun | undefined)[] = [];
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  let fail = false;
  h.runtime.defineResource(
    {
      key: "follower",
      schema: z.object({ n: z.number() }),
      validateParams: () => {},
    },
    {
      mode: "push",
      loader: async (p: ResourceParams, _ctx, run) => {
        runs.push(run);
        // Noted at the read, before the hold — as the follows' read notes.
        run?.noteLoaded({ files: names() });
        loads.push(p.owner!);
        if (gate !== null) await gate;
        if (fail) throw new Error("load failed");
        return { n: loads.length };
      },
      reach: dependentReach(),
    },
  );
  return {
    loads,
    runs,
    hold() {
      gate = new Promise<void>((res) => (open = res));
    },
    release() {
      gate = null;
      open?.();
    },
    failNext(on: boolean) {
      fail = on;
    },
  };
}

describe("loaded follow routes", () => {
  test("after a load noted its files, only those files reach the tuple", async () => {
    const h = createHarness();
    const f = follower(h, () => ["f1"]);
    await h.subscribe("follower", { owner: "o1" });
    expect(f.loads).toEqual(["o1"]);
    h.runtime.routeTableChange(fileChange(["f2"]));
    await settle();
    expect(f.loads).toEqual(["o1"]);
    h.runtime.routeTableChange(fileChange(["f1"]));
    await settle();
    expect(f.loads).toEqual(["o1", "o1"]);
  });

  test("a load handed no note leaves the route open: every file reaches the tuple", async () => {
    const h = createHarness();
    let loads = 0;
    h.runtime.defineResource(
      {
        key: "counter",
        schema: z.object({ n: z.number() }),
        validateParams: () => {},
      },
      {
        mode: "push",
        loader: () => ({ n: ++loads }),
        reach: dependentReach(),
      },
    );
    await h.subscribe("counter", { owner: "o1" });
    expect(loads).toBe(1);
    h.runtime.routeTableChange(fileChange(["anything"]));
    await settle();
    expect(loads).toBe(2);
  });

  test("while a load is in flight, any file reaches the tuple, and the change re-runs it after", async () => {
    const h = createHarness();
    let named = ["f1"];
    const f = follower(h, () => named);
    await h.subscribe("follower", { owner: "o1" });
    // A change to the link table starts a flight that will name f2.
    named = ["f2"];
    f.hold();
    h.runtime.routeTableChange({
      source: "feed",
      table: "owner_files",
      op: "I",
      ids: ["x"],
      keys: { owner_id: ["o1"] },
      unchanged: null,
    });
    await settle();
    expect(f.loads).toEqual(["o1", "o1"]);
    // Mid-flight: f2 is not in the installed note (f1), but the flight may
    // have read f2 before this write — it must reach the tuple.
    h.runtime.routeTableChange(fileChange(["f2"]));
    f.release();
    await settle();
    await settle();
    expect(f.loads).toEqual(["o1", "o1", "o1"]);
    // Settled on f2: f1 no longer reaches it.
    h.runtime.routeTableChange(fileChange(["f1"]));
    await settle();
    expect(f.loads.length).toBe(3);
  });

  test("a failed load drops the note: every file reaches the tuple until a load notes again", async () => {
    const h = createHarness();
    let named = ["f1"];
    const f = follower(h, () => named);
    await h.subscribe("follower", { owner: "o1" });
    named = ["f2"];
    f.failNext(true);
    h.runtime.routeTableChange(fileChange(["f1"]));
    await settle();
    f.failNext(false);
    // Open: f2 — named by no installed note — reaches it, and that load
    // notes f2 again.
    const at = f.loads.length;
    h.runtime.routeTableChange(fileChange(["f2"]));
    await settle();
    expect(f.loads.length).toBe(at + 1);
    h.runtime.routeTableChange(fileChange(["f1"]));
    await settle();
    expect(f.loads.length).toBe(at + 1);
  });

  test("a loader is handed a LoadRun only when its plan has loaded routes", async () => {
    const h = createHarness();
    const f = follower(h, () => ["f1"]);
    const plain: (LoadRun | undefined)[] = [];
    h.runtime.defineResource(
      {
        key: "plain",
        schema: z.object({ n: z.number() }),
        validateParams: () => {},
      },
      {
        mode: "push",
        loader: (_p: ResourceParams, _ctx, run) => {
          plain.push(run);
          return { n: 1 };
        },
        reach: mintReachPlan<ResourceParams>({
          routes: [
            {
              id: "t",
              table: "files",
              map: { kind: "full", reason: REASON },
              columns: ["id"],
            },
          ],
          usesOf: () => new Map([["t", { role: "membership" }]]),
        }),
      },
    );
    await h.subscribe("follower", { owner: "o1" });
    await h.subscribe("plain", {});
    expect(f.runs[0]).toBeDefined();
    expect(plain).toEqual([undefined]);
  });

  test("mint refuses a follow whose routes disagree on `loaded`", () => {
    expect(() =>
      mintReachPlan<ResourceParams>({
        routes: [
          {
            id: "a",
            table: "files",
            map: { kind: "full", reason: REASON },
            columns: ["id"],
            via: { name: "files", collection: "files:rows", loaded: true },
          },
          {
            id: "b",
            table: "file_meta",
            map: { kind: "full", reason: REASON },
            columns: ["id"],
            via: { name: "files", collection: "files:rows" },
          },
        ],
        usesOf: () => new Map(),
      }),
    ).toThrow(/both loaded and not/);
  });
});
