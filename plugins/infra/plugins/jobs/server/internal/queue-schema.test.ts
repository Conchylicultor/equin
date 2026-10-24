/**
 * Real-DB regression suite for the one claim this file exists to keep true:
 * **a database that has never hosted a booted backend cannot accept a
 * transactional enqueue, and `installQueueSchema` is the one call that fixes
 * that.**
 *
 * That gap is not hypothetical. Until the installer existed the only thing that
 * created the schema was a side effect of `makeWorkerUtils` — reached from the
 * non-transactional enqueue path and from `startWorkers()`, and from nowhere
 * else. So in a fresh worktree where `./equin test` ran before
 * `./equin build`, every `{ tx }` enqueue failed with a bare Postgres
 * `3F000` naming nothing in this repo — which four tasks-core tests hit and a
 * filed report mis-diagnosed as a fixture gap.
 *
 * The second describe pins the OTHER half of that story: the shape a worktree
 * database is now forked INTO. `ExcludeSchemaDataFromFork({ schema:
 * "graphile_worker", keep: ["migrations"] })` in `../index.ts` keeps graphile's
 * migration watermark and empties everything else, and the whole fork design
 * rests on graphile accepting that as already-installed. That claim is
 * graphile's behaviour, not the fork's, so it is checked here.
 *
 * Both arms run against a throwaway database (`db-test-fixture`), and the app's
 * migration chain is deliberately NOT run: the queue schema is graphile's own
 * and independent of ours, so a database with zero app tables is exactly the
 * right substrate for proving one call makes it enqueue-capable.
 *
 * Run: `./equin test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { taskFor } from "../../core/hold";
import { installQueueSchema, QueueSchemaMissingError } from "./queue-schema";
import { defineJob } from "./registry";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "queue_schema_test" });
});

afterAll(async () => {
  await t.drop();
});

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test (see
 * `clusters.test.ts`'s identical helper), so this asserts the rejection for
 * real and hands back the error to pin its class.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/**
 * A job defined but deliberately never `register()`ed — registration is a
 * separate step, and `enqueue` does not read the registry (graphile resolves
 * the handler at pickup time, which only starts in `onReady`). Nothing in this
 * process runs a worker, so `run` is never dispatched; it throws to make that
 * loud if the assumption ever stops holding.
 */
const job = defineJob({
  name: "jobs.queue-schema-test",
  description: "Test job.",
  hold: "instant",
  dedup: "none",
  input: z.object({ marker: z.string() }),
  event: z.never(),
  run: () => {
    throw new Error(
      "[jobs] queue-schema-test job was dispatched; this suite starts no worker",
    );
  },
});

describe("installQueueSchema", () => {
  test("without it, a transactional enqueue fails as QueueSchemaMissingError", async () => {
    const err = await rejection(
      t.db.transaction((tx) => job.enqueue({ marker: "before" }, { tx })),
    );
    // By INSTANCE, never by message text: the message is prose meant for a
    // human and is free to change, and `jobs:no-raw-addjob` forbids this file
    // from spelling the SQL function whose absence produced it anyway.
    expect(err).toBeInstanceOf(QueueSchemaMissingError);
  });

  test("after it, the same enqueue lands a row on the throwaway database", async () => {
    await installQueueSchema(t.connectionString);

    const { jobId } = await t.db.transaction((tx) =>
      job.enqueue({ marker: "after" }, { tx }),
    );
    expect(jobId).toMatch(/^\d+$/);

    // Read the row back through graphile's own `jobs` view — the queue is a
    // real queue now, not just a schema that exists.
    const res = await t.db.execute<{ id: string; task_identifier: string }>(
      sql`SELECT id::text AS id, task_identifier
          FROM graphile_worker.jobs
          WHERE id = ${jobId}::bigint`,
    );
    expect(res.rows[0]?.id).toBe(jobId);
    // The row sits on the hold class's OWN task (`taskFor(job.hold)`), not the
    // legacy widest-tier one — so this also witnesses that the tx transport is
    // still deriving its columns from the job's spec. Read through `taskFor`
    // rather than spelled out: `core/hold.ts` is the one file allowed to spell
    // a graphile task identifier.
    expect(res.rows[0]?.task_identifier).toBe(taskFor("instant"));
  });

  test("is idempotent — a second install leaves the queue usable", async () => {
    await installQueueSchema(t.connectionString);

    const { jobId } = await t.db.transaction((tx) =>
      job.enqueue({ marker: "again" }, { tx }),
    );
    expect(jobId).toMatch(/^\d+$/);
  });
});

/**
 * The shape a WORKTREE database is forked into, and the claim the fork design
 * rests on: graphile's own `migrations` table carried over, every other table in
 * its schema emptied.
 *
 * That is exactly what `ExcludeSchemaDataFromFork({ schema: "graphile_worker",
 * keep: ["migrations"] })` produces — one `--exclude-table-data` per graphile
 * table except that one — so the DDL and the migration watermark survive while
 * main's pending jobs and `known_crontabs.last_execution` watermarks do not.
 *
 * Reproduced by truncating rather than by running a real fork, deliberately: the
 * claim under test is graphile's ("a populated watermark over empty tables reads
 * as installed"), and `pg_dump`'s ability to skip a table's data is not in
 * doubt. It also keeps the suite on a throwaway database — no 2 GB copy of main,
 * and no dependency on what main's database happens to hold.
 */
describe("a fork-shaped queue schema", () => {
  test("is already installed, and accepts a transactional enqueue", async () => {
    const forked = await createTestDb({ prefix: "queue_schema_forked" });
    try {
      // Stand in for main: a database a backend has booted against, holding a
      // job row the fork must NOT inherit.
      await installQueueSchema(forked.connectionString);
      await forked.db.transaction((tx) =>
        job.enqueue({ marker: "mains-pending-job" }, { tx }),
      );

      const emptied = await forked.db.execute<{ tablename: string }>(
        sql`SELECT tablename FROM pg_tables
             WHERE schemaname = 'graphile_worker' AND tablename <> 'migrations'`,
      );
      expect(emptied.rows.length).toBeGreaterThan(0);
      for (const { tablename } of emptied.rows) {
        await forked.db.execute(
          sql.raw(`TRUNCATE graphile_worker."${tablename}" CASCADE`),
        );
      }

      // The watermark is the whole point of the keep-list: without it graphile
      // boots believing it is unmigrated and re-issues CREATE TABLE against
      // tables that already exist.
      const watermark = await forked.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM graphile_worker.migrations`,
      );
      expect(Number(watermark.rows[0]?.n)).toBeGreaterThan(0);

      // What a backend does on boot. On this database it must be a no-op rather
      // than a re-migration — if it throws, the keep-list is wrong.
      await installQueueSchema(forked.connectionString);

      const { jobId } = await forked.db.transaction((tx) =>
        job.enqueue({ marker: "the-forks-own-job" }, { tx }),
      );
      expect(jobId).toMatch(/^\d+$/);

      // And the fork carries its OWN queue, not main's: that row is the only one.
      const rows = await forked.db.execute<{ id: string }>(
        sql`SELECT id::text AS id FROM graphile_worker.jobs`,
      );
      expect(rows.rows.map((r) => r.id)).toEqual([jobId]);
    } finally {
      await forked.drop();
    }
  });
});
