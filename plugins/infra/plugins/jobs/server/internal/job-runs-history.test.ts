/**
 * `job-runs.history` is Debug → Queue's History view: the recorded runs as a
 * window, newest finished first. The real declaration, compiled with the
 * served binding against a throwaway database carrying the real schema, loads
 * one bounded window (never the whole ring), with `waitMs` computed in SQL, and
 * filters by `jobId` — what a detail pane follows a finished queue row by.
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/infra/plugins/jobs`.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { jobRuns } from "../../core/resources";
import { jobRunWaitMs } from "./resources";
import { _jobRuns } from "./tables";

setDefaultTimeout(120_000);

const COUNT = 250;

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "job_runs_history" });
  await runMigrations(t.db);
  // A ring of 20 per job name, run `g` finishing `g` seconds after the epoch
  // base — so run 1 is the oldest. Each waited 250 ms for a slot, and came
  // from graphile job `100 + g`.
  await t.db.execute(sql`
    INSERT INTO job_runs (job_name, slot, seq, started_at, finished_at,
      outcome, duration_ms, attempt, queued_at, job_id)
    SELECT 'job-' || ((g - 1) / 20), (g - 1) % 20, g,
      timestamptz '2026-01-01' + g * interval '1 second',
      timestamptz '2026-01-01' + g * interval '1 second',
      'succeeded', 1, 1,
      timestamptz '2026-01-01' + g * interval '1 second' - interval '250 ms',
      (100 + g)::text
    FROM generate_series(1, ${COUNT}) g`);
});

afterAll(async () => {
  await t?.drop();
});

/** The window's loader, as the served collection runs it. */
const windowLoader = () =>
  compileWindowQuery(
    jobRuns.window,
    compileCollection(jobRuns, {
      from: _jobRuns,
      columns: { waitMs: (j) => jobRunWaitMs(j.base) },
      db: t.db as unknown as QueryDb,
    }).window,
  ).serverOpts.loader;

test("the default window is the newest runs, bounded by its limit", async () => {
  const rows = (await windowLoader()(jobRuns.window.window.encode())) as {
    id: string;
    waitMs: number | null;
  }[];
  expect(rows).toHaveLength(100);
  expect(rows[0]).toMatchObject({
    id: `job-${Math.floor((COUNT - 1) / 20)}:${COUNT}`,
    waitMs: 250,
  });
});

test("a window filtered by jobId finds the run a queue row became", async () => {
  const rows = (await windowLoader()(
    jobRuns.window.window.encode({ where: { jobId: "107" }, limit: 1 }),
  )) as { id: string; jobId: string | null }[];
  expect(rows).toEqual([
    expect.objectContaining({ id: "job-0:7", jobId: "107" }),
  ]);
});
