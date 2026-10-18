import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { sql } from "drizzle-orm";
import { LIVE_STATE_SNAPSHOT_TABLE } from "@plugins/database/plugins/derived-views/core";
import { ensureSnapshotTable } from "./tables-ddl";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import {
  captureWatermark,
  compactTargets,
  persistSnapshot,
  readPersistedReadSets,
  readPersistedSnapshots,
  clearPersistedSnapshots,
  sweepUnusableSnapshots,
  type L2Expectation,
} from "./persist";

// Real-DB invariant suite for the L2 persist SQL: xid8 watermark monotonicity,
// the ON CONFLICT upsert, the text[] `tables_read` round-trip (incl. the empty
// `ARRAY[]::text[]` path), jsonb value round-trip, and the `params_key='{}'`
// filtering of the read helpers. Runs the real SQL against a throwaway database on
// the running cluster (see the db-test-fixture primitive).

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "lss_test" });
  await ensureSnapshotTable(t.db);
});

afterAll(async () => {
  await t.drop();
});

// Independent tests — clear the snapshot table between each.
beforeEach(async () => {
  await t.db.execute(sql.raw(`DELETE FROM ${LIVE_STATE_SNAPSHOT_TABLE}`));
});

// A REPLACE persist (a FULL recompute's) — the shape most cases need.
function replace(
  key: string,
  paramsKey: string,
  value: unknown,
  position: string,
  tables: readonly string[],
  definition: string | null = null,
): Promise<void> {
  return persistSnapshot(t.db, key, paramsKey, value, position, {
    mode: "replace",
    definition,
    guardTables: tables,
  });
}

// A FLOOR persist (a persisted alias's trailing window).
function floor(
  key: string,
  value: unknown,
  position: string,
  guardTables: readonly string[],
  definition: string | null = null,
): Promise<void> {
  return persistSnapshot(t.db, key, "{}", value, position, {
    mode: "floor",
    definition,
    guardTables,
  });
}

// The usable-row expectation: these keys persisted, these definitions.
function exp(
  persisted: readonly string[],
  definitions: Record<string, string> = {},
): L2Expectation {
  return { persisted, definitions };
}

// The upsert an OLDER backend runs during a hot swap (pre-definition shape): it
// moves `persisted_at` and never touches `definition` / `definition_at`.
async function oldShapeUpsert(
  key: string,
  value: unknown,
  position: string,
): Promise<void> {
  await t.db.execute(sql`
    INSERT INTO ${sql.raw(LIVE_STATE_SNAPSHOT_TABLE)}
      (resource_key, params_key, value, position, tables_read, persisted_at)
    VALUES (${key}, '{}', ${JSON.stringify(value)}::jsonb, ${position}::numeric,
            ARRAY['t']::text[], clock_timestamp())
    ON CONFLICT (resource_key, params_key) DO UPDATE
      SET value = EXCLUDED.value,
          position = EXCLUDED.position,
          tables_read = EXCLUDED.tables_read,
          persisted_at = EXCLUDED.persisted_at
  `);
}

async function countRows(): Promise<number> {
  const res = await t.db.execute<{ n: number }>(
    sql.raw(`SELECT count(*)::int AS n FROM ${LIVE_STATE_SNAPSHOT_TABLE}`),
  );
  return res.rows[0]?.n ?? 0;
}

// A type alias (not an interface): `execute<T>` needs a Record-compatible row.
type Row = {
  value: unknown;
  position: string;
  tables_read: string[];
  definition: string | null;
  has_position_at: boolean;
  stamped: boolean;
};

async function selectRow(
  key: string,
  paramsKey: string,
): Promise<Row | undefined> {
  const res = await t.db.execute<Row>(
    sql`
      SELECT value, position::text AS position, tables_read, definition,
             position_at IS NOT NULL AS has_position_at,
             definition_at IS NOT DISTINCT FROM persisted_at AS stamped
      FROM ${sql.raw(LIVE_STATE_SNAPSHOT_TABLE)}
      WHERE resource_key = ${key} AND params_key = ${paramsKey}
    `,
  );
  return res.rows[0];
}

