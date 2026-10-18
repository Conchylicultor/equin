import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { DEAD_JOBS_ARCHIVE_CAP } from "../../core/resources";
import { deadJobPredicate, jobNameExpr, queueJobsFrom } from "./introspection";
import { defineJob, type EnqueueTx } from "../../server/internal/registry";
import { ownedWorkflowRunIds } from "../../server/internal/run-identity";
import { emitQueueActivity } from "./slot-ledger";
import { deleteWorkflowLogs } from "../../server/internal/workflow-log";

const PurgedRowSchema = z.object({
  id: z.string(),
  job_name: z.string(),
  baked_run_id: z.string().nullable(),
});

// Bound on the durable archive so it can't itself accumulate unbounded.
// Every reconcile enforces BOTH: rows older than the TTL are dropped, and the
// archive is trimmed to the newest `DEAD_JOBS_ARCHIVE_CAP` rows (declared in
// core beside the `deadJobs` collection, whose `maxLimit` it also is).
const ARCHIVE_TTL = "30 days";

// Archive-then-purge permanently-failed graphile jobs. graphile-worker never
// GCs jobs that exhausted `max_attempts`, so they sit in `_private_jobs`
// forever (one backlog per worktree DB fork). We copy each dead row into the
// durable `dead_jobs` table (idempotent via PK ON CONFLICT), delete it from the
// queue, then bound the archive by TTL + cap. Mirrors the raw-SQL style of
// `sweepOnce` in stuck-lock-sweeper.ts.
//
// "dead" = exhausted retries AND not currently locked (`attempts >= max_attempts
// AND locked_at IS NULL`) — never reap a row a worker is actively running.
//
// `database` is the worktree database in production; a test hands it a
// throwaway one.
export async function reconcileDeadJobs(
  database: EnqueueTx = db,
): Promise<void> {
  await database.transaction(async (tx) => {
    // Archive: insert dead queue rows into dead_jobs. ON CONFLICT DO NOTHING
    // keeps this safe to run on every boot / re-fork.
    await tx.execute(sql`
      INSERT INTO dead_jobs (id, job_name, input, attempts, max_attempts, last_error, died_at)
      SELECT j.id::text,
             ${jobNameExpr},
             j.payload->'input',
             j.attempts,
             j.max_attempts,
             j.last_error,
             j.updated_at
        FROM ${queueJobsFrom}
       WHERE ${deadJobPredicate}
      ON CONFLICT (id) DO NOTHING
    `);

    // Purge: delete the archived rows from the queue — and the step/wait logs
    // of the runs that die with them. A row that died WITHOUT a final dispatch
    // (its worker was killed on the last attempt, then reclaimed past its
    // budget) never reached `dispatch()`'s own teardown, so nothing else would
    // ever delete its log. Only row-owned run ids are touched — see
    // `ownedWorkflowRunIds` for why a baked (keyed / resume) id is left alone.
    // Same transaction: the log goes exactly when the row does.
    const purged = await executeRows(tx, {
      label: "dead-job-gc: purge",
      row: PurgedRowSchema,
      query: sql`
      DELETE FROM graphile_worker._private_jobs j
       USING graphile_worker._private_tasks t
       WHERE t.id = j.task_id
         AND ${deadJobPredicate}
      RETURNING j.id::text AS id,
                ${jobNameExpr} AS job_name,
                j.payload->>'workflowRunId' AS baked_run_id
    `,
    });
    await deleteWorkflowLogs(tx, ownedWorkflowRunIds(purged));

    // Bound the archive: drop rows past the TTL.
    await tx.execute(sql`
      DELETE FROM dead_jobs
       WHERE archived_at < now() - (${ARCHIVE_TTL})::interval
    `);

    // Bound the archive: keep only the newest DEAD_JOBS_ARCHIVE_CAP rows.
    await tx.execute(sql`
      DELETE FROM dead_jobs
       WHERE id IN (
         SELECT id FROM dead_jobs
          ORDER BY archived_at DESC
          OFFSET ${DEAD_JOBS_ARCHIVE_CAP}
       )
    `);
  });

  // dead_jobs is public (the change feed moves the dead-jobs collection on the
  // insert/delete above), but the purge from graphile_worker._private_jobs is
  // outside the feed and sends no notification → announce it.
  emitQueueActivity();
}

// Scheduled dead-job GC. `perWorktree: true` is REQUIRED here and is the inverse
// of the usual main-only default: each worktree runs its own backend against its
// own DB fork, which has its own `graphile_worker` tables, so dead rows
// accumulate per-DB and must be reaped per-DB. This is NOT recovery infra (it
// doesn't fix a wedged worker — unlike stuck-lock-sweeper, which therefore stays
// a setInterval), so routing it through graphile's own scheduled queue is correct
// and satisfies the no-polling rule.
export const deadJobGcJob = defineJob({
  name: "jobs.dead-gc",
  description:
    "Moves permanently failed jobs out of the live queue into a bounded archive so they stay inspectable without clogging it.",
  // One transaction of bounded indexed statements against the queue and the
  // archive.
  //
  // DO NOT "correct" this to `minutes` on the strength of its measured hold.
  // This job was profiled holding a slot for 77 SECONDS while doing 254 ms of
  // work — the other 76.8 s was blocked on `background-tx-acquire`, an admission
  // gate entered AFTER graphile had already handed it a slot. The class
  // describes the WORK, not the hold; the hold is a separate defect, and it is
  // the one `queue-slot-blocked` exists to name.
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 * * * *", perWorktree: true },
  run: () => reconcileDeadJobs(),
});
