/**
 * The breakdown's read over a real Postgres (db-test-fixture, the real
 * migration chain, the priced view): each account cut at its own window,
 * usage under `UNKNOWN_ACCOUNT` left out, and a `conv:` source joined through attempt → task →
 * mandate root → role / automation so it lands in its category.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { UNKNOWN_ACCOUNT } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import { recordPriceVersion } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { installSpendHoursView } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server/testing";
import type { SpendNode } from "../../core";
import { readSpendBreakdown } from "./spend-query";

setDefaultTimeout(120_000);

let t: TestDb;

async function task(id: string, title: string, created: string) {
  await t.db.execute(sql`
    INSERT INTO tasks (id, cluster_id, title, title_auto, rank, mandate_ref, author_kind, created_at)
    VALUES (${id}, ${id}, ${title}, false, 'a0', 'interactive', 'human', ${created}::timestamptz)`);
}

async function run(
  conv: string,
  attempt: string,
  taskId: string,
  created: string,
  ended: boolean,
) {
  await t.db.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path, created_at)
    VALUES (${attempt}, ${taskId}, ${`/tmp/${attempt}`}, ${created}::timestamptz)
    ON CONFLICT (id) DO NOTHING`);
  await t.db.execute(sql`
    INSERT INTO conversations (id, attempt_id, title, status, runtime, model, kind, launch_cause, ended_at)
    VALUES (${conv}, ${attempt}, ${`Chat ${conv}`}, ${ended ? "done" : "working"}, 'sdk', 'opus', 'user', 'direct',
            ${ended ? created : null}::timestamptz)`);
}

async function mandate(taskId: string, mandateId: string, source: string) {
  await t.db.execute(sql`
    INSERT INTO tasks_ext_mandate (parent_id, mandate_id, source_task_id)
    VALUES (${taskId}, ${mandateId}, ${source})
    ON CONFLICT (parent_id) DO UPDATE SET mandate_id = excluded.mandate_id, source_task_id = excluded.source_task_id`);
}

/** `cost` dollars of input tokens at $1 per million (the one price version, below). */
async function spend(
  account: string,
  hour: string,
  source: string,
  cost: number,
) {
  await t.db.execute(sql`
    INSERT INTO claude_usage_hours (account_id, hour, source, model, speed, input_below)
    VALUES (${account}, ${hour}::timestamptz, ${source}, 'm-a', 'standard', ${cost * 1e6})`);
}