describe("captureWatermark", () => {
  test("returns a non-empty numeric string", async () => {
    const wm = await captureWatermark(t.db);
    expect(typeof wm).toBe("string");
    expect(wm.length).toBeGreaterThan(0);
    // Parseable as a non-negative BigInt (xid8 stored as numeric).
    expect(BigInt(wm) >= 0n).toBe(true);
  });

  test("is monotonic non-decreasing across a committed write", async () => {
    const first = await captureWatermark(t.db);
    // Force xid advancement with a real committed write between captures.
    await replace("wm-probe", "{}", { n: 1 }, "1", ["t"]);
    await t.db.execute(
      sql`UPDATE ${sql.raw(LIVE_STATE_SNAPSHOT_TABLE)} SET persisted_at = now() WHERE resource_key = ${"wm-probe"}`,
    );
    const second = await captureWatermark(t.db);
    expect(BigInt(second) >= BigInt(first)).toBe(true);
  });
});

describe("persistSnapshot — replace", () => {
  test("inserts a row that reads back, stamped (definition_at = persisted_at) with position_at set", async () => {
    await replace("k1", "{}", { hello: "world" }, "42", ["ta", "tb"], "def-1");
    const row = await selectRow("k1", "{}");
    expect(row).toBeDefined();
    expect(row!.value).toEqual({ hello: "world" });
    expect(row!.position).toBe("42");
    expect(row!.tables_read).toEqual(["ta", "tb"]);
    expect(row!.definition).toBe("def-1");
    expect(row!.has_position_at).toBe(true);
    expect(row!.stamped).toBe(true);
  });

  test("second call on same (resource_key, params_key) UPDATES in place — position may rise", async () => {
    await replace("k1", "{}", { v: 1 }, "10", ["ta"]);
    await replace("k1", "{}", { v: 2 }, "20", ["tb", "tc"]);
    expect(await countRows()).toBe(1);
    const row = await selectRow("k1", "{}");
    expect(row!.value).toEqual({ v: 2 });
    expect(row!.position).toBe("20");
    expect(row!.tables_read).toEqual(["tb", "tc"]);
  });

  test("tables_read round-trips: multi-element and empty array", async () => {
    await replace("multi", "{}", {}, "1", ["a", "b", "c"]);
    expect((await selectRow("multi", "{}"))!.tables_read).toEqual([
      "a",
      "b",
      "c",
    ]);

    // The `ARRAY[]::text[]` path — an empty array must persist and read back [].
    await replace("empty", "{}", {}, "1", []);
    expect((await selectRow("empty", "{}"))!.tables_read).toEqual([]);
  });

  test("value jsonb round-trips nested object and array", async () => {
    const nested = { a: { b: [1, 2, { c: "d" }] }, e: null };
    await replace("obj", "{}", nested, "1", []);
    expect((await selectRow("obj", "{}"))!.value).toEqual(nested);

    const arr = [1, "two", { three: 3 }, [4]];
    await replace("arr", "{}", arr, "1", []);
    expect((await selectRow("arr", "{}"))!.value).toEqual(arr);
  });
});

