/**
 * Bounded `membership` (window / point) — the generalization of M5
 * `scopedMembership` from
 * `research/2026-07-18-global-bounded-working-set-resource-contract.md`. Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime-window-membership.test.ts`.
 *
 * A `membership: { kind: "window", windowIdsOf }` entry's value is a bounded
 * ordered window; a `membership: { kind: "point", idsOf }` entry's value is the
 * params tuple's explicit id set. Both keep the wire, versions, and diff of M5 —
 * a membership change costs O(changed) + O(window), never O(collection). Pinned
 * here:
 *
 *   - entrant into the window → one scoped refill + one windowIdsOf, delta with
 *     bounded `order`; an entrant sorting PAST THE TAIL ships nothing (one
 *     windowIdsOf probe, no frame, no version bump);
 *   - leaver (DELETE / where-flip exit) → windowIdsOf + tail backfill: the new
 *     tail row is pulled in as an upsert alongside the delete;
 *   - squeeze-out: an entrant displacing the tail drops it via `order` alone;
 *   - DELETE of an id outside the snapshot → total no-op (no query, no frame);
 *   - pure in-place UPDATE → upsert only, NO windowIdsOf (the M5 cost model);
 *   - a window holding fewer rows than its `limitOf` (not full) derives an
 *     exit from the prior snapshot: no windowIdsOf, no backfill; entrants and
 *     order moves still re-derive; full ⇄ not-full transitions converge; a
 *     `limitOf` answering no number reads as full; a torn read (a backfill
 *     target gone, an exit back in range) rebuilds FULL, so no snapshot is
 *     recorded short of its range;
 *   - point routing: a change reaches a subscribed tuple iff its ids intersect;
 *     upsert / delete / entrant-append all per tuple; foreign ids ship nothing;
 *   - bounded entries are EXCLUDED from persistence even when `shouldPersist`
 *     says yes, and their snapshot evicts on N→0 (contrast: the alias persists);
 *   - a resub after N→0 re-seeds the evicted snapshot from a full (bounded)
 *     sub-ack, so the next change is incremental again;
 *   - a subscribed tuple with no snapshot (its sub-ack load failed) self-heals
 *     with a FULL update built from the entry's own (bounded) loader;
 *   - registration guards: membership XOR scopedMembership, a window states
 *     its limitOf, keyed + routes required, routes require a membership.
 *
 * Every window / point case runs with the entry declaring the identity route
 * `compileWindowQuery` emits (served by `routeTableChange`,
 * research/2026-09-29-global-scoped-change-routing.md P1) — a membership entry
 * is always routed.
 *
 * The `scopedMembership` alias's byte-identical behavior is pinned by
 * `runtime-scoped-membership.test.ts` (kept green unchanged — that suite IS the
 * alias-equivalence proof, since the alias now routes through this same
 * membership machinery as an unbounded window).
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createHarness, tick, makeClientView, rng } from "./test-support";
import {
  defineRoutedTable,
  feedChange,
  identityPlan,
} from "./testing/routed-fixture";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));
const keyOf = (r: unknown) => (r as { id: string }).id;

// A simulated identity table whose total order is ascending `n` (then id). The
// window is the first `limit` members — `windowIdsOf` carries the LIMIT, exactly
// like a compiled `SELECT pk … ORDER BY … LIMIT n`.
function makeTable() {
  const table = new Map<string, { n: number; where: boolean }>();
  const members = (): { id: string; n: number }[] =>
    [...table.entries()]
      .filter(([, c]) => c.where)
      .map(([id, c]) => ({ id, n: c.n }))
      .sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : 1));
  return { table, members };
}

// Every membership case below declares the one identity route
// `compileWindowQuery` emits (served by `routeTableChange`). Each change is
// delivered to both routers, as `routeChange` does, so each case also pins
// that an entry is reached exactly once.
function membershipSuite(): void {
  // The identity route `compileWindowQuery` emits (the shared fixture).
  const scopeFor = (table: string) => ({ routes: identityPlan(table) });

  // A bounded-window resource "win" over the simulated table: FULL loader = the
  // window rows (bounded by construction), scoped loader = the requested member
  // rows, windowIdsOf = the first `limit` member ids. Records loader scoping and
  // counts windowIdsOf runs.
  function windowHarness(
    limit: number,
    runtimeOpts: Parameters<typeof createHarness>[0] = {},
    /** The declared window size. Default: `limit` (the LIMIT `windowIdsOf` cuts). */
    limitOf: () => number = () => limit,
  ) {
    const { table, members } = makeTable();
    const loaderCalls: string[] = [];
    let windowIdsOfCalls = 0;
    let failFullLoads = false;
    // Runs inside a scoped loader call, before it reads — a write racing the
    // drain's own reads (between its `windowIdsOf` and its backfill).
    let beforeScopedRead: ((ids: readonly string[]) => void) | undefined;
    const h = createHarness(runtimeOpts);
    h.runtime.defineResource(
      {
        key: "win",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        ...scopeFor("row_table"),
        membership: {
          kind: "window",
          windowIdsOf: async () => {
            windowIdsOfCalls++;
            return members()
              .slice(0, limit)
              .map((r) => r.id);
          },
          limitOf,
        },
        loader: (_p, c) => {
          if (c === undefined) {
            loaderCalls.push("FULL");
            if (failFullLoads) throw new Error("window read failed");
            return members().slice(0, limit);
          }
          loaderCalls.push([...c.affectedIds].sort().join(","));
          beforeScopedRead?.(c.affectedIds);
          return c.affectedIds
            .filter((id) => table.get(id)?.where)
            .map((id) => ({ id, n: table.get(id)!.n }));
        },
      },
    );
    const feed = (op: "I" | "U" | "D", ids: string[] | null) =>
      feedChange(h, { table: "row_table", op, ids });
    const insert = (id: string, n: number, where = true) => {
      table.set(id, { n, where });
      feed("I", [id]);
    };
    const update = (
      id: string,
      mut: (c: { n: number; where: boolean }) => void,
    ) => {
      mut(table.get(id)!);
      feed("U", [id]);
    };
    const del = (id: string) => {
      table.delete(id);
      feed("D", [id]);
    };
    return {
      h,
      table,
      members,
      loaderCalls,
      windowIdsOf: () => windowIdsOfCalls,
      /** Make every FULL (window) load throw until switched back off. */
      failFullLoads: (on: boolean) => {
        failFullLoads = on;
      },
      /** Run `fn` inside every later scoped loader call, before it reads. */
      beforeScopedRead: (fn: (ids: readonly string[]) => void) => {
        beforeScopedRead = fn;
      },
      feed,
      insert,
      update,
      del,
    };
  }

  const deltas = (h: ReturnType<typeof createHarness>, key = "win") =>
    h.pushesFor(key).filter((f) => f.kind === "delta");

  describe("window membership — entrant", () => {
    test("an INSERT sorting into the window ships one refill + one windowIdsOf + a bounded order", async () => {
      const w = windowHarness(3);
      w.table.set("a", { n: 1, where: true });
      w.table.set("c", { n: 3, where: true });
      await w.h.subscribe("win"); // window [a,c]
      w.loaderCalls.length = 0;

      w.insert("b", 2);
      await tick();

      expect(w.loaderCalls).toEqual(["b"]); // one scoped refill of just the entrant
      expect(w.windowIdsOf()).toBe(1);
      const ds = deltas(w.h);
      expect(ds).toHaveLength(1);
      expect(ds[0]!.upserts).toEqual([["b", { id: "b", n: 2 }]]);
      expect(ds[0]!.deletes).toEqual([]);
      expect(ds[0]!.order).toEqual(["a", "b", "c"]);

      const cv = makeClientView(keyOf);
      cv.applyAll(w.h.frames);
      expect(cv.value).toEqual([
        { id: "a", n: 1 },
        { id: "b", n: 2 },
        { id: "c", n: 3 },
      ]);
      expect(cv.driftResubs).toBe(0);
    });

    test("an INSERT sorting past the tail of a FULL window ships NOTHING (one windowIdsOf probe, no frame, no version bump)", async () => {
      const w = windowHarness(2);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      await w.h.subscribe("win"); // window full: [a,b]
      const base = w.h.frames.find((f) => f.kind === "sub-ack")!.version!;
      w.loaderCalls.length = 0;

      w.insert("z", 99); // beyond the tail — not a member of this window
      await tick();

      // The refill + windowIdsOf probe ran (the v1 entrant arbiter — O(window),
      // bounded), but no frame shipped and the version did not move.
      expect(w.loaderCalls).toEqual(["z"]);
      expect(w.windowIdsOf()).toBe(1);
      expect(deltas(w.h)).toHaveLength(0);

      // A subsequent REAL change is the sub-ack's version + 1 — the no-op left the
      // counter where the sub-ack found it.
      w.update("a", (c) => {
        c.n = 0;
      });
      await tick();
      const ds = deltas(w.h);
      expect(ds).toHaveLength(1);
      expect(ds[0]!.version).toBe(base + 1);
    });

    test("squeeze-out: an entrant displacing the tail drops it via order alone", async () => {
      const w = windowHarness(2);
      w.table.set("b", { n: 2, where: true });
      w.table.set("c", { n: 3, where: true });
      await w.h.subscribe("win"); // window [b,c]
      w.loaderCalls.length = 0;

      w.insert("a", 1); // sorts first → c is squeezed out of the window
      await tick();

      const ds = deltas(w.h);
      expect(ds).toHaveLength(1);
      expect(ds[0]!.order).toEqual(["a", "b"]);
      expect((ds[0]!.upserts ?? []).map(([id]) => id)).toEqual(["a"]);

      const cv = makeClientView(keyOf);
      cv.applyAll(w.h.frames);
      expect(cv.value).toEqual([
        { id: "a", n: 1 },
        { id: "b", n: 2 },
      ]); // c gone
      expect(cv.driftResubs).toBe(0);
    });
  });

  describe("window membership — leaver + tail backfill", () => {
    test("a DELETE of a member pulls the new tail row in (delete + backfill upsert + bounded order)", async () => {
      const w = windowHarness(2);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      w.table.set("d", { n: 4, where: true }); // outside the window (limit 2)
      await w.h.subscribe("win"); // window [a,b]
      w.loaderCalls.length = 0;

      w.del("b");
      await tick();

      // One windowIdsOf (the new window [a,d]) + one backfill refill of the
      // pulled-in tail id `d` — never a FULL collection read.
      expect(w.windowIdsOf()).toBe(1);
      expect(w.loaderCalls).toEqual(["d"]);
      const ds = deltas(w.h);
      expect(ds).toHaveLength(1);
      expect(ds[0]!.deletes).toEqual(["b"]);
      expect(ds[0]!.upserts).toEqual([["d", { id: "d", n: 4 }]]);
      expect(ds[0]!.order).toEqual(["a", "d"]);

      const cv = makeClientView(keyOf);
      cv.applyAll(w.h.frames);
      expect(cv.value).toEqual([
        { id: "a", n: 1 },
        { id: "d", n: 4 },
      ]);
      expect(cv.driftResubs).toBe(0);
    });

    test("a where-flip exit backfills the tail the same way", async () => {
      const w = windowHarness(2);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      w.table.set("d", { n: 4, where: true });
      await w.h.subscribe("win"); // window [a,b]
      w.loaderCalls.length = 0;

      w.update("b", (c) => {
        c.where = false; // where-flip exit — the refill omits the requested id
      });
      await tick();

      expect(w.windowIdsOf()).toBe(1);
      // Refill of the flipped id (returns nothing) + backfill of the new tail.
      expect(w.loaderCalls).toEqual(["b", "d"]);
      const ds = deltas(w.h);
      expect(ds).toHaveLength(1);
      expect(ds[0]!.deletes).toEqual(["b"]);
      expect(ds[0]!.order).toEqual(["a", "d"]);

      const cv = makeClientView(keyOf);
      cv.applyAll(w.h.frames);
      expect(cv.value).toEqual([
        { id: "a", n: 1 },
        { id: "d", n: 4 },
      ]);
    });

    test("a DELETE of an id OUTSIDE the snapshot is a total no-op (no query, no frame, no version bump)", async () => {
      const w = windowHarness(2);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      w.table.set("d", { n: 4, where: true }); // beyond the tail
      await w.h.subscribe("win"); // window [a,b]
      const base = w.h.frames.find((f) => f.kind === "sub-ack")!.version!;
      w.loaderCalls.length = 0;

      w.del("d"); // a window is a prefix of the total order — d is outside it
      await tick();

      expect(w.loaderCalls).toEqual([]);
      expect(w.windowIdsOf()).toBe(0);
      expect(deltas(w.h)).toHaveLength(0);

      w.update("a", (c) => {
        c.n = 0;
      });
      await tick();
      // The no-op left the counter where the sub-ack found it.
      expect(deltas(w.h)[0]!.version).toBe(base + 1);
    });
  });

  describe("window membership — in-place path", () => {
    test("a pure in-place UPDATE ships one upsert with NO order and runs NO windowIdsOf", async () => {
      const w = windowHarness(3);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      await w.h.subscribe("win");
      w.loaderCalls.length = 0;

      w.update("a", (c) => {
        c.n = 0; // content change, still a member (window not full → order stable)
      });
      await tick();

      expect(w.loaderCalls).toEqual(["a"]); // one scoped refill, nothing else
      expect(w.windowIdsOf()).toBe(0); // the M5 in-place cost model
      const ds = deltas(w.h);
      expect(ds).toHaveLength(1);
      expect(ds[0]!.upserts).toEqual([["a", { id: "a", n: 0 }]]);
      expect(ds[0]!.order).toBeUndefined();
    });
  });

  // A window holding fewer rows than its `limitOf` holds its whole range:
  // nothing sorts past its tail, so a leaver frees no slot a hidden row must
  // fill. Its exits derive from the prior snapshot — no `windowIdsOf`, no
  // backfill; entrants and order moves still re-derive; a full window keeps
  // the backfilling path above.
  describe("window membership — exits from a non-full window", () => {
    test("a DELETE of a member of a non-full window runs no query at all: delete + order from the prior snapshot", async () => {
      const w = windowHarness(3);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      await w.h.subscribe("win"); // window [a,b] — 2 of 3, not full
      w.loaderCalls.length = 0;

      w.del("a");
      await tick();

      expect(w.windowIdsOf()).toBe(0);
      expect(w.loaderCalls).toEqual([]); // a pure DELETE refills nothing
      const ds = deltas(w.h);
      expect(ds).toHaveLength(1);
      expect(ds[0]!.deletes).toEqual(["a"]);
      expect(ds[0]!.upserts ?? []).toEqual([]);
      expect(ds[0]!.order).toEqual(["b"]);

      const cv = makeClientView(keyOf);
      cv.applyAll(w.h.frames);
      expect(cv.value).toEqual([{ id: "b", n: 2 }]);
      expect(cv.driftResubs).toBe(0);
    });

    test("a where-flip exit of a non-full window costs its refill only, no windowIdsOf", async () => {
      const w = windowHarness(3);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      await w.h.subscribe("win"); // [a,b], not full
      w.loaderCalls.length = 0;

      w.update("b", (c) => {
        c.where = false;
      });
      await tick();

      expect(w.windowIdsOf()).toBe(0);
      expect(w.loaderCalls).toEqual(["b"]); // the refill that found it gone
      const ds = deltas(w.h);
      expect(ds).toHaveLength(1);
      expect(ds[0]!.deletes).toEqual(["b"]);
      expect(ds[0]!.order).toEqual(["a"]);
    });

    test("an in-place change of a non-full window stays query-free", async () => {
      const w = windowHarness(3);
      w.table.set("a", { n: 1, where: true });
      await w.h.subscribe("win"); // [a], not full
      w.loaderCalls.length = 0;

      w.update("a", (c) => {
        c.n = 5;
      });
      await tick();

      expect(w.windowIdsOf()).toBe(0);
      expect(w.loaderCalls).toEqual(["a"]);
      expect(deltas(w.h)[0]!.order).toBeUndefined();
    });

    test("an entrant into a non-full window still re-derives (one windowIdsOf)", async () => {
      const w = windowHarness(3);
      w.table.set("a", { n: 1, where: true });
      await w.h.subscribe("win"); // [a], not full

      w.insert("b", 0);
      await tick();

      expect(w.windowIdsOf()).toBe(1); // placement needs the authority
      expect(deltas(w.h)[0]!.order).toEqual(["b", "a"]);
    });

    test("an exit and an entrant in one flush of a non-full window re-derive once", async () => {
      const w = windowHarness(3);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      await w.h.subscribe("win"); // [a,b], not full

      w.table.delete("a");
      w.table.set("c", { n: 3, where: true });
      w.feed("D", ["a"]);
      w.feed("I", ["c"]);
      await tick();

      expect(w.windowIdsOf()).toBe(1);
      const cv = makeClientView(keyOf);
      cv.applyAll(w.h.frames);
      expect(cv.value).toEqual([
        { id: "b", n: 2 },
        { id: "c", n: 3 },
      ]);
      expect(cv.driftResubs).toBe(0);
    });

    test("full ⇄ not full: a full window's exit backfills; once it is not full its exits are query-free; an entrant refilling it makes it full again", async () => {
      const w = windowHarness(2);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      w.table.set("d", { n: 4, where: true }); // past the tail
      await w.h.subscribe("win"); // [a,b] — full
      w.loaderCalls.length = 0;
      const view = () => {
        const cv = makeClientView(keyOf);
        cv.applyAll(w.h.frames);
        expect(cv.driftResubs).toBe(0);
        return cv.value;
      };

      w.del("b"); // full: re-derive + backfill d → [a,d], still full
      await tick();
      expect(w.windowIdsOf()).toBe(1);
      expect(w.loaderCalls).toEqual(["d"]);
      expect(view()).toEqual([
        { id: "a", n: 1 },
        { id: "d", n: 4 },
      ]);

      w.del("d"); // full: the probe finds nothing to pull in → [a], not full
      await tick();
      expect(w.windowIdsOf()).toBe(2);
      expect(view()).toEqual([{ id: "a", n: 1 }]);

      w.del("a"); // not full: query-free → []
      await tick();
      expect(w.windowIdsOf()).toBe(2);
      expect(view()).toEqual([]);

      w.insert("x", 7); // entrant → [x]
      await tick();
      expect(w.windowIdsOf()).toBe(3);
      w.insert("y", 8); // entrant → [x,y], full again
      await tick();
      expect(w.windowIdsOf()).toBe(4);
      expect(view()).toEqual([
        { id: "x", n: 7 },
        { id: "y", n: 8 },
      ]);

      w.insert("z", 9); // past the tail of the full window
      await tick();
      expect(w.windowIdsOf()).toBe(5);
      w.del("x"); // full again: re-derive + backfill z
      await tick();
      expect(w.windowIdsOf()).toBe(6);
      expect(view()).toEqual([
        { id: "y", n: 8 },
        { id: "z", n: 9 },
      ]);
    });

    test("a window whose limitOf answers no number (or throws) is doubted as FULL: an exit still re-derives and backfills, and the failure is reported", async () => {
      for (const limitOf of [
        () => Number.NaN,
        () => undefined as unknown as number,
        () => {
          throw new Error("limitOf broke");
        },
      ]) {
        const reported: string[] = [];
        const w = windowHarness(
          2,
          { reportError: (ctx) => reported.push(ctx) },
          limitOf,
        );
        w.table.set("a", { n: 1, where: true });
        w.table.set("b", { n: 2, where: true });
        w.table.set("c", { n: 3, where: true });
        await w.h.subscribe("win"); // [a,b]
        w.loaderCalls.length = 0;

        w.del("a");
        await tick();
        expect(w.windowIdsOf()).toBe(1);
        expect(w.loaderCalls).toEqual(["c"]); // the tail backfill
        const cv = makeClientView(keyOf);
        cv.applyAll(w.h.frames);
        expect(cv.value).toEqual([
          { id: "b", n: 2 },
          { id: "c", n: 3 },
        ]);
        expect(reported).toEqual(["limitOf failed for win"]);
      }
    });

    test("a backfill whose target vanished after windowIdsOf named it is a torn read: the drain rebuilds the window FULL, never recording a not-full snapshot short of its range", async () => {
      const w = windowHarness(2);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      w.table.set("c", { n: 3, where: true });
      w.table.set("d", { n: 4, where: true });
      await w.h.subscribe("win"); // [a,b] — full
      const view = () => {
        const cv = makeClientView(keyOf);
        cv.applyAll(w.h.frames);
        expect(cv.driftResubs).toBe(0);
        return cv.value;
      };
      // `c` is deleted between the exit's `windowIdsOf` (which names it as the
      // new tail) and the backfill that reads its row.
      w.beforeScopedRead((ids) => {
        if (ids.includes("c")) w.table.delete("c");
      });
      w.loaderCalls.length = 0;

      w.del("a");
      await tick();
      // The backfill came back without `c`: one bounded FULL read instead of
      // a one-row snapshot that would read as holding its whole range.
      expect(w.windowIdsOf()).toBe(1);
      expect(w.loaderCalls).toEqual(["c", "FULL"]);
      expect(view()).toEqual([
        { id: "b", n: 2 },
        { id: "d", n: 4 },
      ]);

      w.feed("D", ["c"]); // c's own delete: no member, nothing to do
      await tick();
      w.del("b"); // still full: re-derive (nothing past d) → [d]
      await tick();
      expect(view()).toEqual(w.members().slice(0, 2));
      expect(view()).toEqual([{ id: "d", n: 4 }]);
    });

    test("an exit windowIdsOf sees back in range (its where flipped back mid-drain) is a torn read too: rebuilt FULL", async () => {
      const w = windowHarness(2);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      w.table.set("c", { n: 3, where: true });
      await w.h.subscribe("win"); // [a,b] — full
      // The refill finds `a` gone; it flips back in before `windowIdsOf` reads.
      let flipped = false;
      w.beforeScopedRead((ids) => {
        if (flipped || !ids.includes("a")) return;
        flipped = true;
        queueMicrotask(() => {
          w.table.get("a")!.where = true;
        });
      });
      w.loaderCalls.length = 0;

      w.update("a", (c) => {
        c.where = false;
      });
      await tick();

      expect(w.loaderCalls).toEqual(["a", "FULL"]);
      const cv = makeClientView(keyOf);
      cv.applyAll(w.h.frames);
      expect(cv.driftResubs).toBe(0);
      expect(cv.value).toEqual(w.members().slice(0, 2)); // [a,b]
    });

    test("property: under random writes the client converges to the window, and no exit-only flush of a non-full window queries", async () => {
      for (let seed = 1; seed <= 20; seed++) {
        const r = rng(seed);
        const limit = 1 + Math.floor(r() * 4);
        const w = windowHarness(limit);
        for (let i = 0; i < 3; i++)
          w.table.set(`r${i}`, { n: Math.floor(r() * 20), where: true });
        await w.h.subscribe("win");
        let next = 3;
        for (let step = 0; step < 40; step++) {
          const live = [...w.table.keys()];
          const shown = w.members().slice(0, limit);
          const notFull = shown.length < limit;
          const before = w.windowIdsOf();
          const pick = r();
          let exitOnly = false;
          if (pick < 0.35 || live.length === 0) {
            w.insert(`r${next++}`, Math.floor(r() * 20));
          } else {
            const id = live[Math.floor(r() * live.length)]!;
            const member = shown.some((m) => m.id === id);
            if (pick < 0.6) {
              exitOnly = member;
              w.del(id);
            } else if (pick < 0.8) {
              const where = !w.table.get(id)!.where;
              exitOnly = member && !where;
              w.update(id, (c) => {
                c.where = where;
              });
            } else if (!member) {
              // A non-member's sort key moves (it may enter). A member's would
              // need `orderSignatureOf`, which this harness does not state.
              w.update(id, (c) => {
                c.n = Math.floor(r() * 20);
              });
            }
          }
          await tick();
          if (exitOnly && notFull) expect(w.windowIdsOf()).toBe(before);
          const cv = makeClientView(keyOf);
          cv.applyAll(w.h.frames);
          expect(cv.driftResubs).toBe(0);
          expect(cv.value).toEqual(w.members().slice(0, limit));
        }
      }
    });
  });

  describe("window membership — persistence exclusion + eviction", () => {
    test("a bounded window entry is NEVER persisted even when shouldPersist says yes, and evicts its snapshot on N→0", async () => {
      const persists: string[] = [];
      const w = windowHarness(2, {
        shouldPersist: () => true, // the hook opts in — the definition must veto
        captureWatermark: async () => "xmin-1",
        persistSnapshot: async (key) => {
          persists.push(key);
        },
      });
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      await w.h.subscribe("win");
      w.update("a", (c) => {
        c.n = 0;
      });
      await tick();
      expect(deltas(w.h)).toHaveLength(1); // the change itself shipped
      expect(persists).toEqual([]); // structurally excluded, not name-excluded
      // …and `persistedKeys()` is that same gate, so it lists none.
      expect(w.h.runtime.persistedKeys()).toEqual([]);

      // N→0 evicts the snapshot (no persisted-reconstruction carve-out applies)…
      await w.h.unsub("win");
      w.loaderCalls.length = 0;
      w.update("a", (c) => {
        c.n = 5;
      });
      await tick();
      // …so with zero subscribers nothing recomputes at all (needValue false).
      expect(w.loaderCalls).toEqual([]);
      expect(persists).toEqual([]);
    });

    test("contrast: the scopedMembership alias with the same hooks IS persisted (the carve-out is alias-only)", async () => {
      const persists: string[] = [];
      const { table, members } = makeTable();
      const h = createHarness({
        shouldPersist: () => true,
        captureWatermark: async () => "xmin-1",
        persistSnapshot: async (key) => {
          persists.push(key);
        },
      });
      const rows = defineRoutedTable(h, {
        key: "rows",
        table: "row_table",
        membership: "alias",
        schema: rowsSchema,
        orderOf: async () => members().map((r) => r.id),
        loader: (_p, c) =>
          c === undefined
            ? members()
            : c.affectedIds
                .filter((id) => table.get(id)?.where)
                .map((id) => ({ id, n: table.get(id)!.n })),
      });
      table.set("a", { n: 1, where: true });
      rows.feed("I", null);
      await tick();
      expect(persists).toEqual(["rows"]);
      expect(h.runtime.persistedKeys()).toEqual(["rows"]);
    });
  });

  describe("window membership — a missing snapshot is rebuilt from the bounded loader", () => {
    test("a resub after N→0 is a full sub-ack that re-seeds the evicted snapshot: the next change ships an incremental delta", async () => {
      const w = windowHarness(2);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      w.table.set("d", { n: 4, where: true });
      await w.h.subscribe("win");
      const ack = w.h.frames.find((f) => f.kind === "sub-ack")!;
      expect(ack.value).toEqual([
        { id: "a", n: 1 },
        { id: "b", n: 2 },
      ]); // bounded sub-ack

      // N→0 evicts the snapshot. The resub echoes the version it held, but it
      // opens a new tracking span: never `up-to-date`, always the full path —
      // one bounded window read, whose value re-seeds the snapshot.
      await w.h.unsub("win");
      w.loaderCalls.length = 0;
      await w.h.subscribe(
        "win",
        {},
        { version: ack.version, epoch: ack.epoch },
      );
      expect(w.h.frames.some((f) => f.kind === "up-to-date")).toBe(false);
      const acks = w.h.frames.filter((f) => f.kind === "sub-ack");
      expect(acks).toHaveLength(2);
      expect(acks[1]!.version).toBeGreaterThan(ack.version!);
      expect(w.loaderCalls).toEqual(["FULL"]);
      w.loaderCalls.length = 0;

      w.update("a", (c) => {
        c.n = 0;
      });
      await tick();

      // The snapshot is back: a pure in-place change is one scoped refill and one
      // upsert — never a FULL reload or an `update`.
      expect(w.loaderCalls).toEqual(["a"]);
      expect(w.h.frames.some((f) => f.kind === "update")).toBe(false);
      const ds = deltas(w.h);
      expect(ds).toHaveLength(1);
      expect(ds[0]!.upserts).toEqual([["a", { id: "a", n: 0 }]]);
      expect(ds[0]!.version).toBe(acks[1]!.version! + 1);

      const cv = makeClientView(keyOf);
      cv.applyAll(w.h.frames);
      expect(cv.value).toEqual([
        { id: "a", n: 0 },
        { id: "b", n: 2 },
      ]);
      expect(cv.driftResubs).toBe(0);
    });

    test("a subscribed tuple whose sub-ack load failed (no snapshot) self-heals via the entry's own bounded FULL loader", async () => {
      const w = windowHarness(2);
      w.table.set("a", { n: 1, where: true });
      w.table.set("b", { n: 2, where: true });
      w.table.set("d", { n: 4, where: true });
      // The sub registers, but its load throws: `sub-error`, and no snapshot is
      // ever seeded for this still-subscribed tuple.
      w.failFullLoads(true);
      await w.h.subscribe("win");
      expect(w.h.frames.map((f) => f.kind)).toEqual(["sub-error"]);
      w.failFullLoads(false);
      w.loaderCalls.length = 0;

      w.update("a", (c) => {
        c.n = 0;
      });
      await tick();

      // No snapshot → drainMembershipFull → the entry loader at the window params,
      // which IS the bounded window read — "FULL" here can never be an unbounded
      // collection sweep. Ships a value-carrying update (never a delta on no base).
      expect(w.loaderCalls).toEqual(["FULL"]);
      const update = w.h.frames.find((f) => f.kind === "update")!;
      expect(update.value).toEqual([
        { id: "a", n: 0 },
        { id: "b", n: 2 },
      ]);
      expect(w.h.frames.some((f) => f.kind === "delta")).toBe(false);

      const cv = makeClientView(keyOf);
      cv.applyAll(w.h.frames);
      expect(cv.value).toEqual([
        { id: "a", n: 0 },
        { id: "b", n: 2 },
      ]);
      expect(cv.driftResubs).toBe(0);
    });
  });

  // --- Order-signature seam (window + orderSignatureOf) ---------------------------

  // A bounded-window resource whose rows carry an order column (`n`, asc) AND a
  // content-only column (`note`). `orderSignatureOf` encodes just `n`, so a `note`
  // bump is in-place while an `n` bump re-derives the window — the notifications
  // resurface flow (createdAt bumped, dismissed unchanged).
  const sigRowsSchema = z.array(
    z.object({ id: z.string(), n: z.number(), note: z.string() }),
  );

  function sigHarness(limit: number) {
    const table = new Map<string, { n: number; note: string }>();
    const members = (): { id: string; n: number; note: string }[] =>
      [...table.entries()]
        .map(([id, c]) => ({ id, ...c }))
        .sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : 1));
    const loaderCalls: string[] = [];
    let windowIdsOfCalls = 0;
    const h = createHarness();
    h.runtime.defineResource(
      {
        key: "sig",
        schema: sigRowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        ...scopeFor("sig_table"),
        membership: {
          kind: "window",
          windowIdsOf: async () => {
            windowIdsOfCalls++;
            return members()
              .slice(0, limit)
              .map((r) => r.id);
          },
          orderSignatureOf: (row) => String((row as { n: number }).n),
          limitOf: () => limit,
        },
        loader: (_p, c) => {
          if (c === undefined) {
            loaderCalls.push("FULL");
            return members().slice(0, limit);
          }
          loaderCalls.push([...c.affectedIds].sort().join(","));
          return c.affectedIds
            .filter((id) => table.has(id))
            .map((id) => ({ id, ...table.get(id)! }));
        },
      },
    );
    const feed = (op: "I" | "U" | "D", ids: string[] | null) =>
      feedChange(h, { table: "sig_table", op, ids });
    const update = (
      id: string,
      mut: (c: { n: number; note: string }) => void,
    ) => {
      mut(table.get(id)!);
      feed("U", [id]);
    };
    return {
      h,
      table,
      loaderCalls,
      windowIdsOf: () => windowIdsOfCalls,
      feed,
      update,
    };
  }

  describe("window membership — order signature", () => {
    test("an order-column bump on a member re-derives the window: one windowIdsOf, delta with the fresh order", async () => {
      const s = sigHarness(3);
      s.table.set("a", { n: 1, note: "" });
      s.table.set("b", { n: 2, note: "" });
      s.table.set("c", { n: 3, note: "" });
      await s.h.subscribe("sig"); // window [a,b,c], sigs seeded at sub-ack
      s.loaderCalls.length = 0;

      s.update("b", (c) => {
        c.n = 0; // resurface: the order column moves, membership unchanged
      });
      await tick();

      expect(s.loaderCalls).toEqual(["b"]); // one scoped refill — O(changed)
      expect(s.windowIdsOf()).toBe(1); // the signature move cost one bounded ids query
      const ds = deltas(s.h, "sig");
      expect(ds).toHaveLength(1);
      expect(ds[0]!.order).toEqual(["b", "a", "c"]);
      expect(ds[0]!.upserts).toEqual([["b", { id: "b", n: 0, note: "" }]]);
      expect(ds[0]!.deletes).toEqual([]);

      const cv = makeClientView(keyOf);
      cv.applyAll(s.h.frames);
      expect(cv.value).toEqual([
        { id: "b", n: 0, note: "" },
        { id: "a", n: 1, note: "" },
        { id: "c", n: 3, note: "" },
      ]);
      expect(cv.driftResubs).toBe(0);
    });

    test("a content-only bump keeps the in-place path: zero ids queries, order omitted", async () => {
      const s = sigHarness(3);
      s.table.set("a", { n: 1, note: "" });
      s.table.set("b", { n: 2, note: "" });
      await s.h.subscribe("sig");
      s.loaderCalls.length = 0;

      s.update("a", (c) => {
        c.note = "seen"; // the count/lastSeenAt-style bump — sig unchanged
      });
      await tick();

      expect(s.loaderCalls).toEqual(["a"]);
      expect(s.windowIdsOf()).toBe(0); // the M5 cost model is preserved
      const ds = deltas(s.h, "sig");
      expect(ds).toHaveLength(1);
      expect(ds[0]!.order).toBeUndefined();
      expect(ds[0]!.upserts).toEqual([["a", { id: "a", n: 1, note: "seen" }]]);
    });

    test("a member bumped past the tail leaves via order, pulling the new tail in", async () => {
      const s = sigHarness(2);
      s.table.set("a", { n: 1, note: "" });
      s.table.set("b", { n: 2, note: "" });
      s.table.set("d", { n: 4, note: "" }); // outside the limit-2 window
      await s.h.subscribe("sig"); // window [a,b]
      s.loaderCalls.length = 0;

      s.update("b", (c) => {
        c.n = 9; // moves past d — b leaves the window, d is pulled in
      });
      await tick();

      expect(s.windowIdsOf()).toBe(1);
      expect(s.loaderCalls).toEqual(["b", "d"]); // refill + tail backfill
      const ds = deltas(s.h, "sig");
      expect(ds).toHaveLength(1);
      // b was not a where-flip exit (the refill returned it), so it leaves purely
      // via the asserted order; d arrives as the backfilled upsert.
      expect(ds[0]!.deletes).toEqual([]);
      expect(ds[0]!.order).toEqual(["a", "d"]);
      expect((ds[0]!.upserts ?? []).map(([id]) => id)).toEqual(["d"]);

      const cv = makeClientView(keyOf);
      cv.applyAll(s.h.frames);
      expect(cv.value).toEqual([
        { id: "a", n: 1, note: "" },
        { id: "d", n: 4, note: "" },
      ]);
      expect(cv.driftResubs).toBe(0);
    });

    test("a signature move that leaves the window sequence intact ships in-place (one probe, no redundant order)", async () => {
      const s = sigHarness(3);
      s.table.set("a", { n: 1, note: "" });
      s.table.set("b", { n: 5, note: "" });
      await s.h.subscribe("sig"); // [a,b]
      s.loaderCalls.length = 0;

      s.update("b", (c) => {
        c.n = 9; // still last — order [a,b] unchanged
      });
      await tick();

      expect(s.windowIdsOf()).toBe(1); // the move had to be arbitrated once
      const ds = deltas(s.h, "sig");
      expect(ds).toHaveLength(1);
      expect(ds[0]!.order).toBeUndefined(); // but no redundant membership delta
      expect(ds[0]!.upserts).toEqual([["b", { id: "b", n: 9, note: "" }]]);
    });

    test("signature lifecycle mirrors the snapshot: FULL rebuild and sub-ack reseed both restore fresh sigs", async () => {
      const s = sigHarness(3);
      s.table.set("a", { n: 1, note: "" });
      s.table.set("b", { n: 2, note: "" });
      await s.h.subscribe("sig");

      // A sticky-FULL contributor rebuilds the snapshot AND the sig map.
      s.feed("I", null);
      await tick();
      expect(s.windowIdsOf()).toBe(0); // the FULL path never runs the ids query

      // A content-only bump right after the FULL rebuild stays in-place — a lost
      // sig would read as "moved" and cost a windowIdsOf here.
      s.update("a", (c) => {
        c.note = "x";
      });
      await tick();
      expect(s.windowIdsOf()).toBe(0);

      // N→0 evicts sigs with the snapshot; a fresh sub-ack reseeds both, so a
      // subsequent order move is detected with exactly one ids query.
      await s.h.unsub("sig");
      await s.h.subscribe("sig");
      s.update("b", (c) => {
        c.n = 0;
      });
      await tick();
      expect(s.windowIdsOf()).toBe(1);
      const last = deltas(s.h, "sig").at(-1)!;
      expect(last.order).toEqual(["b", "a"]);
    });
  });

  // --- Point membership ---------------------------------------------------------

  // A point resource "pt" whose params carry an explicit comma-joined id set (the
  // wire encoding is the client-descriptor layer's business — the runtime only sees
  // `idsOf`). The loader is the scoped read over the requested/params ids.
  function pointHarness(runtimeOpts: Parameters<typeof createHarness>[0] = {}) {
    const table = new Map<string, { n: number }>();
    const loaderCalls: string[] = [];
    const idsOf = (p: Record<string, string>) =>
      (p.ids ?? "").split(",").filter(Boolean);
    const h = createHarness({ sockets: 2, ...runtimeOpts });
    h.runtime.defineResource(
      {
        key: "pt",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        ...scopeFor("pt_table"),
        membership: { kind: "point", idsOf },
        loader: (p, c) => {
          const ids = c ? [...c.affectedIds] : idsOf(p);
          loaderCalls.push(
            (c ? "scoped:" : "FULL:") + [...ids].sort().join(","),
          );
          return ids
            .filter((id) => table.has(id))
            .map((id) => ({ id, n: table.get(id)!.n }));
        },
      },
    );
    const feed = (op: "I" | "U" | "D", ids: string[] | null) =>
      feedChange(h, { table: "pt_table", op, ids });
    return { h, table, loaderCalls, feed };
  }

  describe("point membership — routing by id intersection", () => {
    test("a change routes ONLY to the subscribed tuples whose id set intersects it", async () => {
      const p = pointHarness();
      p.table.set("a", { n: 1 });
      p.table.set("b", { n: 2 });
      p.table.set("c", { n: 3 });
      await p.h.subscribe("pt", { ids: "a,b" }, { socket: 0 });
      await p.h.subscribe("pt", { ids: "c" }, { socket: 1 });
      p.loaderCalls.length = 0;

      // UPDATE a → only the {a,b} tuple refills and receives a frame.
      p.table.set("a", { n: 9 });
      p.feed("U", ["a"]);
      await tick();
      expect(p.loaderCalls).toEqual(["scoped:a"]);
      let ds = deltas(p.h, "pt");
      expect(ds).toHaveLength(1);
      expect(ds[0]!.socket).toBe(0);
      expect(ds[0]!.upserts).toEqual([["a", { id: "a", n: 9 }]]);
      expect(ds[0]!.order).toBeUndefined();

      // DELETE c → only the {c} tuple, as a zero-query delete.
      p.loaderCalls.length = 0;
      p.table.delete("c");
      p.feed("D", ["c"]);
      await tick();
      expect(p.loaderCalls).toEqual([]); // a deleted row is never refilled
      ds = deltas(p.h, "pt");
      expect(ds).toHaveLength(2);
      expect(ds[1]!.socket).toBe(1);
      expect(ds[1]!.deletes).toEqual(["c"]);
      expect(ds[1]!.order).toEqual([]);

      // A change to a foreign id reaches NO tuple: no loader, no frame.
      p.loaderCalls.length = 0;
      p.table.set("z", { n: 0 });
      p.feed("I", ["z"]);
      await tick();
      expect(p.loaderCalls).toEqual([]);
      expect(deltas(p.h, "pt")).toHaveLength(2); // unchanged

      // Both clients converge to their own tuple's truth.
      const cv0 = makeClientView(keyOf);
      cv0.applyAll(p.h.framesFor(0));
      expect(cv0.value).toEqual([
        { id: "a", n: 9 },
        { id: "b", n: 2 },
      ]);
      const cv1 = makeClientView(keyOf);
      cv1.applyAll(p.h.framesFor(1));
      expect(cv1.value).toEqual([]);
    });

    test("an INSERT for a subscribed id with no prior row enters the point set (appended, no ids query)", async () => {
      const p = pointHarness();
      p.table.set("a", { n: 1 });
      await p.h.subscribe("pt", { ids: "a,b" }); // b has no row yet → value [a]
      const ack = p.h.frames.find((f) => f.kind === "sub-ack")!;
      expect(ack.value).toEqual([{ id: "a", n: 1 }]);
      p.loaderCalls.length = 0;

      p.table.set("b", { n: 7 });
      p.feed("I", ["b"]);
      await tick();

      expect(p.loaderCalls).toEqual(["scoped:b"]); // O(changed), never O(set)
      const ds = deltas(p.h, "pt");
      expect(ds).toHaveLength(1);
      expect(ds[0]!.upserts).toEqual([["b", { id: "b", n: 7 }]]);
      expect(ds[0]!.order).toEqual(["a", "b"]); // entrant appended

      const cv = makeClientView(keyOf);
      cv.applyAll(p.h.frames);
      expect(cv.value).toEqual([
        { id: "a", n: 1 },
        { id: "b", n: 7 },
      ]);
      expect(cv.driftResubs).toBe(0);
    });

    // The one-row-per-tuple shape: ONE id per tuple, and a loader that ignores
    // `ctx.affectedIds` outright because its read is already that one row (`where
    // block_id = params.blockId`). What the affected ids buy such a resource is
    // not a narrower query — it is not being asked at all. This pins the
    // difference `membership` makes for that shape: without it the feed schedules
    // a recompute on EVERY subscribed tuple, each of which re-reads its own row
    // and diffs to empty. No frame goes out, which is exactly what hides the cost;
    // the read IS the cost.
    test("a write to one id never reaches another id's subscriber, even when the loader ignores ctx", async () => {
      const table = new Map<string, { n: number }>();
      const loaderCalls: string[] = [];
      const idsOf = (p: Record<string, string>) => [p.id ?? ""];
      const h = createHarness({ sockets: 2 });
      h.runtime.defineResource(
        {
          key: "blk",
          schema: rowsSchema,
          keyed: { keyOf },
          validateParams: () => {},
        },
        {
          ...scopeFor("blk_table"),
          membership: { kind: "point", idsOf },
          loader: (p: Record<string, string>) => {
            loaderCalls.push(p.id ?? "");
            const row = table.get(p.id ?? "");
            return row ? [{ id: p.id ?? "", n: row.n }] : [];
          },
        },
      );
      const feed = (op: "I" | "U" | "D", ids: string[]) =>
        feedChange(h, { table: "blk_table", op, ids });

      table.set("a", { n: 1 });
      table.set("b", { n: 2 });
      await h.subscribe("blk", { id: "a" }, { socket: 0 });
      await h.subscribe("blk", { id: "b" }, { socket: 1 });
      loaderCalls.length = 0;

      // A doc-update on `a`: `a`'s tuple refills, `b`'s is never asked.
      table.set("a", { n: 9 });
      feed("U", ["a"]);
      await tick();
      expect(loaderCalls).toEqual(["a"]);
      let ds = deltas(h, "blk");
      expect(ds).toHaveLength(1);
      expect(ds[0]!.socket).toBe(0);
      expect(ds[0]!.upserts).toEqual([["a", { id: "a", n: 9 }]]);

      // The row goes away: `a`'s tuple ships the removal from the point set with
      // no loader run at all, and `b`'s tuple still hears nothing.
      loaderCalls.length = 0;
      table.delete("a");
      feed("D", ["a"]);
      await tick();
      expect(loaderCalls).toEqual([]);
      ds = deltas(h, "blk");
      expect(ds).toHaveLength(2);
      expect(ds[1]!.socket).toBe(0);
      expect(ds[1]!.deletes).toEqual(["a"]);
      expect(ds[1]!.order).toEqual([]);

      // Socket 1 (block `b`) received no push across either write.
      expect(deltas(h, "blk").filter((f) => f.socket === 1)).toEqual([]);
    });

    test("a point entry is excluded from persistence even when shouldPersist says yes", async () => {
      const persists: string[] = [];
      const p = pointHarness({
        shouldPersist: () => true,
        captureWatermark: async () => "xmin-1",
        persistSnapshot: async (key) => {
          persists.push(key);
        },
      });
      p.table.set("a", { n: 1 });
      await p.h.subscribe("pt", { ids: "a" });
      p.table.set("a", { n: 2 });
      p.feed("U", ["a"]);
      await tick();
      expect(deltas(p.h, "pt")).toHaveLength(1); // the change itself shipped
      expect(persists).toEqual([]);
    });
  });
}

