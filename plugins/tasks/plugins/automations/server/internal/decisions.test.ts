/**
 * Launch decisions are the task's, not one automation's: the approved set,
 * the pending-approval count (approved ∧ no origin ∧ still `new`), and the
 * per-task approval toggle — whose "take it back" never erases an exclusion.
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/tasks/plugins/automations`.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "@plugins/database/server";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { installTaskDerivedSchema } from "@plugins/tasks/plugins/tasks-core/server/testing";
import type { LaunchDecision } from "../../core";
import {
  approvedTaskIds,
  decideLaunch,
  pendingApprovalCount,
  setTaskApproval,
} from "./decisions";
import { tasksLaunchDecision, tasksOrigin } from "./tables";

setDefaultTimeout(120_000);

let t: TestDb;
let exec: DbExecutor;

beforeAll(async () => {
  t = await createTestDb({ prefix: "automations_decisions" });
  await runMigrations(t.db);
  await installTaskDerivedSchema(t.db);
  exec = t.db as unknown as DbExecutor;
  // new: fresh, launched (origin row), excluded; settled: dropped, held.
  await t.db.execute(sql`
    INSERT INTO tasks (id, title, title_auto, rank, held_at, dropped_at, mandate) VALUES
      ('t-new', 'new', false, 'a1', NULL, NULL, '{}'),
      ('t-launched', 'launched', false, 'a2', NULL, NULL, '{}'),
      ('t-dropped', 'dropped', false, 'a3', NULL, now(), '{}'),
      ('t-held', 'held', false, 'a4', now(), NULL, '{}'),
      ('t-excluded', 'excluded', false, 'a5', NULL, NULL, '{}')`);
  await t.db.insert(tasksOrigin.table).values({
    taskId: "t-launched",
    automationId: "probe",
    sourceKeys: [],
    filedAt: new Date(),
    role: "launched",
  });
});

afterAll(async () => {
  await t?.drop();
});

async function seed(decisions: Record<string, LaunchDecision>): Promise<void> {
  await t.db.delete(tasksLaunchDecision.table);
  const decidedAt = new Date();
  await t.db.insert(tasksLaunchDecision.table).values(
    Object.entries(decisions).map(([taskId, decision]) => ({
      taskId,
      decision,
      decidedAt,
    })),
  );
}

async function decisionOf(taskId: string): Promise<LaunchDecision | null> {
  const row = await tasksLaunchDecision.get(taskId, exec);
  return row?.decision ?? null;
}

beforeEach(async () => {
  await seed({
    "t-new": "approved",
    "t-launched": "approved",
    "t-dropped": "approved",
    "t-held": "approved",
    "t-excluded": "excluded",
  });
});

test("the approved set is every approved task, whatever its status", async () => {
  expect(await approvedTaskIds(exec)).toEqual(
    new Set(["t-new", "t-launched", "t-dropped", "t-held"]),
  );
});

test("the pending count ignores launched, non-new and excluded tasks", async () => {
  expect(await pendingApprovalCount(exec)).toBe(1);
});

test("taking an approval back never erases an exclusion", async () => {
  await setTaskApproval("t-excluded", false, exec);
  expect(await decisionOf("t-excluded")).toBe("excluded");
  await setTaskApproval("t-new", false, exec);
  expect(await decisionOf("t-new")).toBeNull();
});

test("approving overwrites an exclusion", async () => {
  await setTaskApproval("t-excluded", true, exec);
  expect(await decisionOf("t-excluded")).toBe("approved");
  expect(await pendingApprovalCount(exec)).toBe(2);
});

test("clearing a decision deletes it by task alone", async () => {
  await decideLaunch(["t-excluded", "t-new"], null, exec);
  expect(await decisionOf("t-excluded")).toBeNull();
  expect(await decisionOf("t-new")).toBeNull();
  expect(await decisionOf("t-held")).toBe("approved");
});