describe("persistSnapshot — floor", () => {
  test("on an existing row: writes the value, LOWERS the position, keeps position_at and tables_read", async () => {
    await replace("al", "{}", [1], "50", ["ta"], "d");
    await floor("al", [1, 2], "40", ["route_t"], "d");
    let row = await selectRow("al", "{}");
    expect(row!.value).toEqual([1, 2]);
    expect(row!.position).toBe("40"); // LEAST(50, 40)
    expect(row!.tables_read).toEqual(["ta"]); // kept — never the guard tables
    expect(row!.has_position_at).toBe(true); // kept from the replace
    expect(row!.stamped).toBe(true);
    // A higher floor never raises it.
    await floor("al", [1, 2, 3], "90", ["route_t"], "d");
    row = await selectRow("al", "{}");
    expect(row!.value).toEqual([1, 2, 3]);
    expect(row!.position).toBe("40");
  });

  test("on a missing row: inserts the floor, the guard tables and a NULL position_at", async () => {
    await floor("fresh", [9], "77", ["r1", "r2"], "d");
    const row = await selectRow("fresh", "{}");
    expect(row!.value).toEqual([9]);
    expect(row!.position).toBe("77");
    expect(row!.tables_read).toEqual(["r1", "r2"]);
    expect(row!.has_position_at).toBe(false);
    expect(row!.definition).toBe("d");
    expect(row!.stamped).toBe(true);
  });

  test("over another definition's row: takes the guard tables and a NULL position_at, keeps LEAST", async () => {
    // A hot swap: a backend with a different definition replaced the row.
    await replace("al", "{}", [1], "50", ["foreign_t"], "other-def");
    await floor("al", [1, 2], "60", ["route_t"], "d");
    const row = await selectRow("al", "{}");
    expect(row!.value).toEqual([1, 2]);
    expect(row!.position).toBe("50"); // LEAST(50, 60) — never raised
    expect(row!.tables_read).toEqual(["route_t"]); // not the foreign read-set
    expect(row!.has_position_at).toBe(false); // the compact job replaces it
    expect(row!.definition).toBe("d");
    expect(row!.stamped).toBe(true);
    const e = exp(["al"], { al: "d" });
    expect(await compactTargets(t.db, e)).toEqual(["al"]);
  });

  test("over an older writer's upsert (C22): takes the guard tables and a NULL position_at", async () => {
    await replace("al", "{}", [1], "10", ["ta"], "d");
    await oldShapeUpsert("al", [999], "30"); // tables_read ['t'], definition_at stale
    await floor("al", [1, 2], "20", ["route_t"], "d");
    const row = await selectRow("al", "{}");
    expect(row!.position).toBe("20"); // LEAST(30, 20)
    expect(row!.tables_read).toEqual(["route_t"]);
    expect(row!.has_position_at).toBe(false);
    expect(row!.stamped).toBe(true);
    const e = exp(["al"], { al: "d" });
    expect((await readPersistedReadSets(t.db, e)).get("al")).toEqual([
      "route_t",
    ]);
    expect(await compactTargets(t.db, e)).toEqual(["al"]);
  });
});

describe("the usable-row predicate (A18 / C22 / C23)", () => {
  test("readPersistedReadSets: only {} rows of persisted keys under the expected definition", async () => {
    await replace("a", "{}", {}, "1", ["ta", "tb"]);
    await replace("b", "{}", {}, "1", []);
    // A non-{} params_key row must be EXCLUDED.
    await replace("c", '{"x":1}', {}, "1", ["tc"]);
    // A key the runtime does not persist (e.g. a bounded preloaded window).
    await replace("bounded", "{}", {}, "1", ["tw"]);
    // A row another definition wrote.
    await replace("d", "{}", {}, "1", ["td"], "old-def");

    const map = await readPersistedReadSets(
      t.db,
      exp(["a", "b", "c", "d"], { d: "new-def" }),
    );
    expect(map.get("a")).toEqual(["ta", "tb"]);
    expect(map.get("b")).toEqual([]);
    expect(map.has("c")).toBe(false);
    expect(map.has("bounded")).toBe(false);
    expect(map.has("d")).toBe(false);
    expect(map.size).toBe(2);
  });

  test("a definition-less key expects NULL: a row carrying a definition is unusable for it", async () => {
    await replace("k", "{}", {}, "1", ["t"], "some-def");
    expect((await readPersistedReadSets(t.db, exp(["k"]))).has("k")).toBe(
      false,
    );
    expect(
      (await readPersistedReadSets(t.db, exp(["k"], { k: "some-def" }))).has(
        "k",
      ),
    ).toBe(true);
  });

  test("C22 hot swap: an old-shape upsert AFTER a new-shape one invalidates the row", async () => {
    await replace("k", "{}", [1], "10", ["t"], "def");
    const e = exp(["k"], { k: "def" });
    expect((await readPersistedSnapshots(t.db, ["k"], e)).has("k")).toBe(true);
    // An older backend (no `definition_at` in its upsert) writes over it: its
    // value carries the new definition stamp no longer — so it is not served.
    await oldShapeUpsert("k", [999], "11");
    expect((await readPersistedSnapshots(t.db, ["k"], e)).has("k")).toBe(false);
    expect((await readPersistedReadSets(t.db, e)).has("k")).toBe(false);
    // A fresh new-shape write restores it.
    await replace("k", "{}", [2], "12", ["t"], "def");
    expect(
      (await readPersistedSnapshots(t.db, ["k"], e)).get("k")!.value,
    ).toEqual([2]);
  });

  test("a pre-existing row (no definition_at) is unusable until rewritten", async () => {
    await oldShapeUpsert("legacy", [1], "5");
    expect(
      (await readPersistedSnapshots(t.db, ["legacy"], exp(["legacy"]))).size,
    ).toBe(0);
  });
});

