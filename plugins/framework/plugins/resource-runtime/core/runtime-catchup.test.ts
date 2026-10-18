/**
 * Over-replay idempotence + the L2 persist-hook calling contract. Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime-catchup.test.ts`.
 *
 * The L2 cold-boot catch-up (`live-state-snapshot/catch-up.ts`) replays changelog
 * rows through the SAME `routeChange` the live LISTEN consumer uses. Its safety
 * rests on "over-replay is harmless / under-replay is impossible"
 * (`research/2026-06-22-global-live-state-l2-persisted-materialization.md` §2/§6):
 * replaying an already-reflected change recomputes an identical value, the keyed
 * diff comes back empty, and NO frame is sent. This file pins that at the runtime
 * seam, plus the persist-hook calling contract
 * (`shouldPersist`/`captureWatermark`/`persistSnapshot`) that catch-up leans on.
 *
 * The xmin-vs-changelog-floor ARITHMETIC and the `persist.ts` SQL live behind the
 * `db` singleton and are out of reach at this fake-injection seam (filed as a
 * follow-up DB-backed harness) — this file covers only the cascade + hook-contract
 * half, which is fully fake-testable.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createHarness, tick, makeClientView } from "./test-support";
import {
  defineRoutedTable,
  feedChange,
  wholeReach,
} from "./testing/routed-fixture";
import type { PersistMeta } from "./runtime";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));
const keyOf = (r: unknown) => (r as { id: string }).id;

// Keyed entries are routed aliases over their identity table (the shared
// fixture); scoped changes reach an entry only through its routes since P8
// step 23a.

describe("over-replay idempotence", () => {
  test("replaying the same keyed UPDATE twice: first ships a delta, the second is an empty-diff no-op (no frame)", async () => {
    const pushLog: Array<{ changed: boolean }> = [];
    const h = createHarness({
      onPush: (_key, info) => pushLog.push({ changed: info.changed }),
    });
    // The DB truth the loader reflects. sub-ack seeds the snapshot from [a:1,b:1];
    // then the truth moves to a:2. BOTH replays load that same a:2 truth.
    let truth = [
      { id: "a", n: 1 },
      { id: "b", n: 1 },
    ];
    const rows = defineRoutedTable(h, {
      key: "rows",
      table: "row_table",
      membership: "alias",
      schema: rowsSchema,
      loader: (_p, c) =>
        c ? truth.filter((r) => c.affectedIds.includes(r.id)) : truth,
    });
    await h.subscribe("rows"); // snapshot seeded: a:1, b:1
    truth = [
      { id: "a", n: 2 },
      { id: "b", n: 1 },
    ];

    const replay = () => rows.feed("U", ["a"]);

    // First replay: a:1 → a:2 is a real change → one delta, changed:true.
    replay();
    await tick();
    expect(pushLog).toEqual([{ changed: true }]);
    expect(h.pushesFor("rows").filter((f) => f.kind === "delta")).toHaveLength(
      1,
    );

    // Second (over-)replay: identical truth → empty scoped diff → onPush
    // changed:false, and NO second delta frame is sent.
    replay();
    await tick();
    expect(pushLog).toEqual([{ changed: true }, { changed: false }]);
    expect(h.pushesFor("rows").filter((f) => f.kind === "delta")).toHaveLength(
      1,
    ); // still just the one

    // The client simulator lands in the identical state after both replays: a:2,
    // b:1, one delta applied, zero drift.
    const cv = makeClientView(keyOf);
    cv.applyAll(h.frames);
    expect(cv.value).toEqual([
      { id: "a", n: 2 },
      { id: "b", n: 1 },
    ]);
    expect(cv.driftResubs).toBe(0);
  });
});

describe("over-replay idempotence — a seeded scopedMembership entry", () => {
  // The L2 boot seed (`seedPersistedSnapshot`) restores a persisted alias's in-memory
  // diff base BEFORE catch-up, so the missed-changes replay is scoped, not a FULL
  // O(collection) rebuild. This pins that at the runtime seam: a seeded entry replays
  // a straddling I/U/D sequence (catch-up runs with NO subscriber), stays on the
  // scoped/membership path throughout, and the reconstructed value converges to
  // server truth — over-replay included. Contrast the "degrade to FULL with no
  // snapshot" case in runtime-scoped-membership.test.ts, which does NOT seed and so
  // FULL-recomputes its first change.
  test("seed a base, replay U/I/D + an over-replay: value converges to truth, no FULL rebuild", async () => {
    const truth = new Map<string, number>([
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ]);
    const order = () => [...truth.keys()].sort();
    const members = () => order().map((id) => ({ id, n: truth.get(id)! }));
    const log: string[] = [];
    const persisted: Array<{ value: unknown; wm: string; mode: string }> = [];
    const h = createHarness({
      shouldPersist: (k) => k === "rows",
      captureWatermark: async () => "xmin",
      persistWindowMs: 0,
      persistSnapshot: async (_k, _pk, value, wm, meta) => {
        persisted.push({ value, wm, mode: meta.mode });
      },
    });
    const rows = defineRoutedTable(h, {
      key: "rows",
      table: "row_table",
      membership: "alias",
      schema: rowsSchema,
      orderOf: async () => order(),
      loader: (_p, c) => {
        if (c === undefined) {
          log.push("FULL");
          return members();
        }
        log.push("scoped");
        return c.affectedIds
          .filter((id) => truth.has(id))
          .map((id) => ({ id, n: truth.get(id)! }));
      },
    });
    const feed = (op: "I" | "U" | "D", ids: string[]) => rows.feed(op, ids);

    // Cold-boot seed: restore the diff base from the durable L2 value, exactly as
    // live-state-snapshot's onReady does BEFORE catch-up. No subscriber — catch-up
    // runs before any client subscribes.
    h.runtime.seedPersistedSnapshot("rows", "{}", members(), {
      position: "100",
      positionAt: null,
    }); // base [a,b,c], floored at the row's position

    // Catch-up replays a straddling I/U/D sequence (truth mutated to match each row).
    truth.set("a", 2);
    feed("U", ["a"]); // in-window update → scoped refill of just "a"
    await tick();
    truth.set("d", 5);
    feed("I", ["d"]); // insert → scoped refill of "d" + one orderOf
    await tick();
    truth.delete("b");
    feed("D", ["b"]); // delete → ZERO loaders (order from the snapshot)
    await tick();
    feed("U", ["a"]); // over-replay of an already-reflected change (empty diff)
    await tick();
    await tick(); // the last armed floor window

    // The seed did its job: every replay stayed on the scoped/membership path — never
    // one FULL O(collection) rebuild. U + I + the over-replay U each refill one id;
    // the D runs no loader at all.
    expect(log).toEqual(["scoped", "scoped", "scoped"]);
    // The reconstructed materialized value converged to server truth, and the
    // over-replay is idempotent (the last persist equals it byte-for-byte).
    const truthValue = [
      { id: "a", n: 2 },
      { id: "c", n: 1 },
      { id: "d", n: 5 },
    ];
    // Every persist was a FLOOR persist floored by the seeded row's position —
    // the snapshot's base — never by a capture taken at a scoped drain (C19).
    expect(persisted.length).toBeGreaterThan(0);
    for (const p of persisted) {
      expect(p.mode).toBe("floor");
      expect(p.wm).toBe("100");
    }
    expect(persisted.at(-1)!.value).toEqual(truthValue);

    // A client subscribing now (post-catch-up) converges to the same server truth.
    await h.subscribe("rows");
    const cv = makeClientView(keyOf);
    cv.applyAll(h.frames);
    expect(cv.value).toEqual(truthValue);
    expect(cv.driftResubs).toBe(0);
  });
});

describe("recomputeResource", () => {
  test("routes one FULL feed notify to subscribers (exactly one push)", async () => {
    const h = createHarness();
    h.runtime.defineResource({
      key: "k",
      mode: "push",
      schema: z.number(),
      loader: async () => 1,
    });
    await h.subscribe("k");
    const base = h.frames.find((f) => f.kind === "sub-ack")!.version!;

    h.runtime.recomputeResource("k");
    await tick();

    const pushes = h.pushesFor("k");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.kind).toBe("update"); // a FULL value push
    expect(pushes[0]!.version).toBe(base + 1);
  });

  test("is a no-op for an unknown key (never throws)", async () => {
    const h = createHarness();
    expect(() => h.runtime.recomputeResource("nope")).not.toThrow();
    await tick();
    expect(h.frames).toHaveLength(0);
  });
});

describe("L2 persist-hook calling contract", () => {
  // A persisted non-keyed push value (a whole-table reach plan) + injected fakes
  // recording into a shared ordered call-log — the non-membership FULL drain's
  // persist contract (a membership
  // alias's is pinned in runtime-scoped-membership / -table-routing).
  // `shouldPersist` selects the key; `lastReadSet` (the per-run capture)
  // supplies `tablesRead`, falling back to the reach plan's route tables when
  // absent.
  function persistHarness(overrides: {
    captureWatermark?: () => Promise<string>;
    persistSnapshot?: (
      key: string,
      pk: string,
      value: unknown,
      wm: string,
      meta: PersistMeta,
    ) => Promise<void>;
    loader?: () => { id: string; n: number }[];
    lastReadSet?: (key: string) => string[] | undefined;
  }) {
    const log: string[] = [];
    const persistArgs: Array<{
      key: string;
      pk: string;
      value: unknown;
      wm: string;
      tables: readonly string[];
      mode: PersistMeta["mode"];
    }> = [];
    const h = createHarness({
      lastReadSet: overrides.lastReadSet,
      shouldPersist: (k) => k === "p",
      captureWatermark:
        overrides.captureWatermark ??
        (async () => {
          log.push("wm");
          return "xmin-7";
        }),
      persistSnapshot:
        overrides.persistSnapshot ??
        (async (key, pk, value, wm, meta) => {
          log.push("persist");
          persistArgs.push({
            key,
            pk,
            value,
            wm,
            tables: meta.guardTables,
            mode: meta.mode,
          });
        }),
    });
    h.runtime.defineResource(
      { key: "p", schema: rowsSchema, validateParams: () => {} },
      {
        mode: "push",
        reach: wholeReach(["p_table"]),
        loader: (_p) => {
          log.push("load:FULL");
          return overrides.loader ? overrides.loader() : [{ id: "a", n: 1 }];
        },
      },
    );
    return { h, log, persistArgs };
  }

  test("captureWatermark is called BEFORE the loader's first read", async () => {
    const { h, log } = persistHarness({});
    h.runtime.recomputeResource("p"); // zero subscribers — still recomputes (below)
    await tick();
    expect(log.indexOf("wm")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("wm")).toBeLessThan(log.indexOf("load:FULL"));
  });

  test("a persisted entry with ZERO subscribers still recomputes FULL and persists (value + watermark + tablesRead)", async () => {
    const { h, log, persistArgs } = persistHarness({});
    h.runtime.recomputeResource("p"); // nobody subscribed
    await tick();

    // Full recompute + persist even with no subscriber: needValue is forced.
    // Exactly ONE "wm": the flight's own capture, taken inside `getResourceValue`
    // before the loader's first read, and used for BOTH stamps — the wire
    // watermark and the persisted row's catch-up floor. A floor may only describe
    // the read it accompanies, so a second capture at the drain would be wrong,
    // not merely wasteful: it could be NEWER than a joined flight's value, and
    // catch-up (which replays only `xid >= watermark`) would skip the very commit
    // the value is missing — a stale cold boot that survives restarts. See
    // research/2026-08-08-global-live-state-flight-freshness.md.
    expect(log).toEqual(["wm", "load:FULL", "persist"]);
    expect(persistArgs).toHaveLength(1);
    expect(persistArgs[0]!.value).toEqual([{ id: "a", n: 1 }]); // the FULL value
    expect(persistArgs[0]!.wm).toBe("xmin-7"); // the captured watermark
    expect(persistArgs[0]!.tables).toEqual(["p_table"]); // fallback to the route tables (no lastReadSet)
    expect(persistArgs[0]!.pk).toBe(JSON.stringify({})); // param-less pk
    expect(persistArgs[0]!.mode).toBe("replace"); // a FULL recompute replaces the row

    // Nothing shipped (no subscriber) — persistence is decoupled from delivery.
    expect(h.frames).toHaveLength(0);
  });

  test("persists the PER-RUN read-set (replace, self-healing) over the union when lastReadSet is present", async () => {
    // The union (`readSet`) still carries a stale `notifications` edge from a past
    // mis-attribution; the per-run capture (`lastReadSet`) has only what this FULL
    // run actually read. The persist must use the per-run set so the durable seed
    // sheds the stale edge instead of re-persisting it forever.
    const persistArgs: Array<{ tables: readonly string[] }> = [];
    const h = createHarness({
      readSet: (k) => (k === "p" ? ["p_table", "notifications"] : []), // stale union
      lastReadSet: (k) => (k === "p" ? ["p_table"] : undefined), // clean per-run
      shouldPersist: (k) => k === "p",
      captureWatermark: async () => "xmin-9",
      persistSnapshot: async (_key, _pk, _value, _wm, meta) => {
        persistArgs.push({ tables: meta.guardTables });
      },
    });
    h.runtime.defineResource(
      { key: "p", schema: rowsSchema, validateParams: () => {} },
      { mode: "push", loader: () => [{ id: "a", n: 1 }] },
    );
    h.runtime.recomputeResource("p");
    await tick();
    expect(persistArgs).toHaveLength(1);
    expect(persistArgs[0]!.tables).toEqual(["p_table"]); // per-run wins, `notifications` shed
  });

  test("persistSnapshot is NEVER called on loader failure (but captureWatermark was)", async () => {
    const { h, log } = persistHarness({
      loader: () => {
        throw new Error("loader boom");
      },
    });
    h.runtime.recomputeResource("p");
    await tick();
    // The flight's watermark was captured (it is taken before the read), the
    // loader ran and threw — and nothing is persisted on the failure path. One
    // capture, because the persist floor IS the flight's watermark.
    expect(log).toEqual(["wm", "load:FULL"]);
  });

  test("persistSnapshot throwing does NOT block the subscriber's frame", async () => {
    const { h } = persistHarness({
      persistSnapshot: async () => {
        throw new Error("persist boom");
      },
    });
    await h.subscribe("p");
    feedChange(h, { table: "p_table", op: "U", ids: null });
    await tick();
    // The persist rejected, but the subscriber still received its push.
    expect(h.pushesFor("p")).toHaveLength(1);
  });

  test("captureWatermark throwing does NOT block the frame and skips the persist", async () => {
    const log: string[] = [];
    const { h } = persistHarness({
      captureWatermark: async () => {
        throw new Error("wm boom");
      },
      persistSnapshot: async () => {
        log.push("persist");
      },
    });
    await h.subscribe("p");
    feedChange(h, { table: "p_table", op: "U", ids: null });
    await tick();
    // Frame delivered; persist skipped (no watermark to stamp).
    expect(h.pushesFor("p")).toHaveLength(1);
    expect(log).toEqual([]);
  });
});
