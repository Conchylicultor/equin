/**
 * Real-DB regression suite for the superseded-row trigger: **a row graphile
 * retires while it is LOCKED is marked superseded and is not a dead job; a row
 * it retires while UNLOCKED is not marked and stays dead.**
 *
 * The second half is the one that matters most. graphile retires every
 * unavailable row that shares a re-queued key, dead-lettered ones included, so a
 * signature looser than "was locked when retired" would let the next cron tick
 * of a genuinely failing job wipe it from the dead list. The negative arm below
 * is what proves real dead-letters stay visible.
 *
 * Rows are written through graphile's own SQL — `add_job` via the registry's
 * transactional enqueue, and `remove_job` — never by hand-writing the retire
 * UPDATE, so the suite tracks graphile's real behaviour across a version bump.
 * The graphile runtime's own row writes (fetch, fail) are reproduced as the
 * UPDATE shapes it issues (`dist/sql/getJob.js`, `dist/sql/failJob.js`), because
 * no worker runs in this process.
 *
 * Runs against a throwaway database (`db-test-fixture`); the app's migration
 * chain is not needed — the queue schema is graphile's own.
 *
 * Run: `./singularity test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./singularity build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { executeOne } from "@plugins/database/plugins/sql-rows/core";
import {
  deadJobPredicate,
  queueJobsFrom,
  supersededExpr,
} from "./introspection";
import { installQueueSchema } from "../../server/internal/queue-schema";
import { defineJob } from "../../server/internal/registry";
import { SUPERSEDED_TRIGGER_NAME } from "../../server/internal/superseded-trigger";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "superseded_trigger_test" });
  await installQueueSchema(t.connectionString);
});

afterAll(async () => {
  await t.drop();
});

const JOB_NAME = "jobs.superseded-trigger-test";

/**
 * A keyed job, defined but never registered — nothing in this process runs a
 * worker, so `run` throws to make a dispatch loud if that ever changes. The key
 * is the input's own `key`, so each test works on its own graphile job key.
 */
const job = defineJob({
  name: JOB_NAME,
  description: "Test job.",
  hold: "instant",
  input: z.object({ key: z.string() }),
  event: z.never(),
  dedup: { key: (input) => input.key },
  run: () => {
    throw new Error(
      "[jobs] superseded-trigger-test job was dispatched; this suite starts no worker",
    );
  },
});

/** The graphile `job_key` `enqueue()` derives for a keyed dedup. */
function graphileKey(key: string): string {
  return `${JOB_NAME}:${key}`;
}

/** Queue (or re-queue) the job under `key` through graphile's `add_job`. */
async function enqueue(key: string): Promise<string> {
  const { jobId } = await t.db.transaction((tx) =>
    job.enqueue({ key }, { tx }),
  );
  return jobId;
}

/** graphile's fetch, as `get_job` writes it: stamp the lock, count the attempt.
 * Names no `key`, like the real statement. */
async function fetchRow(id: string): Promise<void> {
  await t.db.execute(sql`
    UPDATE graphile_worker._private_jobs
       SET locked_at = now(),
           locked_by = 'superseded-trigger-test-worker',
           attempts = attempts + 1
     WHERE id = ${id}::bigint
  `);
}

/** graphile's fail path (`failJob` / the graceful-shutdown `failJobs`): record
 * the error and let go of the row. */
async function failRow(id: string): Promise<void> {
  await t.db.execute(sql`
    UPDATE graphile_worker._private_jobs
       SET last_error = 'superseded-trigger-test failure',
           run_at = greatest(now(), run_at),
           locked_by = NULL,
           locked_at = NULL
     WHERE id = ${id}::bigint
  `);
}

const RowStateSchema = z.object({
  key: z.string().nullable(),
  locked: z.boolean(),
  attempts: z.number(),
  max_attempts: z.number(),
  superseded: z.boolean(),
  dead: z.boolean(),
});
type RowState = z.infer<typeof RowStateSchema>;

/** One row, read through the SAME fragments every production reader composes —
 * `supersededExpr` and `deadJobPredicate` — so this suite asserts what
 * dead-job GC, the `queue-dead-job` report and the health row actually see. */
async function readRow(id: string): Promise<RowState> {
  return executeOne(t.db, {
    label: "superseded-trigger-test: row state",
    row: RowStateSchema,
    query: sql`
      SELECT j.key,
             (j.locked_at IS NOT NULL)  AS locked,
             j.attempts::int            AS attempts,
             j.max_attempts::int        AS max_attempts,
             ${supersededExpr}          AS superseded,
             (${deadJobPredicate})      AS dead
        FROM ${queueJobsFrom}
       WHERE j.id = ${id}::bigint
    `,
  });
}

