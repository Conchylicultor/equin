/**
 * Declared reads beyond the db arm — Resources [11] session 2's runtime half
 * (research/2026-10-17-global-live-declared-reads-externals-session2.md):
 *
 * - D1: `reach` on a NON-keyed external (its loader's Postgres reads, beside
 *   its own notify), and the `{}` target of a param-less entry whose drain
 *   cascades to downstreams;
 * - D2: relation reads (`ReachPlan.relations`) — reached through their bases
 *   once `indexRelationReads()` ran, accepted by the drift guard by name;
 * - D4: a deferred EXTERNAL value (its reads computed at bind);
 * - D5: the undeclared-read guard on every notified external;
 * - D6: `unroutedResourceKeys()`;
 * - D7: `seedRouteDrift()` and the persisted read-set fallback.
 *
 * Run with `./singularity test plugins/framework/plugins/resource-runtime`.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import { mintReachPlan, mintRoutePlan, type RelationRead } from "./routing";
import { createHarness, tick, type Harness } from "./test-support";
import type {
  PersistMeta,
  ResourceParams,
  ResourceRuntimeOptions,
} from "./runtime";

// Two macrotasks: the flush, and a re-drain pass it may schedule.
const settle = async () => {
  await tick();
  await tick();
};

function change(h: Harness, table: string, xid?: string): void {
  h.runtime.routeTableChange({
    source: "feed",
    table,
    op: "U",
    ids: ["x"],
    keys: null,
    unchanged: null,
    ...(xid !== undefined ? { xid } : {}),
  });
}

/** A whole-table reach plan over `tables` (as `compiledValueReach` mints one), every tuple reading every table. */
function wholeReads(
  tables: readonly string[],
  relations: readonly RelationRead[] = [],
) {
  return mintReachPlan({
    routes: tables.map((table) => ({
      id: table,
      table,
      map: { kind: "full" as const, reason: `reads ${table} whole` },
      columns: ["id"],
    })),
    usesOf: () =>
      new Map(tables.map((t) => [t, { role: "membership" as const }])),
    ...(relations.length > 0 ? { relations } : {}),
  });
}

interface DebugEntry {
  key: string;
  policy: string;
  routes: Array<{ id: string; table: string }> | null;
  relationReads: Array<{ relation: string; reason: string; bases: string[] }>;
  routeDrifted: string[];
  routeDriftSeeded: string[];
  externalSource: boolean;
  freshness: { kind: string } | null;
}

async function debugOf(h: Harness, key: string): Promise<DebugEntry> {
  const res = await h.runtime.handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  const body = (await res.json()) as { resources: DebugEntry[] };
  return body.resources.find((r) => r.key === key)!;
}

/** A non-keyed external value with `reach`, recording its loads. */
function reachedExternal(
  runtime: ResourceRuntimeOptions = {},
  tables: readonly string[] = ["conversations"],
) {
  const loads: ResourceParams[] = [];
  const reports: string[] = [];
  const h = createHarness({
    reportError: (ctx) => reports.push(ctx),
    ...runtime,
  });
  const ext = h.runtime.defineExternalResource(
    { key: "edits", schema: z.number(), validateParams: () => {} },
    {
      mode: "push",
      reach: wholeReads(tables),
      loader: (p) => {
        loads.push(p);
        return loads.length;
      },
    },
  );
  return { h, ext, loads, reports };
}