describe("readPersistedSnapshots", () => {
  test("empty keys → empty Map, no query", async () => {
    const map = await readPersistedSnapshots(t.db, [], exp(["a"]));
    expect(map.size).toBe(0);
  });

  test("filters by key; only usable {} rows; returns value, position and position_at", async () => {
    await replace("a", "{}", { v: "a" }, "123", []);
    await replace("b", "{}", { v: "b" }, "1", []);
    // Non-{} params_key must not be returned even if its key is requested.
    await replace("c", '{"p":1}', { v: "c" }, "1", []);
    await floor("f", { v: "f" }, "7", ["t"]);

    const e = exp(["a", "b", "c", "f"]);
    const map = await readPersistedSnapshots(
      t.db,
      ["a", "c", "f", "missing"],
      e,
    );
    expect(map.get("a")!.value).toEqual({ v: "a" });
    expect(map.get("a")!.position).toBe("123");
    expect(typeof map.get("a")!.positionAt).toBe("number");
    expect(map.get("f")!.positionAt).toBeNull(); // only ever floor-written
    expect(map.has("c")).toBe(false); // non-{} excluded
    expect(map.has("missing")).toBe(false); // absent
    expect(map.has("b")).toBe(false); // not requested
    expect(map.size).toBe(2);
  });

  test("a bounded preloaded key is never served from L2, whatever row it left", async () => {
    await replace("window-key", "{}", { stale: true }, "1", ["t"]);
    const map = await readPersistedSnapshots(
      t.db,
      ["window-key"],
      exp(["other"]),
    );
    expect(map.size).toBe(0);
  });
});

describe("compactTargets", () => {
  test("persisted keys without a usable row replaced in the last hour", async () => {
    await replace("fresh", "{}", {}, "1", ["t"]);
    await replace("stale", "{}", {}, "1", ["t"]);
    await t.db.execute(
      sql`UPDATE ${sql.raw(LIVE_STATE_SNAPSHOT_TABLE)} SET position_at = now() - interval '2 hours' WHERE resource_key = 'stale'`,
    );
    await floor("floor-only", [], "1", ["t"]); // NULL position_at
    await replace("other-def", "{}", {}, "1", ["t"], "old"); // unusable
    const targets = await compactTargets(
      t.db,
      exp(["fresh", "stale", "floor-only", "other-def", "missing"], {
        "other-def": "new",
      }),
    );
    expect(targets.sort()).toEqual(
      ["floor-only", "missing", "other-def", "stale"].sort(),
    );
  });

  test("no persisted key → no target, no query", async () => {
    expect(await compactTargets(t.db, exp([]))).toEqual([]);
  });
});

describe("clearPersistedSnapshots", () => {
  test("deletes only listed {} keys, returns exact count, leaves others intact", async () => {
    await replace("a", "{}", {}, "1", []);
    await replace("b", "{}", {}, "1", []);
    await replace("keep", "{}", {}, "1", []);
    // A non-{} row for a listed key must NOT be deleted (scoped to '{}').
    await replace("a", '{"p":1}', {}, "1", []);

    const deleted = await clearPersistedSnapshots(t.db, ["a", "b", "missing"]);
    expect(deleted).toBe(2); // 'a' {} and 'b' {} — 'missing' matches nothing

    expect(await selectRow("a", "{}")).toBeUndefined();
    expect(await selectRow("b", "{}")).toBeUndefined();
    expect(await selectRow("keep", "{}")).toBeDefined(); // unlisted {} intact
    expect(await selectRow("a", '{"p":1}')).toBeDefined(); // non-{} intact
  });

  test("empty keys → returns 0, no delete", async () => {
    await replace("a", "{}", {}, "1", []);
    const deleted = await clearPersistedSnapshots(t.db, []);
    expect(deleted).toBe(0);
    expect(await countRows()).toBe(1);
  });
});