describe("retirement while locked", () => {
  test("re-queueing the key of a running row flags it, and it is not dead", async () => {
    const running = await enqueue("requeued-while-running");
    await fetchRow(running);

    const successor = await enqueue("requeued-while-running");
    expect(successor).not.toBe(running);

    // graphile retired it — and the trigger saw that it was locked.
    const retired = await readRow(running);
    expect(retired.key).toBeNull();
    expect(retired.attempts).toBe(retired.max_attempts);
    expect(retired.locked).toBe(true);
    expect(retired.superseded).toBe(true);

    // Its run then ends on graphile's own fail path (a failing overrun, a
    // graceful-shutdown timeout). Unlocked with `attempts = max_attempts` is
    // exactly the shape that used to read as a dead job. It must not now.
    await failRow(running);
    const ended = await readRow(running);
    expect(ended.locked).toBe(false);
    expect(ended.superseded).toBe(true);
    expect(ended.dead).toBe(false);

    // The newer copy owns the key and is an ordinary pending row.
    const next = await readRow(successor);
    expect(next.key).toBe(graphileKey("requeued-while-running"));
    expect(next.superseded).toBe(false);
    expect(next.dead).toBe(false);
  });

  test("remove_job on a running row flags it too", async () => {
    const running = await enqueue("removed-while-running");
    await fetchRow(running);

    await t.db.execute(sql`
      SELECT graphile_worker.remove_job(${graphileKey("removed-while-running")})
    `);

    const retired = await readRow(running);
    expect(retired.key).toBeNull();
    expect(retired.superseded).toBe(true);

    await failRow(running);
    expect((await readRow(running)).dead).toBe(false);
  });
});

describe("real dead-letters stay dead", () => {
  test("a dead row re-queued under its key is NOT flagged and still matches deadJobPredicate", async () => {
    const died = await enqueue("dead-then-requeued");
    // Dead the way graphile leaves a row that exhausted its budget: unlocked,
    // `attempts = max_attempts`, an error recorded.
    await fetchRow(died);
    await failRow(died);
    await t.db.execute(sql`
      UPDATE graphile_worker._private_jobs
         SET attempts = max_attempts
       WHERE id = ${died}::bigint
    `);
    expect((await readRow(died)).dead).toBe(true);

    // The next tick / enqueue of the same key. graphile retires the dead row
    // too — `key = null` — which is exactly why "key is null" alone could never
    // be the superseded signature.
    const successor = await enqueue("dead-then-requeued");
    expect(successor).not.toBe(died);

    const after = await readRow(died);
    expect(after.key).toBeNull();
    expect(after.superseded).toBe(false);
    expect(after.dead).toBe(true);
  });
});

describe("ordinary row writes never flag", () => {
  test("upsert, fetch, fail, and a collapsed retry budget leave flags alone", async () => {
    const id = await enqueue("ordinary");

    // A second enqueue while it is PENDING collapses onto the same row — the
    // upsert branch of `add_jobs`, which rewrites the row but not its key.
    expect(await enqueue("ordinary")).toBe(id);
    expect((await readRow(id)).superseded).toBe(false);

    await fetchRow(id);
    expect((await readRow(id)).superseded).toBe(false);

    await failRow(id);
    expect((await readRow(id)).superseded).toBe(false);

    // `markJobPermanentlyFailed`'s shape (a NonRetryableError): the row
    // dead-letters on purpose, and must read as dead.
    await t.db.execute(sql`
      UPDATE graphile_worker._private_jobs
         SET max_attempts = attempts
       WHERE id = ${id}::bigint
    `);
    const collapsed = await readRow(id);
    expect(collapsed.superseded).toBe(false);
    expect(collapsed.dead).toBe(true);
  });
});

const CatalogStateSchema = z.object({
  trigger_oid: z.string(),
  trigger_xmin: z.string(),
  function_xmin: z.string(),
});

/** The catalog rows the installer writes. `xmin` moves on ANY rewrite of a
 * row, so an unchanged `xmin` proves the install wrote nothing — and took no
 * lock on the job table. */
async function readCatalogState(): Promise<z.infer<typeof CatalogStateSchema>> {
  return executeOne(t.db, {
    label: "superseded-trigger-test: catalog state",
    row: CatalogStateSchema,
    query: sql`
      SELECT t.oid::text  AS trigger_oid,
             t.xmin::text AS trigger_xmin,
             p.xmin::text AS function_xmin
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'graphile_worker._private_jobs'::regclass
         AND t.tgname = ${SUPERSEDED_TRIGGER_NAME}
    `,
  });
}

describe("installation", () => {
  test("installQueueSchema twice is a no-op the second time", async () => {
    const before = await readCatalogState();
    await installQueueSchema(t.connectionString);
    expect(await readCatalogState()).toEqual(before);
  });

  test("a trigger dropped out of band is reinstalled on the next install", async () => {
    await t.db.execute(
      sql.raw(
        `DROP TRIGGER ${SUPERSEDED_TRIGGER_NAME} ON graphile_worker._private_jobs`,
      ),
    );

    // Without it, a retire-while-locked is not recorded — the evidence exists
    // only inside the UPDATE, so nothing can recover it after the fact.
    const unguarded = await enqueue("while-uninstalled");
    await fetchRow(unguarded);
    await enqueue("while-uninstalled");
    expect((await readRow(unguarded)).superseded).toBe(false);

    await installQueueSchema(t.connectionString);

    const guarded = await enqueue("after-reinstall");
    await fetchRow(guarded);
    await enqueue("after-reinstall");
    expect((await readRow(guarded)).superseded).toBe(true);
  });
});
