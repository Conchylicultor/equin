/**
 * Real-DB regression suite for graphile's `add_job` lock race: **a keyed
 * enqueue whose existing row a worker locks mid-call still lands a row.**
 *
 * `add_jobs` detaches the key of an unavailable row, then upserts
 * `ON CONFLICT (key) … WHERE jobs.locked_at IS NULL`. A worker lock that the
 * detach does not see but the upsert does (here: uncommitted while the detach
 * runs, so the upsert waits on it, then re-checks a now-locked row) makes
 * `add_job` return an all-NULL record — `watch.ingest` failed on
 * `column "id": expected string, received null`. `insertJobRow` calls again.
 *
 * Run: `./equin test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { installQueueSchema } from "../../server/internal/queue-schema";
import { defineJob } from "../../server/internal/registry";

let t: TestDb;
let worker: Client;

beforeAll(async () => {
  t = await createTestDb({ prefix: "add_job_lock_race_test" });
  await installQueueSchema(t.connectionString);
  worker = new Client({ connectionString: t.connectionString });
  await worker.connect();
});

afterAll(async () => {
  await worker.end();
  await t.drop();
});

const job = defineJob({
  name: "jobs.add-job-lock-race-test",
  description: "Test job.",
  hold: "instant",
  input: z.object({ key: z.string() }),
  event: z.never(),
  dedup: { key: (input) => input.key },
  run: () => {
    throw new Error(
      "[jobs] add-job-lock-race-test job was dispatched; this suite starts no worker",
    );
  },
});

/** Resolves once some backend of the test database waits on a row lock. */
async function untilSomeoneWaitsOnALock(): Promise<void> {
  for (;;) {
    const { rows } = await worker.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
       ) AS waiting`,
    );
    if (rows[0]?.waiting) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("add_job lock race", () => {
  test("a keyed row locked between add_jobs' detach and upsert still yields a fresh row", async () => {
    const { jobId: first } = await t.db.transaction((tx) =>
      job.enqueue({ key: "raced" }, { tx }),
    );

    // The worker fetches the row — its lock not yet committed.
    await worker.query("BEGIN");
    await worker.query(
      `UPDATE graphile_worker._private_jobs
          SET locked_at = now(), locked_by = 'race-test', attempts = attempts + 1
        WHERE id = $1::bigint`,
      [first],
    );

    // The re-enqueue's detach sees the row unlocked and skips it; its upsert
    // conflicts on the key and waits for the worker.
    const second = t.db.transaction((tx) =>
      job.enqueue({ key: "raced" }, { tx }),
    );
    await untilSomeoneWaitsOnALock();
    await worker.query("COMMIT");

    const { jobId } = await second;
    expect(jobId).not.toBe(first);
    const { rows } = await worker.query<{ key: string | null }>(
      `SELECT key FROM graphile_worker._private_jobs WHERE id = $1::bigint`,
      [jobId],
    );
    expect(rows[0]?.key).toBe("jobs.add-job-lock-race-test:raced");
  });
});
