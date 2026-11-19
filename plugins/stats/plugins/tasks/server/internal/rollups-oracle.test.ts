/**
 * The task-history rollups (`./rollups.ts`), run against a throwaway database
 * whose `tasks` and `task_attempt_facts` carry just the columns they read: at
 * every step `task_history_days` must equal the history recomputed from
 * scratch by the rule the card used to aggregate off `tasks_v` (created day;
 * done at its first push unless held; dropped at `dropped_at` unless an agent
 * is active; held at `held_at`, counted as dropped) — so a write that moves a
 * task between days, resolves, un-resolves or deletes it re-aggregates both
 * the day it left and the day it reached (the multi-column carry).
 *
 * Requires the running embedded cluster (`./equin build` first).
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
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { installRollups } from "@plugins/database/plugins/derived-tables/server/testing";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { taskHistoryDays, taskHistoryFacts } from "./rollups";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "task_history_oracle" });
});

afterAll(async () => {
  await t.drop();
});

async function run(text: string): Promise<void> {
  await t.db.execute(sql.raw(text));
}

beforeEach(async () => {
  for (const name of [
    "task_history_days",
    "task_history_facts",
    "task_attempt_facts",
    "tasks",
  ]) {
    await run(`DROP TABLE IF EXISTS "${name}" CASCADE`);
  }
  await run(`CREATE TABLE tasks (
    id text PRIMARY KEY,
    title text,
    created_at timestamptz NOT NULL,
    held_at timestamptz,
    dropped_at timestamptz)`);
  await run(`CREATE TABLE task_attempt_facts (
    host_id text PRIMARY KEY,
    has_attempt boolean NOT NULL DEFAULT true,
    has_completed boolean NOT NULL DEFAULT false,
    has_active boolean NOT NULL DEFAULT false,
    has_waiting boolean NOT NULL DEFAULT false,
    min_push_at timestamptz)`);
  await installRollups(t.db, [taskHistoryFacts, taskHistoryDays]);
});

const Day = z.object({
  date: z.string(),
  added: z.coerce.number(),
  completed: z.coerce.number(),
  dropped: z.coerce.number(),
});

async function rollup(): Promise<z.infer<typeof Day>[]> {
  return executeRows(t.db, {
    query:
      sql.raw(`SELECT to_char(day, 'YYYY-MM-DD') AS date, added, completed, dropped
                      FROM task_history_days ORDER BY day`),
    row: Day,
  });
}

// The card's former query, its status rule spelled out over the two tables.
async function truth(): Promise<z.infer<typeof Day>[]> {
  return executeRows(t.db, {
    query: sql.raw(`
      WITH s AS (
        SELECT t.*, f.min_push_at,
               CASE WHEN t.held_at IS NULL AND COALESCE(f.has_completed, false) THEN 'done'
                    WHEN COALESCE(f.has_active, false) THEN 'active'
                    WHEN t.dropped_at IS NOT NULL THEN 'dropped'
                    WHEN t.held_at IS NOT NULL THEN 'held'
                    ELSE 'open' END AS status
          FROM tasks t LEFT JOIN task_attempt_facts f ON f.host_id = t.id)
      SELECT date, SUM(added)::int AS added, SUM(completed)::int AS completed,
             SUM(dropped)::int AS dropped
        FROM s CROSS JOIN LATERAL (VALUES
          (s.created_at, 1, 0, 0),
          (CASE WHEN s.status = 'done' THEN s.min_push_at END, 0, 1, 0),
          (CASE WHEN s.status = 'dropped' THEN s.dropped_at
                WHEN s.status = 'held' THEN s.held_at END, 0, 0, 1)
        ) AS e(at, added, completed, dropped)
        CROSS JOIN LATERAL (SELECT to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date) d
       WHERE e.at IS NOT NULL
       GROUP BY date ORDER BY date`),
    row: Day,
  });
}

async function expectConsistent(): Promise<void> {
  expect(await rollup()).toEqual(await truth());
}

async function xminOf(day: string): Promise<string> {
  const rows = await executeRows(t.db, {
    query: sql`SELECT xmin::text AS x FROM task_history_days WHERE day = ${day}::date`,
    row: z.object({ x: z.string() }),
  });
  if (rows.length !== 1) throw new Error(`no day row for ${day}`);
  return rows[0]!.x;
}

// T1 created on the 1st (late evening UTC+0), T2 and T3 on the 2nd, T4 on the 3rd.
async function seed(): Promise<void> {
  await run(`INSERT INTO tasks (id, created_at) VALUES
    ('T1', '2026-01-01T23:30Z'), ('T2', '2026-01-02T08:00Z'),
    ('T3', '2026-01-02T09:00Z'), ('T4', '2026-01-03T10:00Z')`);
}

describe("task history rollups", () => {
  test("created tasks count on their UTC creation day", async () => {
    await seed();
    expect(await rollup()).toEqual([
      { date: "2026-01-01", added: 1, completed: 0, dropped: 0 },
      { date: "2026-01-02", added: 2, completed: 0, dropped: 0 },
      { date: "2026-01-03", added: 1, completed: 0, dropped: 0 },
    ]);
    await expectConsistent();
  });

  test("a completed attempt resolves the task on its first push's day; an active agent alone does not", async () => {
    await seed();
    await run(
      `INSERT INTO task_attempt_facts (host_id, has_active) VALUES ('T1', true)`,
    );
    await expectConsistent();
    await run(`UPDATE task_attempt_facts
                  SET has_active = false, has_completed = true, min_push_at = '2026-01-04T01:00Z'
                WHERE host_id = 'T1'`);
    expect((await rollup()).at(-1)).toEqual({
      date: "2026-01-04",
      added: 0,
      completed: 1,
      dropped: 0,
    });
    await expectConsistent();
  });

  test("a push moving earlier moves the completion between days, leaving none behind", async () => {
    await seed();
    await run(`INSERT INTO task_attempt_facts (host_id, has_completed, min_push_at)
               VALUES ('T2', true, '2026-01-05T12:00Z')`);
    await run(
      `UPDATE task_attempt_facts SET min_push_at = '2026-01-03T12:00Z' WHERE host_id = 'T2'`,
    );
    expect((await rollup()).map((d) => d.date)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
    await expectConsistent();
  });

  test("drop, un-drop, hold over done, and an active agent over a drop", async () => {
    await seed();
    await run(
      `UPDATE tasks SET dropped_at = '2026-01-06T10:00Z' WHERE id = 'T3'`,
    );
    await expectConsistent();
    await run(`UPDATE tasks SET dropped_at = NULL WHERE id = 'T3'`);
    await expectConsistent();
    // Done, then held: the hold wins, counted as dropped on the hold's day.
    await run(`INSERT INTO task_attempt_facts (host_id, has_completed, min_push_at)
               VALUES ('T4', true, '2026-01-04T00:00Z')`);
    await run(`UPDATE tasks SET held_at = '2026-01-07T00:00Z' WHERE id = 'T4'`);
    await expectConsistent();
    // A dropped task whose agent is running is not resolved.
    await run(
      `UPDATE tasks SET dropped_at = '2026-01-06T00:00Z' WHERE id = 'T2'`,
    );
    await run(
      `INSERT INTO task_attempt_facts (host_id, has_active) VALUES ('T2', true)`,
    );
    await expectConsistent();
    expect((await rollup()).some((d) => d.date === "2026-01-06")).toBe(false);
  });

  test("a deleted task leaves its days, and a day with nothing left is gone", async () => {
    await seed();
    await run(
      `UPDATE tasks SET dropped_at = '2026-01-08T00:00Z' WHERE id = 'T4'`,
    );
    await run(`DELETE FROM tasks WHERE id IN ('T1', 'T4')`);
    expect((await rollup()).map((d) => d.date)).toEqual(["2026-01-02"]);
    await expectConsistent();
  });

  test("a created_at moving to another day moves the task", async () => {
    await seed();
    await run(
      `UPDATE tasks SET created_at = '2026-01-03T00:00Z' WHERE id = 'T1'`,
    );
    await expectConsistent();
  });

  test("a write the history does not read leaves the day rows untouched", async () => {
    await seed();
    const before = await xminOf("2026-01-02");
    await run(`UPDATE tasks SET title = 'renamed' WHERE id = 'T2'`);
    await run(
      `INSERT INTO task_attempt_facts (host_id, has_waiting) VALUES ('T3', true)`,
    );
    expect(await xminOf("2026-01-02")).toBe(before);
  });

  test("the day indexes exist, and a reinstall over a consistent state writes nothing", async () => {
    await seed();
    const ix = await executeRows(t.db, {
      query: sql.raw(`SELECT indexname::text AS name FROM pg_indexes
                       WHERE tablename = 'task_history_facts' AND indexname LIKE '%_day_idx' ORDER BY 1`),
      row: z.object({ name: z.string() }),
    });
    expect(ix.map((r) => r.name)).toEqual([
      "task_history_facts_created_day_idx",
      "task_history_facts_resolved_day_idx",
    ]);
    const again = await installRollups(t.db, [
      taskHistoryFacts,
      taskHistoryDays,
    ]);
    expect(again.every((r) => r.upserted === 0 && r.deleted === 0)).toBe(true);
  });

  test("a missing or redefined day index is restored by the next install", async () => {
    await run(`DROP INDEX task_history_facts_created_day_idx`);
    await run(`DROP INDEX task_history_facts_resolved_day_idx`);
    await run(
      `CREATE INDEX task_history_facts_resolved_day_idx ON task_history_facts (resolution)`,
    );
    await installRollups(t.db, [taskHistoryFacts, taskHistoryDays]);
    const ix = await executeRows(t.db, {
      query: sql.raw(`SELECT indexdef::text AS def FROM pg_indexes
                       WHERE tablename = 'task_history_facts' AND indexname LIKE '%_day_idx' ORDER BY indexname`),
      row: z.object({ def: z.string() }),
    });
    expect(ix.map((r) => r.def.replace(/^.* USING btree /, ""))).toEqual([
      "(created_day)",
      "(resolved_day)",
    ]);
  });
});
