import { describe, expect, test } from "bun:test";
import {
  resourceDebugSchema,
  type ResourceDebug,
} from "../../core/resources-debug";
import { computeCeiling } from "./ceiling";

// Every fixture goes through the pane's own schema, so a fixture the server
// could not have sent (a missing field, an unknown policy) fails here first.
function entry(
  over: Partial<ResourceDebug> & Pick<ResourceDebug, "key" | "policy">,
): ResourceDebug {
  return resourceDebugSchema.parse({
    mode: "push",
    subscribers: 0,
    subCounts: {},
    readSet: [],
    routes: null,
    relationReads: [],
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
        policy: "routed",
        route: "categories",
        table: "task_categories",
        reason: "a category rename moves every row",
      },
    ]);
    expect(c.drift).toEqual([]);
    expect(c.keys).toEqual({
      routed: ["tasks"],
      external: [],
      unrouted: [],
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
    expect(c.drift).toEqual([
      { key: "drifting", policy: "routed", tables: ["notes"] },
    ]);
  });

  test("an external entry's declared reads are listed as full routes and relation reads, tagged external — it is not pure external", () => {
    const c = computeCeiling([
      entry({
        key: "automations.catalog",
        policy: "external",
        freshness: { kind: "notified" },
        routes: [
          {
            id: "automation_launch_batches",
            table: "automation_launch_batches",
            map: "full",
            reason: "filters on the derived status",
          },
        ],
        relationReads: [
          {
            relation: "tasks_v",
            reason: "filters on the derived status",
            bases: ["tasks", "attempts"],
          },
        ],
      }),
    ]);
    expect(c.routedFull).toEqual([
      {
        key: "automations.catalog",
        policy: "external",
        route: "automation_launch_batches",
        table: "automation_launch_batches",
        reason: "filters on the derived status",
      },
    ]);
    expect(c.relationReads).toEqual([
      {
        key: "automations.catalog",
        policy: "external",
        relation: "tasks_v",
        bases: ["attempts", "tasks"],
        reason: "filters on the derived status",
      },
    ]);
    expect(c.pureExternal).toEqual([]);
    expect(c.keys.external).toEqual(["automations.catalog"]);
  });

  test("an external entry with only relation reads, or only drift (D5), is not pure external", () => {
    const c = computeCeiling([
      entry({
        key: "views-only",
        policy: "external",
        routes: [],
        relationReads: [{ relation: "tasks_v", reason: "r", bases: ["tasks"] }],
      }),
      entry({
        key: "drifted",
        policy: "external",
        // The drift-only record the guard gives an external with no plan.
        routes: [],
        routeDrifted: ["job_runs"],
      }),
    ]);
    expect(c.pureExternal).toEqual([]);
    expect(c.drift).toEqual([
      { key: "drifted", policy: "external", tables: ["job_runs"] },
    ]);
  });

  test("an external entry with no declared read and no drift is pure external, outside the ceiling", () => {
    const c = computeCeiling([
      entry({ key: "git.status", policy: "external" }),
      // Reads only tables outside the feed: a routing record with no route.
      entry({ key: "latency.summary", policy: "external", routes: [] }),
    ]);
    expect(c.pureExternal).toEqual(["git.status", "latency.summary"]);
    expect(c.routedFull).toEqual([]);
  });

  test("an unbound or unrouted entry is listed under its policy, outside the pure-external list", () => {
    const c = computeCeiling([
      entry({ key: "b.deferred", policy: "unbound" }),
      entry({ key: "a.deferred", policy: "unbound" }),
      entry({ key: "bare", policy: "unrouted" }),
    ]);
    expect(c.keys.unbound).toEqual(["a.deferred", "b.deferred"]);
    expect(c.keys.unrouted).toEqual(["bare"]);
    expect(c.pureExternal).toEqual([]);
  });

  test("every entry is keyed under exactly one policy", () => {
    const resources = [
      entry({ key: "r", policy: "routed", routes: [] }),
      entry({ key: "l", policy: "unrouted" }),
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
        policy: "scoped" as unknown as ResourceDebug["policy"],
      }),
    ).toThrow();
  });
});
