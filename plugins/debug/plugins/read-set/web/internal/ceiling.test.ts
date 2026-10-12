import { describe, expect, test } from "bun:test";
import {
  resourceReadSetSchema,
  type ResourceReadSet,
} from "../../shared/schema";
import { computeCeiling } from "./ceiling";

// Every fixture goes through the pane's own schema, so a fixture the server
// could not have sent (a missing field, an unknown policy) fails here first.
function entry(
  over: Partial<ResourceReadSet> & Pick<ResourceReadSet, "key" | "policy">,
): ResourceReadSet {
  return resourceReadSetSchema.parse({
    readSet: [],
    legacyReach: [],
    routes: null,
    routeDrifted: [],
    tuples: 0,
    persisted: false,
    positionAgeMs: null,
    notifyStats: { hand: 0, feed: 0, producer: 0 },
    freshness: null,
    ...over,
  });
}

describe("computeCeiling", () => {
  test("a routed entry lists each full route with its reason, and none of its other routes", () => {
    const c = computeCeiling([
      entry({
        key: "tasks",
        policy: "routed",
        routes: [
          { id: "base", table: "tasks", map: "identity" },
          {
            id: "categories",
            table: "task_categories",
            map: "full",
            reason: "a category rename moves every row",
          },
          { id: "deps", table: "task_dependencies", map: "reverse" },
        ],
      }),
    ]);
    expect(c.routedFull).toEqual([
      {
        key: "tasks",
        route: "categories",
        table: "task_categories",
        reason: "a category rename moves every row",
      },
    ]);
    expect(c.legacyFull).toEqual([]);
    expect(c.drift).toEqual([]);
    expect(c.keys).toEqual({
      routed: ["tasks"],
      "legacy-full": [],
      external: [],
      unbound: [],
    });
  });

  test("routed drift comes from routeDrifted (raw-table space), never from the read-set", () => {
    const c = computeCeiling([
      entry({
        key: "drifting",
        policy: "routed",
        routes: [{ id: "base", table: "tasks", map: "identity" }],
        readSet: ["tasks_v", "notes"],
        routeDrifted: ["notes"],
      }),
      entry({
        key: "clean",
        policy: "routed",
        routes: [{ id: "base", table: "tasks", map: "identity" }],
        // A view whose rollup sources the plan reaches as derived reads.
        readSet: ["tasks_v"],
      }),
    ]);
    expect(c.drift).toEqual([{ key: "drifting", tables: ["notes"] }]);
  });

  test("a legacy-full entry carries its transitive bases, tuples, persistence and cost", () => {
    const c = computeCeiling([
      entry({
        key: "attempt-work",
        policy: "legacy-full",
        readSet: ["attempts_v", "pushes"],
        legacyReach: ["pushes", "conversations", "attempts"],
        tuples: 3,
      }),
      entry({
        key: "agents",
        policy: "legacy-full",
        readSet: ["agents_v"],
        legacyReach: ["agents"],
        tuples: 1,
        persisted: true,
        positionAgeMs: 1200,
      }),
    ]);
    expect(c.legacyFull).toEqual([
      {
        key: "agents",
        policy: "legacy-full",
        bases: ["agents"],
        tuples: 1,
        persisted: true,
        positionAgeMs: 1200,
        loadsPerWrite: 1,
      },
      {
        key: "attempt-work",
        policy: "legacy-full",
        bases: ["attempts", "conversations", "pushes"],
        tuples: 3,
        persisted: false,
        positionAgeMs: null,
        loadsPerWrite: 3,
      },
    ]);
    expect(c.keys["legacy-full"]).toEqual(["agents", "attempt-work"]);
  });

  test("a persisted entry with no subscriber still costs one FULL load per base write; an unpersisted one none", () => {
    const c = computeCeiling([
      entry({
        key: "kept",
        policy: "legacy-full",
        legacyReach: ["agents"],
        persisted: true,
      }),
      entry({ key: "idle", policy: "legacy-full", legacyReach: ["agents"] }),
    ]);
    expect(
      Object.fromEntries(c.legacyFull.map((e) => [e.key, e.loadsPerWrite])),
    ).toEqual({ idle: 0, kept: 1 });
  });

  test("a legacy-full entry whose loader never ran is still listed, with empty bases", () => {
    const c = computeCeiling([entry({ key: "pages", policy: "legacy-full" })]);
    expect(c.legacyFull).toEqual([
      {
        key: "pages",
        policy: "legacy-full",
        bases: [],
        tuples: 0,
        persisted: false,
        positionAgeMs: null,
        loadsPerWrite: 0,
      },
    ]);
  });

  test("an external entry the legacy router reaches is in the ceiling with its bases, tagged external", () => {
    const c = computeCeiling([
      entry({
        key: "edited-files",
        policy: "external",
        readSet: ["conversations_v"],
        legacyReach: ["tasks", "conversations", "attempts"],
        tuples: 2,
      }),
      entry({
        key: "automations.catalog",
        policy: "external",
        readSet: ["tasks_v"],
        legacyReach: ["attempts", "tasks"],
      }),
    ]);
    expect(c.legacyFull.map((e) => [e.key, e.policy, e.bases])).toEqual([
      ["automations.catalog", "external", ["attempts", "tasks"]],
      ["edited-files", "external", ["attempts", "conversations", "tasks"]],
    ]);
    // Not "reached only by its own notify()": absent from the pure list.
    expect(c.pureExternal).toEqual([]);
    expect(c.keys.external).toEqual(["automations.catalog", "edited-files"]);
  });

  test("an external entry with no legacy reach is pure external, outside the ceiling", () => {
    const c = computeCeiling([
      entry({ key: "git.status", policy: "external" }),
    ]);
    expect(c.pureExternal).toEqual(["git.status"]);
    expect(c.legacyFull).toEqual([]);
    expect(c.routedFull).toEqual([]);
  });

  test("an unbound entry is listed under its policy, and in the ceiling only when the router reaches it", () => {
    const c = computeCeiling([
      entry({ key: "b.deferred", policy: "unbound" }),
      entry({ key: "a.deferred", policy: "unbound", legacyReach: ["notes"] }),
    ]);
    expect(c.keys.unbound).toEqual(["a.deferred", "b.deferred"]);
    expect(c.legacyFull.map((e) => [e.key, e.policy])).toEqual([
      ["a.deferred", "unbound"],
    ]);
    expect(c.pureExternal).toEqual([]);
  });

  test("every entry is keyed under exactly one policy", () => {
    const resources = [
      entry({ key: "r", policy: "routed", routes: [] }),
      entry({ key: "l", policy: "legacy-full" }),
      entry({ key: "e", policy: "external" }),
      entry({ key: "u", policy: "unbound" }),
    ];
    const c = computeCeiling(resources);
    expect(Object.values(c.keys).flat().sort()).toEqual(["e", "l", "r", "u"]);
  });

  test("the schema refuses a policy outside the closed set", () => {
    expect(() =>
      entry({
        key: "x",
        policy: "scoped" as unknown as ResourceReadSet["policy"],
      }),
    ).toThrow();
  });
});