describe("D1 — reach on a non-keyed external", () => {
  test("a table write FULL-recomputes the subscribed tuples only — an unsubscribed tuple is not reloaded", async () => {
    const r = reachedExternal();
    await r.h.subscribe("edits", { id: "a" });
    r.loads.length = 0;
    change(r.h, "conversations");
    await settle();
    expect(r.loads).toEqual([{ id: "a" }]);
    await r.h.unsub("edits", { id: "a" });
    r.loads.length = 0;
    change(r.h, "conversations");
    await settle();
    expect(r.loads).toEqual([]);
  });

  test("a hand notify and a table change in one flush load the tuple once", async () => {
    const r = reachedExternal();
    await r.h.subscribe("edits", { id: "a" });
    r.loads.length = 0;
    r.ext.notify({ id: "a" });
    change(r.h, "conversations");
    await settle();
    expect(r.loads).toEqual([{ id: "a" }]);
    expect(
      r.h.pushesFor("edits").filter((f) => f.kind === "update"),
    ).toHaveLength(1);
  });

  test("a tuple the change skips owes only its ack — no load", async () => {
    const loads: ResourceParams[] = [];
    const h = createHarness();
    h.runtime.defineExternalResource(
      { key: "edits", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: mintReachPlan({
          routes: ["conversations", "attempts"].map((table) => ({
            id: table,
            table,
            map: { kind: "full" as const, reason: "whole" },
            columns: ["id"],
          })),
          // Only a tuple naming an attempt reads `attempts`.
          usesOf: (p) =>
            new Map(
              (p.attempt
                ? ["conversations", "attempts"]
                : ["conversations"]
              ).map((t) => [t, { role: "membership" as const }]),
            ),
        }),
        loader: (p) => {
          loads.push(p);
          return loads.length;
        },
      },
    );
    await h.subscribe("edits", { id: "a" }, { acks: true });
    loads.length = 0;
    change(h, "attempts", "tx-7");
    await settle();
    expect(loads).toEqual([]);
    expect(
      h.frames.filter((f) => f.kind === "ack").map((f) => f.ackTx),
    ).toEqual([["tx-7"]]);
  });

  test("a routed change acks the reloaded tuple on its update frame", async () => {
    const r = reachedExternal();
    await r.h.subscribe("edits", { id: "a" }, { acks: true });
    change(r.h, "conversations", "tx-1");
    await settle();
    const update = r.h.pushesFor("edits").find((f) => f.kind === "update")!;
    expect(update.ackTx).toEqual(["tx-1"]);
  });

  test("_debug: policy external, its routes listed", async () => {
    const r = reachedExternal({ readSet: () => ["conversations"] });
    const entry = await debugOf(r.h, "edits");
    expect(entry.policy).toBe("external");
    expect(entry.routes?.map((x) => x.table)).toEqual(["conversations"]);
    expect(r.h.runtime.unroutedResourceKeys()).toEqual([]);
  });

  test("a param-less entry with downstream edges is reached at `{}` with nobody subscribed, so its cascade still runs", async () => {
    const upLoads: ResourceParams[] = [];
    const downLoads: ResourceParams[] = [];
    const h = createHarness();
    h.runtime.defineExternalResource(
      { key: "head", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: wholeReads(["refs"]),
        loader: (p) => {
          upLoads.push(p);
          return upLoads.length;
        },
      },
    );
    h.runtime.defineExternalResource(
      { key: "graph", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        dependsOn: [{ resource: { key: "head" } as never }],
        loader: (p) => {
          downLoads.push(p);
          return downLoads.length;
        },
      },
    );
    await h.subscribe("graph", {});
    downLoads.length = 0;
    change(h, "refs");
    await settle();
    // The upstream's `{}` drained (no subscriber, so no load of its own) and
    // cascaded to the subscribed downstream.
    expect(upLoads).toEqual([]);
    expect(downLoads).toEqual([{}]);
  });

  test("with a tuple subscribed, an entry with downstream edges is not also reloaded at `{}`", async () => {
    const upLoads: ResourceParams[] = [];
    const h = createHarness();
    h.runtime.defineExternalResource(
      { key: "head", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: wholeReads(["refs"]),
        loader: (p) => {
          upLoads.push(p);
          return upLoads.length;
        },
      },
    );
    h.runtime.defineExternalResource(
      { key: "graph", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        dependsOn: [{ resource: { key: "head" } as never }],
        loader: () => 1,
      },
    );
    await h.subscribe("head", { repo: "a" });
    upLoads.length = 0;
    change(h, "refs");
    await settle();
    expect(upLoads).toEqual([{ repo: "a" }]);
  });

  test("an entry with downstream edges whose params gate refuses `{}` is not reached at `{}`", async () => {
    const upLoads: ResourceParams[] = [];
    const h = createHarness();
    h.runtime.defineExternalResource(
      {
        key: "head",
        schema: z.number(),
        validateParams: (p) => {
          if (typeof p.repo !== "string") {
            throw new ResourceContractError("head", "repo is required");
          }
        },
      },
      {
        mode: "push",
        reach: wholeReads(["refs"]),
        loader: (p) => {
          upLoads.push(p);
          return upLoads.length;
        },
      },
    );
    h.runtime.defineExternalResource(
      { key: "graph", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        dependsOn: [{ resource: { key: "head" } as never }],
        loader: () => 1,
      },
    );
    change(h, "refs");
    await settle();
    expect(upLoads).toEqual([]);
  });

  test("a reach upstream cascades in either registration order", async () => {
    for (const order of ["upstream-first", "downstream-first"] as const) {
      const downLoads: ResourceParams[] = [];
      const h = createHarness();
      const defineUp = () =>
        h.runtime.defineExternalResource(
          { key: "head", schema: z.number(), validateParams: () => {} },
          { mode: "push", reach: wholeReads(["refs"]), loader: () => 1 },
        );
      const defineDown = () =>
        h.runtime.defineExternalResource(
          { key: "graph", schema: z.number(), validateParams: () => {} },
          {
            mode: "push",
            dependsOn: [{ resource: { key: "head" } as never }],
            loader: (p) => {
              downLoads.push(p);
              return downLoads.length;
            },
          },
        );
      if (order === "upstream-first") {
        defineUp();
        defineDown();
      } else {
        defineDown();
        defineUp();
      }
      await h.subscribe("graph", {});
      downLoads.length = 0;
      change(h, "refs");
      await settle();
      expect([order, downLoads]).toEqual([order, [{}]]);
    }
  });

  test("a param-less entry with no downstream and nobody subscribed is not reached", async () => {
    const r = reachedExternal();
    change(r.h, "conversations");
    await settle();
    expect(r.loads).toEqual([]);
  });
});

