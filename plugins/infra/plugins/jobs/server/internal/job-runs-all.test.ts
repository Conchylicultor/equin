/**
 * `job-runs.all` holds EVERY recorded run: Debug → Queue's Jobs list merges
 * the whole ring with the live queue and filters it on the client, so a run
 * past the old window's `maxLimit` (5000) must still be in it. The real
 * declaration, compiled with the served binding against a throwaway database
 * carrying the real schema, loads the whole set FULL, newest finished first,
 * with `waitMs` computed in SQL.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/infra/plugins/jobs`.
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
import { jobRuns } from "../../core/resources";
import { jobRunWaitMs } from "./resources";
import { _jobRuns } from "./tables";

setDefaultTimeout(120_000);

/** The old window's `maxLimit`, plus one. */
const COUNT = 5001;

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "job_runs_all" });
  await runMigrations(t.db);
  // A ring of 20 per job name, run `g` finishing `g` seconds after the epoch
  // base — so run 1 is the oldest. Each waited 250 ms for a slot.
  await t.db.execute(sql`
    INSERT INTO job_runs (job_name, slot, seq, started_at, finished_at,
      outcome, duration_ms, attempt, queued_at)
    SELECT 'job-' || ((g - 1) / 20), (g - 1) % 20, g,
      timestamptz '2026-01-01' + g * interval '1 second',
      timestamptz '2026-01-01' + g * interval '1 second',
      'succeeded', 1, 1,
      timestamptz '2026-01-01' + g * interval '1 second' - interval '250 ms'
    FROM generate_series(1, ${COUNT}) g`);
});

afterAll(async () => {
  await t?.drop();
});

test("the whole set holds the oldest run, past the old window's maxLimit", async () => {
  const specs = compileCollection(jobRuns, {
    from: _jobRuns,
    columns: { waitMs: (j) => jobRunWaitMs(j.base) },
    db: t.db as unknown as QueryDb,
  });
  const rows = await specs.all.loader({});
  expect(rows).toHaveLength(COUNT);
  // Newest finished first: the oldest run — the one a window would drop — is
  // last.
  expect(rows[0]?.id).toBe(`job-${(COUNT - 1) / 20}:${COUNT}`);
  expect(rows.at(-1)).toMatchObject({ id: "job-0:1", waitMs: 250 });
});
