/**
 * `sidequest-autopilot.triage.all` holds EVERY triage read: the launch list
 * joins it to every ready sidequest, so a read past the old window's
 * `maxLimit` (2000) must still be in it — read before as untriaged. The real
 * declaration, compiled with the served binding against a throwaway database
 * carrying the real schema, loads the whole set FULL.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/tasks/plugins/sidequest-autopilot`.
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
import { sidequestTriageRows } from "../../shared/triage";
import { tasksSidequestTriage } from "./tables";

setDefaultTimeout(120_000);

/** The old window's `maxLimit`, plus one. */
const COUNT = 2001;
const LAST = `sq-${COUNT}`;

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "sidequest_triage_all" });
  await runMigrations(t.db);
  await t.db.execute(sql`
    INSERT INTO tasks (id, title, title_auto, rank)
    SELECT 'sq-' || g, 'task ' || g, false, 'a' || lpad(g::text, 6, '0')
    FROM generate_series(1, ${COUNT}) g`);
  const at = new Date();
  await t.db.insert(tasksSidequestTriage.table).values(
    Array.from({ length: COUNT }, (_, i) => ({
      taskId: `sq-${i + 1}`,
      verdict: "ready" as const,
      context: "probe",
      question: null,
      answers: [],
      answer: null,
      risk: "low" as const,
      sizeMinutes: 30,
      value: 3,
      areas: [],
      mainSha: "0000000",
      sourceTitle: `task ${i + 1}`,
      sourceDescription: "",
      triagedAt: at,
    })),
  );
});

afterAll(async () => {
  await t?.drop();
});

test("the whole set holds the triage read past the old window's maxLimit", async () => {
  const specs = compileCollection(sidequestTriageRows, {
    from: tasksSidequestTriage,
    db: t.db as unknown as QueryDb,
  });
  const rows = await specs.all.loader({});
  expect(rows).toHaveLength(COUNT);
  expect(rows.find((r) => r.taskId === LAST)?.verdict).toBe("ready");
});
