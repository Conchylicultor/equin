/**
 * A26 — the `_debug` payload's `policy` (A7, D40): every registry key appears,
 * each with exactly one policy from the closed set `routed | external |
 * unrouted | unbound`, and the ceiling fields the read-set pane reads
 * (`readSetBases`, `derivedReads`, `routeDrifted`, `tuples`, `persisted`,
 * `positionAgeMs`) are emitted for every entry — degrading to `[]` / `null`
 * on a central-shaped runtime that wires no read-set. Run with
 * `./singularity test plugins/framework/plugins/resource-runtime`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { mintRoutePlan } from "./routing";
import { createHarness, tick, type Harness } from "./test-support";
import { defineRoutedTable } from "./testing/routed-fixture";

const POLICIES = ["routed", "external", "unrouted", "unbound"] as const;

interface DebugEntry {
  key: string;
  policy: (typeof POLICIES)[number];
  readSet: string[];
  readSetBases: string[];
  routes: unknown[] | null;
  derivedReads: string[];
  routeDrifted: string[];
  tuples: number;
  persisted: boolean;
  positionAgeMs: number | null;
  externalSource: boolean;
}

async function debugOf(h: Harness): Promise<Map<string, DebugEntry>> {
  const res = await h.runtime.handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  const body = (await res.json()) as { resources: DebugEntry[] };
  return new Map(body.resources.map((r) => [r.key, r]));
}

const settle = async () => {
  await tick();
  await tick();
};

const rows = z.array(z.object({ id: z.string(), n: z.number() }));

/** A deferred keyed routed collection (the shape a `network/live` collection with contributed columns takes). */
function defineDeferredRouted(h: Harness, key: string): void {
  h.runtime.defineDeferredResource(
    {
      key,
      schema: rows,
      keyed: { keyOf: (r) => (r as { id: string }).id },
      validateParams: () => {},
    },
    () => ({
      routes: mintRoutePlan({
        routes: [
          {
            id: "base",
            table: "hosts",
            map: { kind: "identity" },
            columns: ["id", "n"],
          },
        ],
        usesOf: () => new Map([["base", { role: "membership" as const }]]),
      }),
      scopedMembership: {
        orderOf: async () => [],
        orderSignatureOf: () => "",
      },
      loader: () => [],
    }),
  );
}