beforeAll(async () => {
  t = await createTestDb({ prefix: "supervisors_spend_test" });
  await runMigrations(t.db);
  await installSpendHoursView(t.db);
  // A role with two sessions; the second has a worker.
  await t.db.execute(
    sql`INSERT INTO supervisor_roles (id, name) VALUES ('srole-h', 'Harness')`,
  );
  for (const [id, created] of [
    ["task-s1", "2026-11-01T00:00:00Z"],
    ["task-s2", "2026-11-10T00:00:00Z"],
  ] as const) {
    await task(id, `Harness ${id}`, created);
    await mandate(id, "supervisor-role", id);
    await t.db.execute(
      sql`INSERT INTO tasks_ext_supervisor (parent_id, supervisor) VALUES (${id}, 'srole-h')`,
    );
  }
  await task("task-w", "Cold cache", "2026-11-10T01:00:00Z");
  await mandate("task-w", "supervisor-role", "task-s2");
  await run("conv-s2", "att-s2", "task-s2", "2026-11-10T00:00:00Z", false);
  await run("conv-w1", "att-w1", "task-w", "2026-11-10T01:00:00Z", true);
  await run("conv-w2", "att-w2", "task-w", "2026-11-10T02:00:00Z", true);
  // An ad-hoc supervisor, an automation's task and a person's task.
  await task("task-a", "Icon migration", "2026-11-11T00:00:00Z");
  await mandate("task-a", "supervisor", "task-a");
  await run("conv-a", "att-a", "task-a", "2026-11-11T00:00:00Z", true);
  await task("task-auto", "Investigate", "2026-11-11T00:00:00Z");
  await mandate("task-auto", "interactive", "task-auto");
  await t.db.execute(sql`
    INSERT INTO tasks_ext_origin (parent_id, automation_id, source_keys, filed_at)
    VALUES ('task-auto', 'reports-investigation', '[]'::jsonb, '2026-11-11T00:00:00Z')`);
  await run("conv-auto", "att-auto", "task-auto", "2026-11-11T00:00:00Z", true);
  await task("task-you", "Boot perf", "2026-11-11T00:00:00Z");
  await mandate("task-you", "interactive", "task-you");
  await run("conv-you", "att-you", "task-you", "2026-11-11T00:00:00Z", true);

  // The ledger: "max" (a plan) from Nov 12 09:00, "api" (API key) from Nov 8.
  await spend("max", "2026-11-12T08:00:00Z", "conv:conv-you", 1000); // before its window
  await spend("max", "2026-11-12T09:00:00Z", "conv:conv-you", 64);
  await spend("max", "2026-11-12T10:00:00Z", "conv:conv-s2", 28);
  await spend("max", "2026-11-12T10:00:00Z", "conv:conv-w1", 30);
  await spend("max", "2026-11-12T11:00:00Z", "conv:conv-w2", 16);
  await spend("max", "2026-11-12T11:00:00Z", "conv:conv-a", 14);
  await spend("max", "2026-11-12T11:00:00Z", "conv:conv-auto", 18);
  await spend("max", "2026-11-12T12:00:00Z", "cli:task-title", 11);
  await spend(UNKNOWN_ACCOUNT, "2026-11-13T00:00:00Z", "conv:conv-you", 500); // unattributed: left out
  await spend("max", "2026-11-12T12:00:00Z", "conv:conv-gone", 2); // its conversation is gone
  await spend("api", "2026-11-09T00:00:00Z", "conv:conv-you", 6);
  await spend("api", "2026-11-07T00:00:00Z", "conv:conv-you", 2000); // before its window
  await spend("other", "2026-11-12T12:00:00Z", "conv:conv-you", 3000); // no window asked
  // One price version, from -infinity: $1 per million tokens of every kind.
  await recordPriceVersion(
    t.db,
    {
      fetchedAt: 0,
      models: {
        "m-a": {
          input: 1e-6,
          output: 1e-6,
          cacheCreate5m: 1e-6,
          cacheCreate1h: 1e-6,
          cacheRead: 1e-6,
        },
      },
    },
    "fallback",
  );
});

afterAll(async () => {
  await t.drop();
});

const at = (node: SpendNode, ...ids: string[]): SpendNode =>
  ids.reduce((n, id) => {
    const next = n.children.find((c) => c.id === id);
    if (!next)
      throw new Error(
        `no ${id} under ${n.id}: ${n.children.map((c) => c.id).join(", ")}`,
      );
    return next;
  }, node);

describe("readSpendBreakdown", () => {
  const windows = [
    { accountId: "api", since: "2026-11-08T00:00:00.000Z", metered: true },
    { accountId: "max", since: "2026-11-12T09:00:00.000Z", metered: false },
  ];

  test("each account over its own window; history and other accounts left out", async () => {
    const { tree, attributedSince } = await readSpendBreakdown(t.db, windows);
    expect(tree.costUsd).toBe(64 + 28 + 30 + 16 + 14 + 18 + 11 + 2 + 6);
    expect(tree.billedUsd).toBe(6);
    expect(attributedSince).toBe("2026-11-07T00:00:00.000Z");
  });

  test("every source lands in its category and level", async () => {
    const { tree } = await readSpendBreakdown(t.db, windows);
    const role = at(tree, "supervisors", "srole-h");
    expect(role.costUsd).toBe(74);
    expect(role.live).toBe(true);
    // The live session's own conversation, numbered second of the role's sessions.
    const session = at(role, "session:task-s2");
    expect(session.name).toBe("Session 2");
    expect(session.conversationId).toBe("conv-s2");
    expect(at(role, "task-w").children.map((c) => c.name)).toEqual([
      "Attempt 1",
      "Attempt 2",
    ]);
    expect(at(tree, "adhoc", "task-a").costUsd).toBe(14);
    expect(
      at(tree, "background", "reports-investigation", "task-auto")
        .conversationId,
    ).toBe("conv-auto");
    expect(at(tree, "background", "cli:task-title").costUsd).toBe(11);
    expect(at(tree, "you", "task-you").costUsd).toBe(70);
    expect(at(tree, "you", "task-you").billedUsd).toBe(6);
    expect(at(tree, "you", "conv:conv-gone").name).toBe("Removed conversation");
  });

  test("no windows: an empty tree", async () => {
    const { tree, attributedSince } = await readSpendBreakdown(t.db, []);
    expect(tree.children).toEqual([]);
    expect(attributedSince).toBeNull();
  });
});
