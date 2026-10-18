import type { PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { connectionString } from "@plugins/database/plugins/admin/server";
import { queryOne } from "@plugins/database/plugins/sql-rows/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import type {
  JobQueueImpl,
  JobRowOpts,
  QueuedJob,
} from "../../server/internal/queue";
import {
  installQueueSchema,
  withQueueSchemaAssert,
} from "../../server/internal/queue-schema";
import type { JobTaskPayload } from "../../server/internal/registry";
import { graphileSpecFor } from "./graphile-routing";
import { reconcileDeadJobs } from "./dead-job-gc";
import { loadJobsList } from "./jobs-list";
import { emitQueueActivity, onQueueActivity } from "./slot-ledger";
import {
  startStuckLockSweeper,
  stopStuckLockSweeper,
} from "./stuck-lock-sweeper";
import {
  getWorkerUtils,
  installScheduledCronItems,
  refreshJobSchedules,
  startWorkers,
  stopWorkers,
} from "./worker";

/**
 * Insert one row for `job` — the ONE place a graphile row is inserted. With a
 * `tx`, on the caller's transaction (rollback drops the job with the caller's
 * writes); without, through graphile's own pool, committing independently of
 * any caller transaction.
 *
 * The two transports insert the SAME row, so both derive their graphile
 * COLUMNS from one spec — deriving them twice is how the shared-tx path would
 * quietly lose the queue name. What they do NOT share is their PRECONDITION.
 * The no-`tx` branch reaches `getWorkerUtils()`, whose `makeWorkerUtils`
 * installs the queue schema as a side effect, so it heals a database that has
 * none. The `tx` branch writes on the CALLER's own connection — it never
 * touches a graphile helper and has no business running 25 migrations inside
 * somebody else's open transaction — so it can only assert. It does, below,
 * and loudly: on a database whose backend has never booted, this path used to
 * surface as a bare `3F000` from inside `pg` that named nothing in this repo.
 * Installation belongs to whoever provisions or boots the database: `install()`
 * for a backend, `installQueueSchema()` for a throwaway test database.
 */
async function insertJobRow(
  job: QueuedJob,
  payload: JobTaskPayload,
  opts: JobRowOpts,
): Promise<{ jobId: string }> {
  if (opts.tx) {
    const insertion = graphileSpecFor(job, opts);
    // Shared-tx path: write into graphile_worker.jobs on the caller's
    // transaction client by calling Graphile's documented public SQL
    // function. Rollback drops the row alongside the caller's writes.
    // The reach-in to `_.session.client` is the only facade-piercing in
    // the system; isolated here so a future drizzle bump has exactly
    // one line to fix.
    // biome-ignore lint/suspicious/noExplicitAny: drizzle's session.client is private in d.ts but stable at runtime.
    const client = (opts.tx as any)._.session.client as PoolClient;
    // `add_job` returns exactly one row, always. `queryOne` states that, so a
    // zero-row result is a loud failure rather than an `undefined` the next
    // line has to remember to check.
    const row = await withQueueSchemaAssert(() =>
      queryOne(client, {
        // The returned `id` is `bigint`; `::text` is why this is a string.
        row: z.object({ id: z.string() }),
        sql: `SELECT (graphile_worker.add_job(
           identifier   := $1,
           payload      := $2::json,
           run_at       := $3,
           max_attempts := $4,
           job_key      := $5,
           queue_name   := $6,
           priority     := $7
         )).id::text AS id`,
        params: [
          // The hold class's task, from the same spec the `addJob` path uses —
          // never a constant. A row inserted here on the legacy task would be
          // fetchable only by the wide runner, silently forfeiting the
          // reservation for every job enqueued inside a transaction.
          insertion.task,
          JSON.stringify(payload),
          insertion.spec.runAt ?? null,
          insertion.spec.maxAttempts ?? null,
          insertion.spec.jobKey ?? null,
          // NULL ⇒ unnamed queue, which is what graphile's own default is and
          // what every non-`serial` job gets. `add_job` takes queue_name as a
          // named argument (sql/000016.sql:8), so passing NULL explicitly is
          // identical to omitting it.
          insertion.spec.queueName ?? null,
          // `priority` is likewise a named argument of `add_job`
          // (sql/000018.sql:4, `priority integer DEFAULT NULL`), coalesced to 0
          // when NULL. Always present here, since it is derived from the class.
          insertion.spec.priority ?? null,
        ],
      }),
    );
    return { jobId: row.id };
  }
  const utils = await getWorkerUtils();
  const insertion = graphileSpecFor(job, opts);
  const added = await utils.addJob(insertion.task, payload, insertion.spec);
  return { jobId: String(added.id) };
}

/** Delete the not-yet-started rows matching `match` (`locked_at IS NULL`, so an
 *  in-flight row is left to finish). graphile_worker is outside the change
 *  feed and a delete sends no notification, so the queue readers are told. */
async function cancelUnstarted(
  match: { key: string } | { keyPrefix: string },
): Promise<void> {
  if ("key" in match) {
    await db.execute(
      sql`DELETE FROM graphile_worker._private_jobs WHERE key = ${match.key} AND locked_at IS NULL`,
    );
  } else {
    await db.execute(
      sql`DELETE FROM graphile_worker._private_jobs WHERE key LIKE ${`${match.keyPrefix}%`} AND locked_at IS NULL`,
    );
  }
  emitQueueActivity();
}

/**
 * The desktop's job queue: graphile-worker in this backend's own database —
 * the three-runner hold-class ladder, the advisory job lock, cron schedules,
 * the stuck-lock sweeper and the dead-job GC. See jobs/CLAUDE.md.
 */
export const graphileQueue: JobQueueImpl = {
  enqueue: insertJobRow,
  cancelUnstarted,
  list: loadJobsList,
  async retry(jobId) {
    const utils = await getWorkerUtils();
    await utils.rescheduleJobs([jobId], { attempts: 0, runAt: new Date() });
    // graphile_worker is outside the public-schema change-feed, and a
    // reschedule sends no `jobs:insert` → announce it (jobs-list and every
    // other queue reader listen on this one signal).
    emitQueueActivity();
  },
  async cancel(jobId) {
    const utils = await getWorkerUtils();
    await utils.completeJobs([jobId]);
    // graphile_worker is outside the public-schema change-feed, and a delete
    // sends no notification → announce it.
    emitQueueActivity();
  },
  onActivity: onQueueActivity,
  // The queue schema is a property of the DATABASE, and this is where a
  // database that does not yet have one acquires it. Since the fork exclusion
  // keeps the migration watermark (jobs#machine), a worktree database arrives
  // already installed and this is one connect and one `SELECT`; what it still
  // covers is a database that never had the schema at all (main's very first
  // boot, a `createTestDb` throwaway) and a graphile version bump that adds
  // migrations.
  install: () => installQueueSchema(connectionString()),
  async start() {
    await startWorkers();
    startStuckLockSweeper();
    // Immediate boot purge of the permanently-failed backlog (idempotent; the
    // scheduled deadJobGcJob keeps it bounded thereafter). Runs after the
    // onReadyBlocking migration barrier, so dead_jobs exists. Fire-and-forget:
    // a failure surfaces as an unhandled rejection (the reports plugin files
    // it) rather than being swallowed into an invisible boot-time no-op.
    void runTracked("jobs:reconcile-dead", () => reconcileDeadJobs());
  },
  schedule: installScheduledCronItems,
  refreshSchedules: refreshJobSchedules,
  async stop() {
    stopStuckLockSweeper();
    await stopWorkers();
  },
};
