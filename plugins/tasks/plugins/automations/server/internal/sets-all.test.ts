/**
 * The two whole sets this plugin serves over its side-tables hold EVERY row:
 *
 * - `automations.origins` — the task list's Automation field reads it whole,
 *   so an automated task past the old 2000-row read must still be in it (read
 *   before as filed by hand);
 * - `automations.launch-decisions.all` — a launch list joins it to every task
 *   it shows, so a decision past the old window's `maxLimit` (2000) must
 *   still be in it (read before as undecided).
 *
 * The real declarations, compiled with the served bindings against a
 * throwaway database carrying the real schema, load each set FULL.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/tasks/plugins/automations`.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { automationOrigins, launchDecisions } from "../../core";
import { tasksLaunchDecision, tasksOrigin } from "./tables";

setDefaultTimeout(120_000);

/** The old reads' `maxLimit`, plus one. */
const COUNT = 2001;
const LAST = `at-${COUNT}`;
const ids = Array.from({ length: COUNT }, (_, i) => `at-${i + 1}`);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "automations_sets_all" });
  await runMigrations(t.db);
  await t.db.execute(sql`
    INSERT INTO tasks (id, title, title_auto, rank)
    SELECT 'at-' || g, 'task ' || g, false, 'a' || lpad(g::text, 6, '0')
    FROM generate_series(1, ${COUNT}) g`);
  const at = new Date();
  await t.db.insert(tasksOrigin.table).values(
    ids.map((taskId) => ({
      taskId,
      automationId: "probe",
      sourceKeys: [],
      filedAt: at,
    })),
  );
  await t.db.insert(tasksLaunchDecision.table).values(
    ids.map((taskId) => ({
      taskId,
      automationId: "probe",
      decision: "approved" as const,
      decidedAt: at,
    })),
  );
});

afterAll(async () => {
  await t?.drop();
});

test("the origin set holds the automated task past the old read's maxLimit", async () => {
  const specs = compileCollection(automationOrigins, {
    from: tasksOrigin,
    db: t.db as unknown as QueryDb,
  });
  const rows = await specs.all.loader({});
  expect(rows).toHaveLength(COUNT);
  expect(rows.find((r) => r.taskId === LAST)).toEqual({
    taskId: LAST,
    automationId: "probe",
  });
});

test("the decision set holds the decision past the old window's maxLimit", async () => {
  const specs = compileCollection(launchDecisions, {
    from: tasksLaunchDecision,
    db: t.db as unknown as QueryDb,
  });
  const rows = await specs.all.loader({});
  expect(rows).toHaveLength(COUNT);
  expect(rows.find((r) => r.taskId === LAST)?.decision).toBe("approved");
});
