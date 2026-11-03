import { describe, expect, test } from "bun:test";
import {
  assertRouteTablesCovered,
  assertUnfedTablesOptedOut,
  findUncoveredRouteTables,
  relationReadTables,
  formatUncoveredRouteError,
  type ScopedResourceTable,
  type RouteCoverageViolation,
} from "./route-coverage";

// One identity route per resource — the shape every case below uses unless it
// names its routes.
const scoped = (
  ...pairs: Array<[key: string, table: string]>
): ScopedResourceTable[] =>
  pairs.map(([key, table]) => ({ key, table, via: 'route "identity"' }));

// Convenience: the four-arg call with empty exclusion/exempt sets (so every
// violation classifies as "uncovered") unless a test overrides them.
const findUncovered = (
  resources: ScopedResourceTable[],
  covered: Iterable<string>,
  excluded: Iterable<string> = [],
  exempt: Iterable<string> = [],
): RouteCoverageViolation[] =>
  findUncoveredRouteTables(
    resources,
    new Set(covered),
    new Set(excluded),
    new Set(exempt),
  );

describe("findUncoveredRouteTables", () => {
  test("no scoped resources → no violation", () => {
    expect(findUncovered([], ["notifications"])).toEqual([]);
  });

  test("scoped resource on a triggered (covered) table → no violation", () => {
    const resources = scoped(["notifications", "notifications_table"]);
    expect(findUncovered(resources, ["notifications_table"])).toEqual([]);
  });

  test("every identity table covered → no violation for many resources", () => {
    const resources = scoped(["a", "tasks"], ["b", "attempts"]);
    expect(findUncovered(resources, ["tasks", "attempts"])).toEqual([]);
  });

  test("excluded table (uncovered) → flagged with reason 'excluded'", () => {
    const resources = scoped(["crash-log", "crash_log"]);
    expect(
      findUncovered(resources, /* covered */ [], /* excluded */ ["crash_log"]),
    ).toEqual([
      {
        key: "crash-log",
        table: "crash_log",
        via: 'route "identity"',
        reason: "excluded",
      },
    ]);
  });

  test("rollup table (uncovered, feed-exempt) → flagged with reason 'rollup'", () => {
    const resources = scoped(["r", "task_latest_conversation"]);
    expect(
      findUncovered(
        resources,
        [],
        [],
        /* exempt */ ["task_latest_conversation"],
      ),
    ).toEqual([
      {
        key: "r",
        table: "task_latest_conversation",
        via: 'route "identity"',
        reason: "rollup",
      },
    ]);
  });

  test("typo / view / dropped table (uncovered, unknown) → reason 'uncovered'", () => {
    const resources = scoped(["v", "tasks_view"]);
    // Covered set holds the real base table, not the view name the resource used.
    expect(findUncovered(resources, ["tasks"])).toEqual([
      {
        key: "v",
        table: "tasks_view",
        via: 'route "identity"',
        reason: "uncovered",
      },
    ]);
  });

  test("coverage is the sole membership test — a covered table is never flagged, even if also listed as excluded", () => {
    // Defensive: exclusion/exempt sets only classify; they never add a violation
    // for a table that DID get a trigger.
    const resources = scoped(["ok", "tasks"]);
    expect(findUncovered(resources, ["tasks"], ["tasks"], ["tasks"])).toEqual(
      [],
    );
  });

  test("mixed set → each uncovered resource classified, covered ones dropped", () => {
    const resources = scoped(
      ["good1", "browser_bookmarks"],
      ["bad-excluded", "reports"],
      ["good2", "story_generated_units"],
      ["bad-rollup", "task_latest_conversation"],
      ["bad-typo", "taskz"],
    );
    const covered = ["browser_bookmarks", "story_generated_units"];
    const excluded = ["reports", "slow_ops"];
    const exempt = ["task_latest_conversation"];
    expect(findUncovered(resources, covered, excluded, exempt)).toEqual([
      {
        key: "bad-excluded",
        table: "reports",
        via: 'route "identity"',
        reason: "excluded",
      },
      {
        key: "bad-rollup",
        table: "task_latest_conversation",
        via: 'route "identity"',
        reason: "rollup",
      },
      {
        key: "bad-typo",
        table: "taskz",
        via: 'route "identity"',
        reason: "uncovered",
      },
    ]);
  });

  test("two resources scoping to the SAME uncovered table → both flagged", () => {
    const resources = scoped(["r1", "reports"], ["r2", "reports"]);
    expect(findUncovered(resources, [], ["reports"])).toHaveLength(2);
  });
});

describe("routed resources — every route's table is checked, not only the identity", () => {
  // A routed entry is reached only through its routes, so an uncovered SIDE
  // table (an extension, a lookup) is as dead as an uncovered identity table.
  const routed = (
    key: string,
    ...routes: Array<[id: string, table: string]>
  ): ScopedResourceTable[] =>
    routes.map(([id, table]) => ({ key, table, via: `route "${id}"` }));

  test("every route table covered → no violation", () => {
    expect(
      findUncovered(
        routed("threads", ["base", "mail_threads"], ["acct", "mail_accounts"]),
        ["mail_threads", "mail_accounts"],
      ),
    ).toEqual([]);
  });

  test("an uncovered non-identity route table is flagged, naming the route", () => {
    expect(
      findUncovered(
        routed("songs", ["base", "songs"], ["playback", "songs_playback"]),
        ["songs"],
        ["songs_playback"],
      ),
    ).toEqual([
      {
        key: "songs",
        table: "songs_playback",
        via: 'route "playback"',
        reason: "excluded",
      },
    ]);
  });

  test("the error names the route that reads the uncovered table", () => {
    expect(() =>
      assertRouteTablesCovered(
        routed("songs", ["playback", "songs_playback_v"]),
        new Set(["songs_playback"]),
        new Set(),
        new Set(),
      ),
    ).toThrow(/songs\s+→\s+route "playback" "songs_playback_v"/);
  });
});

