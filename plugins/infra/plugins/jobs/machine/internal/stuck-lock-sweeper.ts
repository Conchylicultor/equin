import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { defineTimer } from "@plugins/infra/plugins/background/plugins/timer/server";
import { jobLockHeldExpr, jobNameExpr, supersededExpr } from "./introspection";
import { jobsLog } from "./jobs-log";
import type { EnqueueTx } from "../../server/internal/registry";
import { ownedWorkflowRunIds } from "../../server/internal/run-identity";
import { emitQueueActivity } from "./slot-ledger";
import { discardWorkflowLogs } from "../../server/internal/workflow-log";

// Recovery floor for jobs that were mid-execution when their worker died
// uncleanly (SIGKILL, OOM-killer, kernel panic, `process.exit()` from a
// buggy handler — anything that bypasses our SIGTERM/SIGINT shutdown path).
//
// Clean restarts are already handled: `runner.stop()` waits for in-flight
// handlers to finish, so locks clear naturally. This sweeper is the
// safety net for the rest.
//
// Why we need it at all: graphile-worker 0.16.6 hardcodes the lock-recovery
// threshold to 4 hours in SQL (`resetLockedAt.js:12`, `sql/000005.sql:124`) and
// exposes no runtime override, so a crashed worker's jobs sit unrunnable for up
// to 4h. We run our own reclaim instead; it races harmlessly with graphile's.
//
// WHAT CHANGED, and why it is not a tuning knob any more: this used to reclaim a
// row because its `locked_at` was OLD (5 minutes). An age cannot distinguish a
// dead worker from a busy one, so every handler that ran longer than the
// threshold — a large upload, a `pg_dump`/`pg_restore`, a `./singularity push`,
// a long git checkout — had its still-live work reclaimed and re-dispatched
// CONCURRENTLY with itself. It now reclaims a row because a worker is provably
// NOT running it: no session holds its advisory lock (`jobLockHeldExpr`), a fact
// Postgres maintains and releases as part of backend teardown. See
// `job-lock.ts` and `research/2026-07-30-jobs-exact-liveness-advisory-locks.md`.
//
// A reclaim RELEASES the row so graphile runs it again — except for a
// SUPERSEDED row (`supersededExpr`): one graphile retired mid-run because a
// newer copy of the same job key was queued. That copy owns the work, so a
// superseded row whose run is over (unlocked, or locked with no live lock) is
// DELETED instead of released. Released, it would read as a dead job. See
// jobs/CLAUDE.md, "Superseded rows", and `superseded-trigger.ts`.
//
// Why this is a timer and NOT a scheduled `defineJob`: it is the
// recovery mechanism FOR the job system. Routing it through graphile's own
// queue would mean a wedged worker (the exact failure this clears) couldn't
// run its own recovery — a deadlock. Infra that recovers the job system must
// not depend on the job system.

// The ONE residual timestamp in this design, and it does NOT bound handler
// runtime — it bounds ACQUISITION LATENCY, which is a constant of the dispatch
// path. Graphile stamps `locked_at` inside `get_job`; `withJobLock` takes the
// advisory lock a few milliseconds later in `dispatch()`. A row observed inside
// that window has `locked_at` set and no lock yet, and would otherwise look
// abandoned. So we only consider rows whose lock has had this long to appear.
//
// Read that difference carefully before touching this constant: a six-hour
// handler is exactly as safe as a 200 ms one, because nothing here grows with
// handler duration and nothing a job author writes can violate it. If a job
// ever looks "stuck", the answer is never to raise this number.
const LOCK_ACQUIRE_GRACE = "30 seconds";
const SWEEP_INTERVAL_MS = 60_000;

export const stuckLockSweeperTimer = defineTimer({
  name: "jobs.stuck-lock-sweep",
  description:
    "Frees jobs whose worker died mid-run, so they run again within a minute instead of sitting locked for hours.",
  everyMs: SWEEP_INTERVAL_MS,
  run: () =>
    // eslint-disable-next-line promise-safety/no-bare-catch
    sweepOnce().catch((err) => {
      console.warn("[jobs] stuck-lock sweep failed", err);
    }),
});

export function startStuckLockSweeper(): void {
  stuckLockSweeperTimer.start();
}

export function stopStuckLockSweeper(): void {
  stuckLockSweeperTimer.stop();
}

const ReclaimedRowSchema = z.object({
  id: z.string(),
  job_name: z.string(),
});

const ReclaimedQueueRowSchema = z.object({
  queue_name: z.string(),
});

const DroppedRowSchema = z.object({
  id: z.string(),
  job_name: z.string(),
  // Read off the row as it was BEFORE the delete (RETURNING sees the old
  // tuple): locked ⇒ its worker died holding it; unlocked ⇒ its run had
  // already ended on graphile's own fail or shutdown path.
  owner_died: z.boolean(),
  // The payload's baked run id, if any — see `ownedWorkflowRunIds`.
  baked_run_id: z.string().nullable(),
});

