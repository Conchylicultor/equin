/**
 * Real-DB suite for the `touchedBy` declarations in `tables.ts`: the REAL
 * migration chain on a throwaway database (db-test-fixture), then exactly this
 * cluster's compiled derived-`updatedAt` triggers — passed explicitly, because
 * the registry is process-wide and also holds other suites' stand-in tables.
 *
 * Every row is seeded with `updated_at` far in the past, so a bump (the trigger
 * sets `now()`) is detectable regardless of transaction timing.
 *
 * Requires the running embedded cluster (`./singularity build` first):
 *   ./singularity test plugins/tasks/plugins/tasks-core
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { installDerivedUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import { _conversations, _tasks, tasksCoreDerivedUpdatedAt } from "./tables";
import { unionTaskClusters } from "./mutations/clusters";
import type { DbExecutor } from "./status-batch";

type ConvStatus = "starting" | "working" | "waiting" | "gone" | "done";

const OLD = "2000-01-01T00:00:00.000Z";
let t: TestDb;
let seq = 0;

function spec<T>(s: T | undefined, name: string): T {
  if (!s) throw new Error(`${name}: expected a derived updatedAt spec`);
  return s;
}

async function seedTask(): Promise<string> {
  const id = `dua-task-${++seq}`;
  await t.db.execute(sql`
    INSERT INTO tasks (id, title, title_auto, rank, created_at, updated_at)
    VALUES (${id}, 'a', true, ${id}, ${OLD}, ${OLD})
  `);
  return id;
}

async function seedConversation(
  status: ConvStatus = "waiting",
): Promise<string> {
  const taskId = await seedTask();
  const attemptId = `dua-att-${seq}`;
  const id = `dua-conv-${seq}`;
  await t.db.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path, created_at, updated_at)
    VALUES (${attemptId}, ${taskId}, '/tmp/x', ${OLD}, ${OLD})
  `);
  await t.db.execute(sql`
    INSERT INTO conversations (id, attempt_id, title, status, runtime, model, kind, created_at, updated_at)
    VALUES (${id}, ${attemptId}, 'a', ${status}, 'sdk', 'opus', 'user', ${OLD}, ${OLD})
  `);
  return id;
}

async function bumped(
  table: "tasks" | "conversations",
  id: string,
): Promise<boolean> {
  const res = await t.db.execute(
    sql`SELECT updated_at <> ${OLD}::timestamptz AS bumped FROM ${sql.identifier(table)} WHERE id = ${id}`,
  );
  const row = res.rows[0] as { bumped: boolean } | undefined;
  if (!row) throw new Error(`${table} ${id}: row not found`);
  return row.bumped;
}

async function setConv(
  id: string,
  patch: Partial<(typeof _conversations)["$inferInsert"]>,
): Promise<void> {
  await t.db.update(_conversations).set(patch).where(eq(_conversations.id, id));
}

beforeAll(async () => {
  t = await createTestDb({ prefix: "tasks_derived_updated_at" });
  await runMigrations(t.db);
  const results = await installDerivedUpdatedAt(t.db, [
    spec(tasksCoreDerivedUpdatedAt.tasks, "tasks"),
    spec(tasksCoreDerivedUpdatedAt.attempts, "attempts"),
    spec(tasksCoreDerivedUpdatedAt.conversations, "conversations"),
  ]);
  expect(results.map((r) => r.table).sort()).toEqual([
    "attempts",
    "conversations",
    "tasks",
  ]);
});

afterAll(async () => {
  await t.drop();
});

describe("conversations.updated_at", () => {
  test("viewing (lastViewedAt) does not bump", async () => {
    const id = await seedConversation();
    await setConv(id, { lastViewedAt: new Date() });
    expect(await bumped("conversations", id)).toBe(false);
  });

  test("hibernating and waking (hibernatedAt) do not bump", async () => {
    const id = await seedConversation();
    await setConv(id, { hibernatedAt: new Date() });
    await setConv(id, { hibernatedAt: null });
    expect(await bumped("conversations", id)).toBe(false);
  });

  test("resume bounce waiting → starting → waiting does not bump", async () => {
    const id = await seedConversation("waiting");
    await setConv(id, { status: "starting" });
    await setConv(id, { status: "waiting" });
    expect(await bumped("conversations", id)).toBe(false);
  });

  test("a turn starting (waiting → working) bumps", async () => {
    const id = await seedConversation("waiting");
    await setConv(id, { status: "working" });
    expect(await bumped("conversations", id)).toBe(true);
  });

  test("a turn ending (working → waiting) bumps", async () => {
    const id = await seedConversation("working");
    await setConv(id, { status: "waiting" });
    expect(await bumped("conversations", id)).toBe(true);
  });

  test("closing (→ done) bumps", async () => {
    const id = await seedConversation("waiting");
    await setConv(id, { status: "done", endedAt: new Date() });
    expect(await bumped("conversations", id)).toBe(true);
  });

  test("a pane dying (waiting → gone, endedAt) does not bump", async () => {
    const id = await seedConversation("waiting");
    await setConv(id, {
      status: "gone",
      endedAt: new Date(),
      waitingFor: null,
    });
    expect(await bumped("conversations", id)).toBe(false);
  });

  test("a title change bumps; rewriting the same title does not", async () => {
    const same = await seedConversation();
    await setConv(same, { title: "a" });
    expect(await bumped("conversations", same)).toBe(false);

    const changed = await seedConversation();
    await setConv(changed, { title: "b" });
    expect(await bumped("conversations", changed)).toBe(true);
  });

  test("writing updatedAt raises", async () => {
    const id = await seedConversation();
    let err: Error | undefined;
    try {
      await setConv(id, { updatedAt: new Date() });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
  });
});

describe("tasks.updated_at", () => {
  test("a cluster relabel (unionTaskClusters) does not bump", async () => {
    const a = await seedTask();
    const b = await seedTask();
    await unionTaskClusters(a, b, t.db as DbExecutor);
    const rows = await t.db
      .select({ id: _tasks.id, clusterId: _tasks.clusterId })
      .from(_tasks)
      .where(sql`${_tasks.id} IN (${a}, ${b})`);
    // The union really wrote both rows — the no-bump is not vacuous.
    expect(rows.every((r) => r.clusterId !== null)).toBe(true);
    expect(await bumped("tasks", a)).toBe(false);
    expect(await bumped("tasks", b)).toBe(false);
  });

  test("a title edit bumps", async () => {
    const id = await seedTask();
    await t.db
      .update(_tasks)
      .set({ title: "edited", titleAuto: false })
      .where(eq(_tasks.id, id));
    expect(await bumped("tasks", id)).toBe(true);
  });
});
