/**
 * A6 (`./produced-guard`): no L2-persisted reader of a produced table. The boot
 * assertion and the runtime refusal are pure; the stale-row sweep runs its SQL
 * against a throwaway database. Run with
 * `./equin test plugins/database/plugins/live-state-snapshot`.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { LIVE_STATE_SNAPSHOT_TABLE } from "@plugins/database/plugins/derived-views/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { ensureSnapshotTable } from "./tables-ddl";
import { persistSnapshot } from "./persist";
import {
  assertNoPersistedProducedReader,
  createProducedPersistGuard,
  findPersistedProducedReaders,
  sweepProducedSnapshots,
} from "./produced-guard";

const PRODUCED = new Set(["reports"]);
const SCOPED = [
  { key: "reports.list", table: "reports", via: 'route "reports"' },
  { key: "tasks", table: "tasks", via: 'route "t"' },
  { key: "tasks", table: "reports", via: 'route "r"' },
];

// Relation bases (D28): a view over the produced table, a rollup fed by it,
// and a view over the rollup; every other relation is its own base.
const GRAPH: Record<string, string[]> = {
  reports_v: ["reports", "tasks"],
  report_counts: ["reports"],
  report_counts_v: ["reports"],
};
const relationBases = (r: string): readonly string[] => GRAPH[r] ?? [r];

describe("A6 boot assertion", () => {
  test("a persisted key that routes a produced table is a violation; an unpersisted one is not", () => {
    expect(findPersistedProducedReaders(["tasks"], SCOPED, PRODUCED)).toEqual([
      { key: "tasks", table: "reports", via: 'route "r"' },
    ]);
    expect(findPersistedProducedReaders(["other"], SCOPED, PRODUCED)).toEqual(
      [],
    );
    expect(() =>
      assertNoPersistedProducedReader(["tasks"], SCOPED, PRODUCED),
    ).toThrow('tasks  →  route "r" "reports"');
    expect(() =>
      assertNoPersistedProducedReader(["tasks"], SCOPED, new Set()),
    ).not.toThrow();
  });
});

describe("A6 runtime refusal", () => {
  test("a read-set naming a produced table is refused, the key stays refused, and it is reported once", async () => {
    const refused: Array<[string, readonly string[]]> = [];
    const guard = createProducedPersistGuard({
      produced: PRODUCED,
      relationBases,
      onRefused: async (key, tables) => {
        refused.push([key, tables]);
      },
    });
    expect(await guard.refuses("tasks", ["tasks", "attempts"])).toBe(false);
    expect(await guard.refuses("tasks", ["tasks"])).toBe(false);
    expect(await guard.refuses("k", ["tasks", "reports"])).toBe(true);
    expect(await guard.refuses("k", ["reports"])).toBe(true);
    // A later read-set that misses the produced table does not resume writes.
    expect(await guard.refuses("k", ["tasks"])).toBe(true);
    expect(refused).toEqual([["k", ["reports"]]]);
  });

  test("a read-set reaching a produced table through a view or a rollup is refused, naming the base", async () => {
    const refused: Array<[string, readonly string[]]> = [];
    const guard = createProducedPersistGuard({
      produced: PRODUCED,
      relationBases,
      onRefused: async (key, tables) => {
        refused.push([key, tables]);
      },
    });
    expect(await guard.refuses("view", ["reports_v"])).toBe(true);
    expect(await guard.refuses("rollup", ["tasks", "report_counts"])).toBe(
      true,
    );
    expect(await guard.refuses("both", ["report_counts_v", "reports"])).toBe(
      true,
    );
    expect(await guard.refuses("clean", ["tasks", "tasks_v"])).toBe(false);
    expect(refused).toEqual([
      ["view", ["reports"]],
      ["rollup", ["reports"]],
      ["both", ["reports"]],
    ]);
  });
});

describe("A6 stale rows (real DB)", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb({ prefix: "lss_produced" });
    await ensureSnapshotTable(t.db);
  });

  afterAll(async () => {
    await t.drop();
  });

  beforeEach(async () => {
    await t.db.execute(sql.raw(`DELETE FROM ${LIVE_STATE_SNAPSHOT_TABLE}`));
    for (const [key, tables] of [
      ["over-reports", ["reports", "tasks"]],
      ["over-tasks", ["tasks"]],
      ["over-view", ["reports_v"]],
      ["over-rollup", ["report_counts"]],
    ] as const) {
      await persistSnapshot(t.db, key, "{}", { v: key }, "1", {
        mode: "replace",
        definition: null,
        guardTables: tables,
      });
    }
  });

  async function keys(): Promise<string[]> {
    const res = await t.db.execute<{ resource_key: string }>(
      sql.raw(
        `SELECT resource_key FROM ${LIVE_STATE_SNAPSHOT_TABLE} ORDER BY resource_key`,
      ),
    );
    return res.rows.map((r) => r.resource_key);
  }

  test("the sweep deletes exactly the rows whose read-set reaches a produced table — directly, through a view or through a rollup", async () => {
    expect(await sweepProducedSnapshots(t.db, PRODUCED, relationBases)).toEqual(
      [
        {
          resource_key: "over-reports",
          params_key: "{}",
          tables_read: ["reports", "tasks"],
          produced: ["reports"],
        },
        {
          resource_key: "over-rollup",
          params_key: "{}",
          tables_read: ["report_counts"],
          produced: ["reports"],
        },
        {
          resource_key: "over-view",
          params_key: "{}",
          tables_read: ["reports_v"],
          produced: ["reports"],
        },
      ],
    );
    expect(await keys()).toEqual(["over-tasks"]);
  });

  test("the sweep deletes per row: a key's row whose own read-set reaches no produced table survives", async () => {
    await t.db.execute(sql.raw(`DELETE FROM ${LIVE_STATE_SNAPSHOT_TABLE}`));
    for (const [pk, tables] of [
      ['{"a":1}', ["reports"]],
      ['{"a":2}', ["tasks"]],
    ] as const) {
      await persistSnapshot(t.db, "split", pk, { v: pk }, "1", {
        mode: "replace",
        definition: null,
        guardTables: tables,
      });
    }
    expect(await sweepProducedSnapshots(t.db, PRODUCED, relationBases)).toEqual(
      [
        {
          resource_key: "split",
          params_key: '{"a":1}',
          tables_read: ["reports"],
          produced: ["reports"],
        },
      ],
    );
    const left = await t.db.execute<{ params_key: string }>(
      sql.raw(`SELECT params_key FROM ${LIVE_STATE_SNAPSHOT_TABLE}`),
    );
    expect(left.rows.map((r) => r.params_key)).toEqual(['{"a":2}']);
  });

  test("no produced table: no query, nothing deleted", async () => {
    expect(
      await sweepProducedSnapshots(t.db, new Set(), relationBases),
    ).toEqual([]);
    expect(await keys()).toEqual([
      "over-reports",
      "over-rollup",
      "over-tasks",
      "over-view",
    ]);
  });
});