describe("D2 — relation reads", () => {
  const bases = (relation: string): readonly string[] =>
    relation === "tasks_v" ? ["tasks", "attempts"] : [relation];

  function relationValue(runtime: ResourceRuntimeOptions = {}) {
    const loads: ResourceParams[] = [];
    const h = createHarness({ relationBases: bases, ...runtime });
    const define = (key = "catalog") =>
      h.runtime.defineResource(
        { key, schema: z.number(), validateParams: () => {} },
        {
          mode: "push",
          reach: wholeReads(
            ["origins"],
            [{ relation: "tasks_v", reason: "filters on the derived status" }],
          ),
          loader: (p) => {
            loads.push(p);
            return loads.length;
          },
        },
      );
    return { h, loads, define };
  }

  test("reached through its bases only once indexRelationReads() ran — never under its own name", async () => {
    const v = relationValue();
    v.define();
    await v.h.subscribe("catalog", {});
    v.loads.length = 0;
    change(v.h, "attempts");
    await settle();
    expect(v.loads).toEqual([]); // bases unknown yet: not indexed
    v.h.runtime.indexRelationReads();
    v.h.runtime.indexRelationReads(); // idempotent
    change(v.h, "attempts");
    await settle();
    expect(v.loads).toEqual([{}]);
    v.loads.length = 0;
    change(v.h, "tasks_v");
    await settle();
    expect(v.loads).toEqual([]); // a change names base tables only
  });

  test("an entry registered after indexRelationReads() expands its own", async () => {
    const v = relationValue();
    v.h.runtime.indexRelationReads();
    v.define("late");
    await v.h.subscribe("late", {});
    v.loads.length = 0;
    change(v.h, "tasks");
    await settle();
    expect(v.loads).toEqual([{}]);
  });

  test("resetRelationReads drops the bases until the next index, and a re-index over a new graph drops the old ones", async () => {
    let graph: ((r: string) => readonly string[]) | null = bases;
    const v = relationValue({
      relationBases: (r) => {
        if (graph === null) throw new Error("relation bases read before set");
        return graph(r);
      },
    });
    v.define();
    v.h.runtime.indexRelationReads();
    graph = null;
    v.h.runtime.resetRelationReads();
    // A registration while the bases are unknown expands nothing — and
    // never reads the cleared holder.
    expect(() => v.define("late")).not.toThrow();
    await v.h.subscribe("catalog", {});
    v.loads.length = 0;
    change(v.h, "attempts");
    await settle();
    expect(v.loads).toEqual([]);
    graph = (r) => (r === "tasks_v" ? ["tasks", "runs"] : [r]);
    v.h.runtime.indexRelationReads();
    change(v.h, "runs");
    await settle();
    expect(v.loads).toEqual([{}]);
    v.loads.length = 0;
    change(v.h, "attempts"); // a base of the old graph only
    await settle();
    expect(v.loads).toEqual([]);
  });

  test("the drift guard accepts the relation's own name in a capture, under strictRoutes", async () => {
    const v = relationValue({
      lastReadSet: () => ["origins", "tasks_v"],
      strictRoutes: true,
    });
    v.define();
    await v.h.subscribe("catalog", {});
    expect(v.h.frames.map((f) => f.kind)).toEqual(["sub-ack"]);
  });

  test("_debug lists each relation read with its reason and bases", async () => {
    const v = relationValue();
    v.define();
    expect((await debugOf(v.h, "catalog")).relationReads).toEqual([
      {
        relation: "tasks_v",
        reason: "filters on the derived status",
        bases: ["attempts", "tasks"],
      },
    ]);
  });

  test("minting refuses a relation that is a route or unfed table, one listed twice, or one with no reason", () => {
    const route = {
      id: "t",
      table: "t",
      map: { kind: "full" as const, reason: "x" },
      columns: [],
    };
    const mint = (
      relations: RelationRead[],
      unfed: { table: string; reason: string }[] = [],
    ) =>
      mintReachPlan({
        routes: [route],
        usesOf: () => new Map(),
        relations,
        unfed,
      });
    expect(() => mint([{ relation: "t", reason: "x" }])).toThrow(
      /both a relation read and a route table/,
    );
    expect(() =>
      mint([{ relation: "c", reason: "x" }], [{ table: "c", reason: "y" }]),
    ).toThrow(/both a relation read and read outside the feed/);
    expect(() =>
      mint([
        { relation: "v", reason: "x" },
        { relation: "v", reason: "y" },
      ]),
    ).toThrow(/listed twice/);
    expect(() => mint([{ relation: "v", reason: " " }])).toThrow(/no reason/);
    expect("relations" in mint([])).toBe(false);
  });
});