describe("assertRouteTablesCovered", () => {
  test("does not throw when every identity table is covered", () => {
    expect(() =>
      assertRouteTablesCovered(
        scoped(["ok", "browser_bookmarks"]),
        new Set(["browser_bookmarks"]),
        new Set(["reports"]),
        new Set(),
      ),
    ).not.toThrow();
  });

  test("throws when a scoped resource names an uncovered (excluded) table", () => {
    expect(() =>
      assertRouteTablesCovered(
        scoped(["bad", "reports"]),
        new Set(),
        new Set(["reports"]),
        new Set(),
      ),
    ).toThrow(/dead scope policy/i);
  });

  test("throws for a VIEW-name identity table even though nothing excluded it", () => {
    // The footgun the generalization is for: no exclusion, no exempt — just a
    // wrong string (a view name) that the exclusion-only check would have missed.
    expect(() =>
      assertRouteTablesCovered(
        scoped(["bad", "tasks_view"]),
        new Set(["tasks"]),
        new Set(),
        new Set(),
      ),
    ).toThrow(/dead scope policy/i);
  });

  test("excluded violation names the resource, table, and ExcludeFromChangeFeed fix", () => {
    let message = "";
    try {
      assertRouteTablesCovered(
        scoped(["reportsResource", "reports"]),
        new Set(),
        new Set(["reports"]),
        new Set(),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("reportsResource");
    expect(message).toContain("reports");
    expect(message).toContain("ExcludeFromChangeFeed");
    expect(message).toContain("hydrate-on-mount");
  });

  test("uncovered violation hints at the VIEW / typo remediation", () => {
    let message = "";
    try {
      assertRouteTablesCovered(
        scoped(["v", "tasks_view"]),
        new Set(["tasks"]),
        new Set(),
        new Set(),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("tasks_view");
    expect(message).toContain("VIEW");
  });
});

describe("formatUncoveredRouteError", () => {
  test("groups by reason, each with its own heading and fix", () => {
    const msg = formatUncoveredRouteError([
      {
        key: "exc",
        table: "reports",
        via: 'route "identity"',
        reason: "excluded",
      },
      {
        key: "roll",
        table: "task_latest_conversation",
        via: 'route "identity"',
        reason: "rollup",
      },
      {
        key: "typo",
        table: "taskz",
        via: 'route "identity"',
        reason: "uncovered",
      },
    ]);
    expect(msg).toContain("3 live-state resource table(s)");
    expect(msg).toContain("ExcludeFromChangeFeed");
    expect(msg).toContain("rollup");
    expect(msg).toContain("VIEW");
    // Section order is excluded → rollup → uncovered.
    expect(msg.indexOf("ExcludeFromChangeFeed")).toBeLessThan(
      msg.indexOf("rollup"),
    );
  });

  test("within a section, violations are listed one per line, sorted", () => {
    const msg = formatUncoveredRouteError([
      {
        key: "zResource",
        table: "slow_ops",
        via: 'route "identity"',
        reason: "excluded",
      },
      {
        key: "aResource",
        table: "reports",
        via: 'route "identity"',
        reason: "excluded",
      },
    ]);
    const aIdx = msg.indexOf("aResource");
    const zIdx = msg.indexOf("zResource");
    expect(aIdx).toBeGreaterThan(-1);
    expect(zIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(zIdx); // sorted → aResource before zResource
  });

  test("omits sections with no violations", () => {
    const msg = formatUncoveredRouteError([
      {
        key: "only",
        table: "taskz",
        via: 'route "identity"',
        reason: "uncovered",
      },
    ]);
    expect(msg).not.toContain("ExcludeFromChangeFeed");
    expect(msg).not.toContain("rollup");
    expect(msg).toContain("VIEW");
  });
});

describe("assertUnfedTablesOptedOut — tables read outside the feed by declaration", () => {
  test("an opted-out table passes", () => {
    expect(() =>
      assertUnfedTablesOptedOut(
        [{ key: "chord.catalog", table: "chord_sections" }],
        new Set(["chord_sections"]),
      ),
    ).not.toThrow();
  });

  test("a table the feed was not told to skip blocks boot, naming the resource", () => {
    expect(() =>
      assertUnfedTablesOptedOut(
        [{ key: "chord.catalog", table: "chord_index_state" }],
        new Set(["chord_sections"]),
      ),
    ).toThrow(/chord\.catalog: "chord_index_state"/);
  });
});

describe("relationReadTables — a relation read's bases are held to A1′", () => {
  const bases = (r: string): readonly string[] =>
    r === "tasks_v" ? ["attempts", "tasks"] : [r];

  test("each relation read expands to one row per base, naming the relation", () => {
    expect(
      relationReadTables(
        [{ key: "automations.catalog", relation: "tasks_v" }],
        bases,
      ),
    ).toEqual([
      {
        key: "automations.catalog",
        table: "attempts",
        via: 'relation "tasks_v"',
      },
      { key: "automations.catalog", table: "tasks", via: 'relation "tasks_v"' },
    ]);
  });

  test("a relation over a table the feed skips blocks boot", () => {
    expect(() =>
      assertRouteTablesCovered(
        relationReadTables(
          [{ key: "automations.catalog", relation: "tasks_v" }],
          bases,
        ),
        new Set(["tasks"]),
        new Set(["attempts"]),
        new Set(),
      ),
    ).toThrow(/automations\.catalog {2}→ {2}relation "tasks_v" "attempts"/);
  });
});