// Exported for the events-test harnesses (crash-recovery, queue-lock-no-steal,
// superseded), which force a sweep instead of waiting up to a minute for the
// next tick.
//
// TWO locks are swept here, in the same tick and on the same evidence: the job
// row's, and — since `defineJob({ serial })` landed — the row's named QUEUE.
//
// This file used to say the opposite, and it is worth recording why, because the
// reasoning was correct at the time and stopped being correct for a reason that
// is easy to miss. It said queue locks are deliberately not swept, because
// "nothing ever sets `queue_name`" (true until `serial` existed) and because
// "if a named queue is ever adopted, clearing its lock would defeat the
// serialization that is the entire reason to have one" (true of the AGE-based
// sweeper this file used to be — an age cannot tell a busy queue from an
// abandoned one, so an age-gated queue sweep really would let a second job into
// a queue whose first job was still running). Neither half survives a
// LIVENESS-gated sweep: `serial` sets `queue_name`, and a queue whose jobs hold
// no advisory lock has no live occupant to protect.
//
// Not sweeping it is what would be dangerous now. graphile releases a queue lock
// in its own fail/success handlers, which a SIGKILLed worker never reaches; the
// row is then locked by a process that no longer exists, `is_available` is
// false, and `get_job` (dist/sql/getJob.js:72-74) refuses to fetch ANY job in
// that queue. graphile's own recovery hardcodes a 4-hour threshold
// (`resetLockedAt.js:12`), so the first crash after adopting named queues would
// wedge every job in the lane for four hours — a new outage, strictly worse than
// the one `serial` was introduced to fix.
//
// `database` is the worktree database in production; a test hands it a
// throwaway one.
export async function sweepOnce(database: EnqueueTx = db): Promise<void> {
  // The superseded half, FIRST. A superseded row (`supersededExpr`) was retired
  // by graphile while it was running, because a newer copy of the same job was
  // queued — see jobs/CLAUDE.md, "Superseded rows". Its work is owned by that
  // newer copy, so once its own run is over there is nothing left to do with it:
  // it is deleted, never released. Releasing it is what used to happen, and it
  // turned the row into a false dead job (retired rows already carry `attempts =
  // max_attempts`), filed as `queue-dead-job` and archived to `dead_jobs`.
  // (graphile's `remove_job` on a running row flags it too — the key was
  // withdrawn rather than re-queued, which equally means "do not run this
  // again". No production path calls it; the report wording below assumes the
  // re-queue case that does happen.)
  //
  // "Its run is over" is the same evidence as everywhere else in this file:
  //   · already unlocked — graphile's fail path or a graceful-shutdown timeout
  //     (`failJobs`) let go of it; or
  //   · locked, past the acquisition grace, with NO live advisory lock — its
  //     worker died mid-run. A superseded row whose lock is still held is a live
  //     run and is left alone exactly like any other locked row.
  //
  // A serial lane held by a row deleted here has no live holder any more, so the
  // queue half below reclaims it on the same tick, unchanged.
  const dropped = await executeRows(database, {
    label: "stuck-lock-sweep: superseded",
    row: DroppedRowSchema,
    query: sql`
    DELETE FROM graphile_worker._private_jobs j
     WHERE ${supersededExpr}
       AND (
             j.locked_at IS NULL
          OR (j.locked_at < now() - ${LOCK_ACQUIRE_GRACE}::interval
              AND NOT ${jobLockHeldExpr})
           )
    RETURNING j.id::text AS id,
              ${jobNameExpr} AS job_name,
              (j.locked_at IS NOT NULL) AS owner_died,
              j.payload->>'workflowRunId' AS baked_run_id
  `,
  });

  // The dropped rows' step/wait logs go with them: no dispatch will ever finish
  // these runs, and the newer copy is a different row and so a different run.
  // A row whose worker died never reached `dispatch()`'s teardown, so without
  // this its log would leak. Row-owned run ids only (`ownedWorkflowRunIds`
  // says why); never throws, so a cleanup failure cannot stop the reclaims
  // below.
  await discardWorkflowLogs(ownedWorkflowRunIds(dropped), database);

  for (const row of dropped) {
    if (row.owner_died) {
      // Reported like a reclaim, because it IS one as far as backend health
      // goes: a worker died holding this row. Only the ending differs — the
      // newer copy does the work, so this row is not re-run.
      const message = `[jobs] dropped ${row.job_name} (job ${row.id}) — locked with no live advisory lock holder; its worker died mid-run and a newer copy was already queued, so it is not re-run`;
      console.warn(message);
      reportServerError({ message, stack: null });
    } else {
      // No report. The run ended on graphile's own fail or shutdown path, and a
      // real failure there was already reported by `dispatch()` (worker.ts); this
      // is only the tidy-up of a row whose work a newer copy has taken over.
      jobsLog.publish(
        `dropped superseded ${row.job_name} (job ${row.id}) — its run already ended and a newer copy was queued while it ran`,
      );
    }
  }

  // `NOT supersededExpr` makes this UPDATE's "re-queueing" true by construction.
  // A row retired between the DELETE above and this statement would otherwise be
  // released here and reported as re-queued, when it can never run again; left
  // locked, it is dropped — with the right wording — on the next tick.
  const reclaimed = await executeRows(database, {
    label: "stuck-lock-sweep: jobs",
    row: ReclaimedRowSchema,
    query: sql`
    UPDATE graphile_worker._private_jobs j
       SET locked_at = NULL,
           locked_by = NULL,
           run_at = greatest(j.run_at, now())
     WHERE j.locked_at IS NOT NULL
       AND j.locked_at < now() - ${LOCK_ACQUIRE_GRACE}::interval
       AND NOT ${jobLockHeldExpr}
       AND NOT ${supersededExpr}
    RETURNING j.id::text AS id, ${jobNameExpr} AS job_name
  `,
  });

  // Every reclaim is reported, never merely counted. A reclaim means a worker
  // died holding this row — real information about the health of this backend —
  // and a SILENT reclaim is precisely the failure mode that let the age-based
  // sweeper steal live jobs unnoticed for three months.
  for (const row of reclaimed) {
    const message = `[jobs] reclaimed ${row.job_name} (job ${row.id}) — locked with no live advisory lock holder; its worker died mid-run, re-queueing`;
    console.warn(message);
    reportServerError({ message, stack: null });
  }

  // The queue half. Same rule as above, one indirection out: a queue lock is
  // abandoned when NO job in that queue is being run by a live worker. So the
  // evidence is `jobLockHeldExpr` again — correlated over the queue's own jobs
  // via `j.job_queue_id = q.id` — never the age of `q.locked_at`.
  //
  // `LOCK_ACQUIRE_GRACE` appears here for exactly the reason it appears above and
  // for no other: graphile stamps the queue's `locked_at` inside `get_job`, at
  // the same instant it stamps the job's, and `withJobLock` takes the advisory
  // lock a few milliseconds later in `dispatch()`. A queue observed inside that
  // window has a lock stamped and no advisory lock yet. It bounds ACQUISITION
  // LATENCY, a constant of the dispatch path — it is not a lease, it does not
  // grow with handler duration, and a queue whose job has run for six hours is
  // exactly as protected as one whose job started 200 ms ago, because the
  // advisory lock is what protects it.
  //
  // We clear `locked_at`/`locked_by` only. `is_available` is a GENERATED STORED
  // column (`sql/000011.sql:40`: `(locked_at is null)`) and Postgres recomputes
  // it — writing to it is an error, and reading it as separate state would let
  // the two disagree.
  const reclaimedQueues = await executeRows(database, {
    label: "stuck-lock-sweep: queues",
    row: ReclaimedQueueRowSchema,
    query: sql`
    UPDATE graphile_worker._private_job_queues q
       SET locked_at = NULL,
           locked_by = NULL
     WHERE q.locked_at IS NOT NULL
       AND q.locked_at < now() - ${LOCK_ACQUIRE_GRACE}::interval
       AND NOT EXISTS (
             SELECT 1
               FROM graphile_worker._private_jobs j
              WHERE j.job_queue_id = q.id
                AND j.locked_at IS NOT NULL
                AND ${jobLockHeldExpr}
           )
    RETURNING q.queue_name AS queue_name
  `,
  });

  // Reported for the same reason job reclaims are, and it is the stronger case:
  // a stuck queue lock is silent by construction (no row looks locked, no slot
  // looks held — the lane simply stops draining), so if this reclaim did not
  // announce itself there would be nothing at all to read afterwards.
  for (const row of reclaimedQueues) {
    const message = `[jobs] reclaimed serialization queue "${row.queue_name}" — locked with no live advisory lock holder on any of its jobs; the worker holding it died, unblocking the queue`;
    console.warn(message);
    reportServerError({ message, stack: null });
  }

  // A reclaim turns a locked row back into a ready one, and a reclaimed queue
  // turns every row behind it from "queued behind a lane" into "waiting for a
  // slot". Neither UPDATE sends a notification → announce it. Only when
  // something moved: the sweeper ticks every minute and an empty sweep changed
  // nothing a reader could see.
  if (dropped.length > 0 || reclaimed.length > 0 || reclaimedQueues.length > 0)
    emitQueueActivity();
}