describe("D4 — a deferred external value", () => {
  function deferredExternal() {
    const loads: ResourceParams[] = [];
    const h = createHarness();
    const handle = h.runtime.defineDeferredResource(
      { key: "runs", schema: z.number(), validateParams: () => {} },
      () => ({
        mode: "push",
        reach: wholeReads(["job_runs"]),
        loader: (p: ResourceParams) => {
          loads.push(p);
          return loads.length;
        },
      }),
      { mode: "push", freshness: { kind: "notified" } },
    );
    return { h, handle, loads };
  }

  test("external from definition, its reads bound at bind", async () => {
    const d = deferredExternal();
    expect((await debugOf(d.h, "runs")).policy).toBe("unbound");
    expect((await debugOf(d.h, "runs")).externalSource).toBe(true);
    d.h.runtime.bindDeferredResources();
    const entry = await debugOf(d.h, "runs");
    expect(entry.policy).toBe("external");
    expect(entry.freshness).toEqual({ kind: "notified" });
    expect(entry.routes?.map((r) => r.table)).toEqual(["job_runs"]);
    await d.h.subscribe("runs", {});
    d.loads.length = 0;
    change(d.h, "job_runs");
    await settle();
    expect(d.loads).toEqual([{}]);
  });

  test("its notify() works and raises no read-set-gap warning", async () => {
    const d = deferredExternal();
    d.h.runtime.bindDeferredResources();
    await d.h.subscribe("runs", {});
    d.loads.length = 0;
    const warn = spyOn(console, "warn");
    try {
      d.handle.notify();
      await settle();
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("read-set-gap")),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
    expect(d.loads).toEqual([{}]);
  });

  test("a notify before the bind is dropped — nothing is served yet, and the unbound loader never runs", async () => {
    const reports: string[] = [];
    const h = createHarness({ reportError: (ctx) => reports.push(ctx) });
    const handle = h.runtime.defineDeferredResource(
      { key: "runs", schema: z.number(), validateParams: () => {} },
      () => ({ mode: "push", loader: () => 1 }),
      { mode: "push", freshness: { kind: "notified" } },
    );
    handle.notify();
    await settle();
    expect(reports).toEqual([]);
    h.runtime.bindDeferredResources();
    await h.subscribe("runs", {});
    expect(h.frames.map((f) => f.kind)).toEqual(["sub-ack"]);
  });

  test("a bind restating another freshness is refused; a keyed external is refused at definition", () => {
    const h = createHarness();
    h.runtime.defineDeferredResource(
      { key: "x", schema: z.number(), validateParams: () => {} },
      () => ({
        mode: "push",
        freshness: { kind: "snapshot", reason: "asked" },
        loader: () => 1,
      }),
      { mode: "push", freshness: { kind: "notified" } },
    );
    expect(() => h.runtime.bindDeferredResources()).toThrow(
      /externality is fixed where it is defined/,
    );
    expect(() =>
      h.runtime.defineDeferredResource(
        {
          key: "k",
          schema: z.array(z.object({ id: z.string() })),
          keyed: { keyOf: (r: unknown) => (r as { id: string }).id },
          validateParams: () => {},
        } as never,
        () => ({ mode: "push", loader: () => [] }),
        { mode: "push" },
      ),
    ).toThrow(/a deferred external is a non-keyed value/);
  });
});

