import { sql as drizzleSql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { connectionString } from "@plugins/database/plugins/admin/server";
import { createDbClient } from "@plugins/database/plugins/connection/server";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import {
  queryRecentDeadJobs,
  queryRunningJobs,
  UNSAFE_sweepStuckLocks,
} from "@plugins/infra/plugins/jobs/machine";
import { fixed, retryUntil } from "@plugins/packages/plugins/retry/core";
import { fail } from "../../server/internal/queue-probe";

// End-to-end check that a SUPERSEDED row is dropped, not dead-lettered — the
// incident of 2026-09-12 replayed on purpose (research/
// 2026-09-15-jobs-superseded-rows-are-not-dead.md).
//
// What happened then: a deploy restarted the backend while the hourly worktree
// reaper was mid-run. Its startup code queued the reaper again under the same
// key before the stuck-lock sweeper noticed the dead worker, so graphile's
// `add_jobs` retired the running row (`key = null, attempts = max_attempts`) and
// inserted a fresh one. The sweeper then RELEASED the retired row, which left it
// exactly the shape of a dead job — archived, reported as `queue-dead-job`, and
// counted amber in the health row — although a newer run finished the work two
// minutes later.
//
// One run asserts, in order:
//
//   1. SUPERSEDE (setup) — a keyed row locked by a live stand-in worker is
//      retired by graphile when the same key is queued again.
//   2. NO-STEAL (negative) — a superseded row whose advisory lock is still held
//      is a live run, and a forced sweep must leave it alone.
//   3. DROP (positive) — the holder dies ⇒ the forced sweep DELETES the row. A
//      row that is still there, unlocked, is the old behaviour ("reclaimed …
//      re-queueing"), and is the regression this endpoint exists to catch.
//   4. NOT DEAD — no row of this job appears among dead jobs (live or archived)
//      since the run started, through the jobs plugin's own public read.
//   5. SUCCESSOR — the newer row runs to completion, and the retired one never
//      runs at all.
//
// The stand-in worker is crash-recovery's: a dedicated direct-Postgres client
// takes the advisory lock and later has its socket destroyed. A real handler
// cannot be used as the victim, because its lock lives on the jobs plugin's own
// connection, which this harness has no business killing.
//
// The real-dead-letter half (a DEAD row re-queued under its key stays dead) is
// not repeated here: asserting it end to end would leave a genuine dead job on
// the deploy, reported and archived like any other. It is pinned on a throwaway
// database instead, in jobs/server/internal/superseded-trigger.test.ts.
//
// NOTE: not using implement() — the assertions return raw Response objects.

/** Same forged age as crash-recovery, and for the same reason: comfortably past
 * the sweeper's `LOCK_ACQUIRE_GRACE` (30s) so the grace is not what is being
 * tested — only the advisory lock decides the outcome. */
const FORGED_LOCK_AGE = "2 minutes";

const JOB_NAME = "events_test.superseded";

interface SupersededRunEntry {
  run: string;
  label: string;
  jobId: string;
}

/** Which rows actually ran, in memory. Not persisted — a restart wipes it. */
const supersededRunLog: SupersededRunEntry[] = [];

/** A keyed job — the key is the harness run, so both rows of one run share it
 * and two runs never do. Its handler only records that it ran. */
export const supersededProbe = defineJob({
  name: JOB_NAME,
  description:
    "Test probe that checks a job row replaced by a newer run is dropped rather than reported as a dead job.",
  hold: "instant",
  input: z.object({ run: z.string(), label: z.string() }),
  event: z.never(),
  dedup: { key: (input) => input.run },
  run: ({ input, ctx }) => {
    supersededRunLog.push({
      run: input.run,
      label: input.label,
      jobId: ctx.jobId,
    });
  },
});

const JobRowSqlSchema = z.object({
  key: z.string().nullable(),
  locked: z.boolean(),
  attempts: z.number(),
  max_attempts: z.number(),
  // Graphile's jsonb flags, carried only so a failing verdict shows them.
  flags: z.unknown(),
});
type JobRowState = z.infer<typeof JobRowSqlSchema>;

/** One `_private_jobs` row, or null once it is gone. */
async function readJobRow(jobId: string): Promise<JobRowState | null> {
  const rows = await executeRows(db, {
    label: "superseded: job row",
    row: JobRowSqlSchema,
    query: drizzleSql`
    SELECT j.key                        AS key,
           (j.locked_at IS NOT NULL)    AS locked,
           j.attempts::int              AS attempts,
           j.max_attempts::int          AS max_attempts,
           j.flags                      AS flags
      FROM graphile_worker._private_jobs j
     WHERE j.id = ${jobId}::bigint
  `,
  });
  return rows[0] ?? null;
}

/** Liveness as the rest of the system sees it — the jobs plugin's own public
 * introspection read, not a private query written for the test. */
async function readRunning(jobId: string): Promise<{ alive: boolean } | null> {
  const running = await queryRunningJobs();
  return running.find((r) => r.jobId === jobId) ?? null;
}

export async function handleSuperseded(): Promise<Response> {
  const run = `superseded-${randomUUID()}`;
  const victimLabel = `${run}#victim`;
  const successorLabel = `${run}#successor`;
  // Dead rows are read back from this instant on, so a leftover from an earlier
  // failed run of this endpoint cannot fail this one. A second of slack covers
  // the database clock and this process's clock disagreeing by a little.
  const startedAt = Date.now() - 1_000;

  // Far future so the live worker cannot claim the victim before we forge it —
  // it must be held by our stand-in, not by a real worker.
  const farFuture = new Date(Date.now() + 60 * 60 * 1000);
  const { jobId: victimId } = await supersededProbe.enqueue(
    { run, label: victimLabel },
    { runAt: farFuture },
  );

  // The stand-in worker. One `pg.Client` is one Postgres session, which is what
  // an advisory lock is scoped to — and it must be DIRECT Postgres (5433, what
  // `connectionString()` returns), never pgbouncer's transaction pooling.
  //
  // Built by `createDbClient` (`events-test`) like every backend connection, so
  // its connect and lock statement carry the deadline. Killing its socket below
  // is the scenario, not a lost call: nothing is pending on it at that moment.
  const holder = createDbClient({
    name: "events-test",
    connectionString: connectionString(),
  });
  let connected = false;
  let killed = false;
  const preKillErrors: unknown[] = [];
  // The socket is ripped out deliberately below; that read error IS the
  // scenario. An error BEFORE that is a genuine setup failure and is collected
  // so it can be reported rather than swallowed (an unhandled 'error' event on a
  // pg Client would otherwise take the server down).
  holder.on("error", (err) => {
    if (killed) return;
    preKillErrors.push(err);
    console.error(
      "[superseded] lock-holder connection failed before the simulated crash",
      err,
    );
  });

  try {
    await holder.connect();
    connected = true;
    await holder.query("SELECT pg_advisory_lock($1::bigint)", [victimId]);

    // Make the row look claimed, exactly as graphile's `get_job` leaves it —
    // except back-dated past the acquisition grace.
    await db.execute(drizzleSql`
      UPDATE graphile_worker._private_jobs
         SET locked_at = now() - ${FORGED_LOCK_AGE}::interval,
             locked_by = 'simulated-worker',
             attempts = 1,
             run_at = now() - interval '1 second'
       WHERE id = ${victimId}::bigint
    `);

    if (preKillErrors.length > 0) {
      return fail(
        "setup",
        "lock-holder connection died before the test began",
        {
          detail: preKillErrors.map(String),
        },
      );
    }

    const claimed = await readRunning(victimId);
    if (!claimed?.alive) {
      return fail(
        "setup",
        claimed
          ? "advisory lock was acquired but the row does not read as alive — the pg_locks key encoding and pg_try_advisory_lock(<job id>::bigint) have drifted apart"
          : "forged row is not visible as a running job",
        { victimId },
      );
    }

    // ── 1. Supersede: queue the same key while the victim is running ────────
    // Due now, so the live worker picks the successor up straight away — the
    // restart-then-requeue ordering of the incident.
    const { jobId: successorId } = await supersededProbe.enqueue({
      run,
      label: successorLabel,
    });
    if (successorId === victimId) {
      return fail(
        "supersede",
        "the second enqueue collapsed onto the running row instead of inserting a new one — graphile no longer retires a locked row on re-queue, so there is no superseded row to test",
        { victimId },
      );
    }
    const retired = await readJobRow(victimId);
    if (
      !retired ||
      retired.key !== null ||
      retired.attempts < retired.max_attempts
    ) {
      return fail(
        "supersede",
        "graphile did not retire the running row (expected key = null and attempts = max_attempts)",
        { victimId, successorId, retired },
      );
    }

    // ── 2. No-steal: a superseded row with a LIVE holder is a live run ──────
    await UNSAFE_sweepStuckLocks();

    const survived = await readJobRow(victimId);
    if (!survived) {
      return fail(
        "no-steal",
        "the sweeper deleted a superseded row whose advisory lock is held by a LIVE connection — a running handler's row was dropped from under it",
        { victimId },
      );
    }
    if (!survived.locked) {
      return fail(
        "no-steal",
        "the sweeper released a superseded row whose advisory lock is held by a LIVE connection",
        { victimId, survived },
      );
    }

    // ── 3. Drop: the holder dies ────────────────────────────────────────────
    // Destroy the socket rather than calling `end()`: no Terminate message, no
    // graceful close — what a SIGKILLed worker does to its connections.
    killed = true;
    holder.connection.stream.destroy();

    const released = await retryUntil(
      async () => {
        const still = await readRunning(victimId);
        // Gone from the running set counts too: the background sweeper ticks
        // every 60s and may beat the forced sweep below to the drop, which it
        // can only do once the lock is actually absent.
        return still === null || !still.alive ? true : null;
      },
      { delay: fixed(50), deadline: 5_000, onDeadline: () => false },
    );
    if (!released) {
      return fail(
        "crash",
        "the advisory lock outlived its connection — Postgres did not release it within 5s of the socket dying",
        { victimId },
      );
    }

    await UNSAFE_sweepStuckLocks();

    const afterSweep = await readJobRow(victimId);
    if (afterSweep) {
      return fail(
        "drop",
        afterSweep.locked
          ? "the sweep left a superseded row whose worker is dead locked — it was neither dropped nor reclaimed"
          : "the sweep RELEASED a superseded row instead of deleting it — it now has the shape of a dead job and will be archived and reported as queue-dead-job, although a newer copy was queued. If `flagsAtRetirement` is null, the retirement was never recorded: the superseded-row trigger is missing from this database",
        { victimId, afterSweep, flagsAtRetirement: retired.flags },
      );
    }

    // ── 4. Not dead: the public dead-job read never saw this job ────────────
    // `queryRecentDeadJobs` reads both places a death can be — still in
    // graphile's table (through `deadJobPredicate`) and already archived to
    // `dead_jobs` — so a released-then-archived victim fails here too.
    const deaths = (
      await queryRecentDeadJobs({ since: startedAt, limit: 1000 })
    ).filter((d) => d.jobName === JOB_NAME);
    if (deaths.length > 0) {
      return fail(
        "not-dead",
        "a superseded row was counted as a dead job — queue-dead-job and the health row would report a failure that did not happen",
        { victimId, deaths },
      );
    }

    // ── 5. Successor: the newer row does the work, the victim never runs ────
    const successorRan = await retryUntil(
      async () => {
        const ran = supersededRunLog.some(
          (e) => e.run === run && e.label === successorLabel,
        );
        // Completed means graphile deleted the row after the handler returned.
        return ran && (await readJobRow(successorId)) === null ? true : null;
      },
      { delay: fixed(100), deadline: 8_000, onDeadline: () => false },
    );
    if (!successorRan) {
      return fail(
        "successor",
        "the newer copy did not run to completion within 8s",
        {
          successorId,
          successorRow: await readJobRow(successorId),
          log: supersededRunLog.filter((e) => e.run === run),
        },
      );
    }
    if (
      supersededRunLog.some((e) => e.run === run && e.label === victimLabel)
    ) {
      return fail(
        "successor",
        "the superseded row's handler ran — it was re-dispatched although a newer copy owned the work",
        { log: supersededRunLog.filter((e) => e.run === run) },
      );
    }

    return Response.json({
      ok: true,
      run,
      victimId,
      successorId,
      victimRetired: {
        attempts: retired.attempts,
        maxAttempts: retired.max_attempts,
        flags: retired.flags,
      },
    });
  } finally {
    // Every early return above leaves a live session holding the lock; a leaked
    // one would pin the victim row for the rest of the process's life. Dropping
    // the holder puts the row back under the sweeper's ordinary rule, so the 60s
    // background tick drops (or, before step 1, reclaims) it with no special-case
    // cleanup.
    if (connected && !killed) {
      killed = true;
      holder.connection.stream.destroy();
    }
    // This run's entries have been read; dropping them keeps the log bounded by
    // the runs in flight rather than by every run since boot. Not a blanket
    // reset, so a concurrent run's entries survive.
    for (let i = supersededRunLog.length - 1; i >= 0; i--) {
      if (supersededRunLog[i]?.run === run) supersededRunLog.splice(i, 1);
    }
  }
}