describe("_debug policy (A26)", () => {
  test("every registry key appears once, each under a policy from the closed set", async () => {
    // Server-shaped: a captured read-set expanded through relation bases, the
    // per-run capture (so the A8 guard runs), and an L2 persist hook.
    const readSets: Record<string, string[]> = {
      agents: ["agents_v"],
      "edited-files": ["conversations_v"],
      "automations.catalog": ["tasks_v"],
      "deferred.value": ["notes"],
    };
    const bases: Record<string, string[]> = {
      agents_v: ["agents"],
      conversations_v: ["attempts", "conversations", "tasks"],
      tasks_v: ["attempts", "tasks"],
    };
    const h = createHarness({
      readSet: (key) => readSets[key] ?? [],
      relationBases: (r) => bases[r] ?? [r],
      // The routed `hosts` read `notes` too, which no route names: drift.
      lastReadSet: (key) => (key === "hosts" ? ["hosts", "notes"] : undefined),
      shouldPersist: (key) => key === "agents",
      captureWatermark: async () => "7",
      persistSnapshot: async () => {},
    });

    defineRoutedTable(h, {
      key: "hosts",
      table: "hosts",
      membership: "window",
      loader: () => [{ id: "a", n: 1 }],
    });
    h.runtime.defineExternalResource({
      key: "automations.catalog",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    h.runtime.defineResource({
      key: "agents",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    h.runtime.defineResource({
      key: "edited-files",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    defineDeferredRouted(h, "deferred.rows");
    h.runtime.defineDeferredResource(
      { key: "deferred.value", schema: z.number(), validateParams: () => {} },
      () => ({ mode: "push" as const, loader: () => 1 }),
    );

    const before = await debugOf(h);
    expect([...before.keys()].sort()).toEqual(
      [
        "agents",
        "automations.catalog",
        "deferred.rows",
        "deferred.value",
        "edited-files",
        "hosts",
      ].sort(),
    );
    for (const e of before.values()) expect(POLICIES).toContain(e.policy);
    const policyOf = (m: Map<string, DebugEntry>) =>
      Object.fromEntries([...m].map(([k, e]) => [k, e.policy]));
    expect(policyOf(before)).toEqual({
      hosts: "routed",
      "automations.catalog": "external",
      agents: "unrouted",
      "edited-files": "unrouted",
      "deferred.rows": "unbound",
      "deferred.value": "unbound",
    });

    // The displayed bases are the read-set expanded transitively.
    expect(before.get("agents")!.readSet).toEqual(["agents_v"]);
    expect(before.get("agents")!.readSetBases).toEqual(["agents"]);
    expect(before.get("edited-files")!.readSetBases).toEqual([
      "attempts",
      "conversations",
      "tasks",
    ]);
    // The external entry still shows what it read, under its own policy.
    expect(before.get("automations.catalog")!.readSetBases).toEqual([
      "attempts",
      "tasks",
    ]);
    expect(before.get("automations.catalog")!.externalSource).toBe(true);
    // Its read-set routes nothing: no declared reads, no routes.
    expect(before.get("automations.catalog")!.routes).toBeNull();

    // The dropped fields are gone.
    for (const e of before.values()) {
      expect(e).not.toHaveProperty("coveredOrigins");
      expect(e).not.toHaveProperty("identityTable");
      expect(e).not.toHaveProperty("recompute");
    }

    // After the bind, each deferred entry carries a real policy.
    h.runtime.bindDeferredResources();
    const after = await debugOf(h);
    expect(policyOf(after)).toEqual({
      ...policyOf(before),
      "deferred.rows": "routed",
      "deferred.value": "unrouted",
    });
    expect(after.get("deferred.value")!.readSetBases).toEqual(["notes"]);
    expect(after.get("deferred.rows")!.routes).toHaveLength(1);
  });

  test("tuples, persistence, position age and the A8 drift record", async () => {
    let persist = true;
    const h = createHarness({
      readSet: (key) => (key === "agents" ? ["agents_v"] : []),
      relationBases: (r) => (r === "agents_v" ? ["agents"] : [r]),
      lastReadSet: (key) => (key === "hosts" ? ["hosts", "notes"] : undefined),
      shouldPersist: (key) => persist && key === "agents",
      captureWatermark: async () => "7",
      persistSnapshot: async () => {},
    });
    defineRoutedTable(h, {
      key: "hosts",
      table: "hosts",
      membership: "window",
      loader: () => [{ id: "a", n: 1 }],
    });
    const agents = h.runtime.defineResource({
      key: "agents",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });

    const cold = await debugOf(h);
    expect(cold.get("agents")).toMatchObject({
      persisted: true,
      positionAgeMs: null,
      tuples: 0,
    });
    expect(cold.get("hosts")).toMatchObject({
      persisted: false,
      positionAgeMs: null,
      routeDrifted: [],
      derivedReads: [],
    });

    await h.subscribe("hosts", { limit: "10" });
    await h.subscribe("agents");
    // A FULL recompute replaces the persisted row, which moves its position.
    h.runtime.recomputeResource(agents.key);
    await settle();

    const warm = await debugOf(h);
    expect(warm.get("agents")!.tuples).toBe(1);
    const age = warm.get("agents")!.positionAgeMs;
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(warm.get("hosts")!.tuples).toBe(1);
    // A position is known, but once the entry stops persisting the age is
    // not reported (it would describe a row nothing keeps current).
    persist = false;
    expect((await debugOf(h)).get("agents")).toMatchObject({
      persisted: false,
      positionAgeMs: null,
    });
    // The routed entry's loader read `notes`, which no route names.
    expect(warm.get("hosts")!.routeDrifted).toEqual(["notes"]);
  });

  test("a routed entry's derived reads are its plan's", async () => {
    const h = createHarness();
    defineRoutedTable(h, {
      key: "tasks",
      table: "tasks",
      membership: "alias",
      loader: () => [],
      plan: mintRoutePlan({
        routes: [
          {
            id: "base",
            table: "tasks",
            map: { kind: "identity" },
            columns: ["id", "n"],
          },
        ],
        usesOf: () => new Map([["base", { role: "membership" as const }]]),
        derivedReads: [{ table: "task_rollup", sources: ["tasks"] }],
      }),
    });
    expect((await debugOf(h)).get("tasks")!.derivedReads).toEqual([
      "task_rollup",
    ]);
  });

  test("a central-shaped runtime (no read-set, no bases, no L2) degrades every field to [] / null", async () => {
    const h = createHarness();
    defineRoutedTable(h, {
      key: "rows",
      table: "rows",
      membership: "alias",
      loader: () => [],
    });
    h.runtime.defineExternalResource({
      key: "ext",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    h.runtime.defineResource({
      key: "plain",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    await h.subscribe("plain");
    const d = await debugOf(h);
    expect(d.get("rows")!.policy).toBe("routed");
    expect(d.get("ext")!.policy).toBe("external");
    expect(d.get("plain")!.policy).toBe("unrouted");
    for (const e of d.values()) {
      expect(e.readSet).toEqual([]);
      expect(e.readSetBases).toEqual([]);
      expect(e.routeDrifted).toEqual([]);
      expect(e.persisted).toBe(false);
      expect(e.positionAgeMs).toBeNull();
    }
    expect(d.get("plain")!.tuples).toBe(1);
  });
});