describe("D5 — the undeclared-read guard on externals", () => {
  function undeclared(
    strictRoutes: boolean,
    freshness?: { kind: "notified" | "snapshot"; reason?: string },
  ) {
    const loads: ResourceParams[] = [];
    const reports: string[] = [];
    const h = createHarness({
      reportError: (ctx) => reports.push(ctx),
      lastReadSet: () => ["mail_accounts"],
      relationBases: (r) => (r === "mail_v" ? ["mail", "accounts"] : [r]),
      strictRoutes,
    });
    h.runtime.defineExternalResource(
      { key: "inbox", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        ...(freshness !== undefined ? { freshness } : {}),
        loader: (p) => {
          loads.push(p);
          return loads.length;
        },
      },
    );
    return { h, loads, reports };
  }

  test("under strictRoutes an undeclared captured read fails the load", async () => {
    const u = undeclared(true, { kind: "notified" });
    await u.h.subscribe("inbox", {});
    expect(u.h.frames.map((f) => f.kind)).toEqual(["sub-error"]);
  });

  test("an external with no declared freshness is guarded too", async () => {
    const u = undeclared(true);
    await u.h.subscribe("inbox", {});
    expect(u.h.frames.map((f) => f.kind)).toEqual(["sub-error"]);
  });

  test("in a running server it is reported once and fails open: a write to it recomputes the tuple FULL", async () => {
    const u = undeclared(false, { kind: "notified" });
    await u.h.subscribe("inbox", { id: "a" });
    await u.h.subscribe("inbox", { id: "b" });
    expect(u.reports).toEqual(["route drift for inbox"]);
    expect(u.h.runtime.unroutedResourceKeys()).toEqual([]);
    const entry = await debugOf(u.h, "inbox");
    expect(entry.policy).toBe("external");
    expect(entry.routes).toEqual([]);
    expect(entry.routeDrifted).toEqual(["mail_accounts"]);
    u.loads.length = 0;
    change(u.h, "mail_accounts");
    await settle();
    expect(u.loads.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  test("a snapshot external claims no push, so its reads are not guarded", async () => {
    const u = undeclared(true, { kind: "snapshot", reason: "refresh" });
    await u.h.subscribe("inbox", {});
    expect(u.h.frames.map((f) => f.kind)).toEqual(["sub-ack"]);
    expect(u.reports).toEqual([]);
    expect((await debugOf(u.h, "inbox")).routes).toBeNull();
  });

  test("a declared read passes, an undeclared one beside it still fails", async () => {
    const h = createHarness({
      lastReadSet: () => ["conversations", "attempts"],
      strictRoutes: true,
    });
    h.runtime.defineExternalResource(
      { key: "ok", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: wholeReads(["conversations", "attempts"]),
        loader: () => 1,
      },
    );
    h.runtime.defineExternalResource(
      { key: "half", schema: z.number(), validateParams: () => {} },
      { mode: "push", reach: wholeReads(["conversations"]), loader: () => 1 },
    );
    await h.subscribe("ok", {});
    await h.subscribe("half", {});
    expect(h.frames.map((f) => [f.key, f.kind])).toEqual([
      ["ok", "sub-ack"],
      ["half", "sub-error"],
    ]);
  });

  test("a keyed external window fails open into a FULL re-read of the tuple", async () => {
    const reports: string[] = [];
    let rows = [{ id: "r1", n: 1 }];
    const h = createHarness({
      reportError: (ctx) => reports.push(ctx),
      lastReadSet: () => ["pages"],
      strictRoutes: false,
    });
    h.runtime.defineExternalResource(
      {
        key: "feed",
        schema: z.array(z.object({ id: z.string(), n: z.number() })),
        keyed: { keyOf: (r) => (r as { id: string }).id },
        validateParams: () => {},
      },
      {
        membership: { kind: "window", limitOf: () => 10 },
        loader: () => rows,
      },
    );
    await h.subscribe("feed", { q: "x" });
    expect(reports).toEqual(["route drift for feed"]);
    rows = [
      { id: "r1", n: 1 },
      { id: "r2", n: 2 },
    ];
    change(h, "pages");
    await settle();
    const delta = h.pushesFor("feed").find((f) => f.kind === "delta");
    expect(delta).toBeDefined();
    expect(delta!.order).toEqual(["r1", "r2"]);
  });
});

describe("D6 — unroutedResourceKeys", () => {
  test("lists every bound DB-backed entry with no plan — never an external, a routed one or an unbound placeholder", () => {
    const h = createHarness();
    h.runtime.defineResource({
      key: "bare",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    h.runtime.defineResource(
      { key: "routed", schema: z.number(), validateParams: () => {} },
      { mode: "push", reach: wholeReads(["t"]), loader: () => 1 },
    );
    h.runtime.defineExternalResource({
      key: "ext",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    h.runtime.defineDeferredResource(
      { key: "later", schema: z.number(), validateParams: () => {} },
      () => ({ mode: "push" as const, loader: () => 1 }),
    );
    expect(h.runtime.unroutedResourceKeys()).toEqual(["bare"]);
    h.runtime.bindDeferredResources();
    expect(h.runtime.unroutedResourceKeys()).toEqual(["bare", "later"]);
  });

  test("_debug reports an entry no change reaches as `unrouted`", async () => {
    const h = createHarness();
    h.runtime.defineResource({
      key: "bare",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    const entry = await debugOf(h, "bare");
    expect(entry.policy).toBe("unrouted");
    expect(entry.routes).toBeNull();
  });
});

describe("D7 — drift survives a restart", () => {
  function persistedValue(runtime: ResourceRuntimeOptions = {}) {
    const loads: ResourceParams[] = [];
    const reports: string[] = [];
    const persists: PersistMeta[] = [];
    const h = createHarness({
      reportError: (ctx) => reports.push(ctx),
      relationBases: (r) =>
        r === "attempt_conv_agg" ? ["attempts", "conversations"] : [r],
      shouldPersist: (k) => k === "unread",
      captureWatermark: async () => "xmin-1",
      persistSnapshot: async (_k, _pk, _v, _wm, meta) => {
        persists.push(meta);
      },
      ...runtime,
    });
    h.runtime.defineResource(
      { key: "unread", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: wholeReads(
          ["notifications"],
          [{ relation: "attempt_conv_agg", reason: "counts per attempt" }],
        ),
        loader: (p) => {
          loads.push(p);
          return loads.length;
        },
      },
    );
    return { h, loads, reports, persists };
  }

  test("an uncovered persisted read fails open, unreported — a write to it reaches the persisted `{}`", async () => {
    const v = persistedValue();
    expect(
      v.h.runtime.seedRouteDrift([
        { key: "unread", tablesRead: ["notifications", "stray"] },
        { key: "unknown", tablesRead: ["stray"] },
      ]),
    ).toEqual([{ key: "unread", tables: ["stray"] }]);
    // The row may predate a declaration change: no report from the seed.
    expect(v.reports).toEqual([]);
    const entry = await debugOf(v.h, "unread");
    expect(entry.routeDrifted).toEqual([]);
    expect(entry.routeDriftSeeded).toEqual(["stray"]);
    change(v.h, "stray");
    await settle();
    expect(v.loads).toEqual([{}]);
  });

  test("a load that still reads a seeded relation reports it once as drift; one that does not un-routes it, silently", async () => {
    let captured = ["notifications", "stray"];
    const v = persistedValue({
      lastReadSet: () => captured,
      strictRoutes: false,
    });
    v.h.runtime.seedRouteDrift([
      { key: "unread", tablesRead: ["notifications", "stray", "old"] },
    ]);
    // Seeded: a write to `old` reaches the entry until a load judges it.
    change(v.h, "old");
    await settle();
    expect(v.loads).toHaveLength(1);
    expect(v.reports).toEqual(["route drift for unread"]); // that load read `stray`
    expect((await debugOf(v.h, "unread")).routeDriftSeeded).toEqual([]);
    // `old` was not read: no longer routed to the entry.
    change(v.h, "old");
    await settle();
    expect(v.loads).toHaveLength(1);
    captured = ["notifications", "stray"];
    v.h.runtime.recomputeResource("unread");
    await settle();
    v.h.runtime.recomputeResource("unread");
    await settle();
    expect(v.reports).toEqual(["route drift for unread"]);
    const entry = await debugOf(v.h, "unread");
    expect(entry.routeDrifted).toEqual(["stray"]);
    expect(entry.routeDriftSeeded).toEqual([]);
    // `stray` drifted: still routed FULL (kept for the process).
    change(v.h, "stray");
    await settle();
    expect(v.loads).toHaveLength(4);
  });

  test("a declared rollup or view read is covered, not drift", () => {
    const v = persistedValue();
    expect(
      v.h.runtime.seedRouteDrift([
        { key: "unread", tablesRead: ["notifications", "attempt_conv_agg"] },
      ]),
    ).toEqual([]);
    expect(v.reports).toEqual([]);
  });

  test("a routed plan's derived read (a rollup routed through its sources) is covered, not drift", () => {
    const h = createHarness();
    h.runtime.defineResource(
      {
        key: "win",
        schema: z.array(z.object({ id: z.string() })),
        keyed: { keyOf: (r) => (r as { id: string }).id },
        validateParams: () => {},
      },
      {
        routes: mintRoutePlan({
          routes: [
            {
              id: "hosts",
              table: "hosts",
              map: { kind: "identity" },
              columns: [],
            },
          ],
          usesOf: () => new Map(),
          derivedReads: [{ table: "hosts_agg", sources: ["hosts"] }],
        }),
        membership: { kind: "point", idsOf: () => [] },
        loader: () => [],
      },
    );
    expect(
      h.runtime.seedRouteDrift([
        { key: "win", tablesRead: ["hosts", "hosts_agg"] },
      ]),
    ).toEqual([]);
  });

  test("a FULL persist whose run captured no table records its declared reads, not an empty set", async () => {
    const v = persistedValue({
      readSet: () => ["stale_union_edge"],
      lastReadSet: () => undefined,
    });
    v.h.runtime.recomputeResource("unread");
    await settle();
    expect(v.persists.map((m) => m.guardTables)).toEqual([
      ["attempt_conv_agg", "notifications"],
    ]);
  });
});