describe("sweepUnusableSnapshots (boot sweep)", () => {
  test("deletes every unusable row (ANY params_key), keeps the usable ones", async () => {
    // `pushes` — preload dropped: a stale '{}' row from the prior boot must go.
    await replace("pushes", "{}", {}, "1", []);
    // Belt-and-suspenders: a leftover non-'{}' row for a swept key must go too.
    await replace("pushes", '{"limit":"100"}', {}, "1", []);
    // `conversation-categories` — migrated to a point resource (never persisted).
    await replace("conversation-categories", "{}", {}, "1", []);
    // A key that no longer exists at all — swept as harmless cleanup.
    await replace("removed-resource", "{}", {}, "1", []);
    // A persisted key whose row another definition wrote.
    await replace("redefined", "{}", {}, "1", [], "old");
    // A persisted key an older writer left (no definition_at).
    await oldShapeUpsert("old-writer", {}, "1");
    // Still-persistable resources (usable rows) must be left intact.
    await replace("attempts", "{}", {}, "1", []);
    await replace("tasks", "{}", {}, "1", [], "tasks-def");

    const deleted = await sweepUnusableSnapshots(
      t.db,
      exp(["attempts", "tasks", "redefined", "old-writer"], {
        tasks: "tasks-def",
        redefined: "new",
      }),
    );
    expect(deleted).toBe(6);

    expect(await selectRow("pushes", "{}")).toBeUndefined();
    expect(await selectRow("pushes", '{"limit":"100"}')).toBeUndefined();
    expect(await selectRow("conversation-categories", "{}")).toBeUndefined();
    expect(await selectRow("removed-resource", "{}")).toBeUndefined();
    expect(await selectRow("redefined", "{}")).toBeUndefined();
    expect(await selectRow("old-writer", "{}")).toBeUndefined();
    expect(await selectRow("attempts", "{}")).toBeDefined(); // usable, kept
    expect(await selectRow("tasks", "{}")).toBeDefined(); // usable, kept
  });

  test("empty persisted set → returns 0, no delete (never nuke everything)", async () => {
    await replace("a", "{}", {}, "1", []);
    const deleted = await sweepUnusableSnapshots(t.db, exp([]));
    expect(deleted).toBe(0);
    expect(await countRows()).toBe(1);
  });
});

describe("ensureSnapshotTable", () => {
  async function columns(): Promise<string[]> {
    const res = await t.db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = ${LIVE_STATE_SNAPSHOT_TABLE}
          ORDER BY column_name`,
    );
    return res.rows.map((r) => r.column_name);
  }

  test("adds the definition columns idempotently (no default on definition_at)", async () => {
    await ensureSnapshotTable(t.db);
    const cols = await columns();
    expect(cols).toContain("definition");
    expect(cols).toContain("definition_at");
    expect(cols).toContain("position_at");
  });

  test("renames a legacy updated_at to persisted_at, keeping rows, idempotently", async () => {
    await t.db.execute(
      sql.raw(
        `ALTER TABLE ${LIVE_STATE_SNAPSHOT_TABLE} RENAME COLUMN persisted_at TO updated_at`,
      ),
    );
    await t.db.execute(
      sql.raw(
        `INSERT INTO ${LIVE_STATE_SNAPSHOT_TABLE} (resource_key, params_key, value, position) VALUES ('legacy', '{}', '{}'::jsonb, 1)`,
      ),
    );
    await ensureSnapshotTable(t.db);
    await ensureSnapshotTable(t.db);
    const cols = await columns();
    expect(cols).toContain("persisted_at");
    expect(cols).not.toContain("updated_at");
    expect(await countRows()).toBe(1);
    // The upsert writes the renamed column.
    await replace("legacy", "{}", { n: 2 }, "2", []);
    expect(await countRows()).toBe(1);
  });
});