describe("[routed]", () => membershipSuite());

describe("membership — registration guards", () => {
  // Each guard pairs the compile-time rejection (`@ts-expect-error` FAILS if
  // it ever stops being rejected, so the directive pins the type's behaviour as
  // a test) with the runtime backstop for a caller who casts past the type.
  test("membership and scopedMembership are mutually exclusive", () => {
    const h = createHarness();
    expect(() =>
      // @ts-expect-error — `scopedMembership` and `membership` are mutually exclusive arms
      h.runtime.defineResource(
        {
          key: "bad",
          schema: rowsSchema,
          keyed: { keyOf },
          validateParams: () => {},
        },
        {
          routes: identityPlan("t"),
          scopedMembership: {
            orderOf: async () => [],
            orderSignatureOf: () => "",
          },
          membership: {
            kind: "window",
            windowIdsOf: async () => [],
            limitOf: () => 1,
          },
          loader: async () => [],
        },
      ),
    ).toThrow(/mutually exclusive/);
  });

  test("a window membership requires limitOf", () => {
    const h = createHarness();
    expect(() =>
      // @ts-expect-error — a bounded window states its size (`limitOf`)
      h.runtime.defineResource(
        {
          key: "nolimit",
          schema: rowsSchema,
          keyed: { keyOf },
          validateParams: () => {},
        },
        {
          routes: identityPlan("t"),
          membership: { kind: "window", windowIdsOf: async () => [] },
          loader: async () => [],
        },
      ),
    ).toThrow(/requires limitOf/);
  });

  test("membership requires keyed mode", () => {
    const h = createHarness();
    expect(() =>
      h.runtime.defineResource({
        key: "bad2",
        mode: "push",
        schema: z.number(),
        // @ts-expect-error — membership is not on the non-keyed input form
        membership: { kind: "point", idsOf: () => [] },
        loader: async () => 1,
      }),
    ).toThrow(/membership requires mode "keyed"/);
  });

  test("membership requires routes", () => {
    const h = createHarness();
    expect(() =>
      // @ts-expect-error — every ScopePolicy arm requires `routes`
      h.runtime.defineResource(
        {
          key: "bad3",
          schema: rowsSchema,
          keyed: { keyOf },
          validateParams: () => {},
        },
        {
          membership: {
            kind: "window",
            windowIdsOf: async () => [],
            limitOf: () => 1,
          },
          loader: async () => [],
        },
      ),
    ).toThrow(/membership requires routes/);
  });

  // `routes` with no membership names no tuple owner for a changed row: refused
  // by both tsc and the runtime.
  test("routes require a membership", () => {
    const h = createHarness();
    expect(() =>
      // @ts-expect-error — routes with no membership / scopedMembership
      h.runtime.defineResource(
        {
          key: "bad4",
          schema: rowsSchema,
          keyed: { keyOf },
          validateParams: () => {},
        },
        { routes: identityPlan("t"), loader: async () => [] },
      ),
    ).toThrow(/"routes" requires a membership/);
  });
});
