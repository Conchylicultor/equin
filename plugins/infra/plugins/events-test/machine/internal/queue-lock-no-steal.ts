import { sql as drizzleSql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { connectionString } from "@plugins/database/plugins/admin/server";
import { createDbClient } from "@plugins/database/plugins/connection/server";
import { db } from "@plugins/database/server";
import {
  queryRunningJobs,
  UNSAFE_sweepStuckLocks,
} from "@plugins/infra/plugins/jobs/machine";
import { fixed, retryUntil } from "@plugins/packages/plugins/retry/core";
import {
  fail,
  readQueueLock,
  readSerialRows,
} from "../../server/internal/queue-probe";
import {
  releaseAllGates,
  resetSerialLane,
  serialProbe,
  serialRunLog,
} from "../../server/internal/serial-job";

// The queue-level twin of `crash-recovery.ts`, and the assertion that guards the
// riskiest part of the `serial` design.
//
// `serial` made the stuck-lock sweeper responsible for a second lock. graphile
// releases a queue's lock in its own success/fail handlers, which a SIGKILLed
// worker never reaches — and graphile's own recovery for that hardcodes four
// hours (`resetLockedAt.js:12`). So without a sweep, the first crash after
// adopting named queues leaves a lane locked and every job in it unrunnable for
// four hours. Hence `sweepOnce()` now clears `_private_job_queues` too.
//
// That is a reclaim, and a reclaim of the wrong row is corruption: clear the lock
// on a queue whose job is genuinely still running, and a second job enters the
// queue alongside it — the serialization guarantee gone, silently. It is the same
// class of bug as the 5-minute timestamp lease that stole ~25 live jobs in 8 days
// (research/2026-07-30-jobs-exact-liveness-advisory-locks.md). So the queue sweep
// is gated on the same evidence as the job sweep — no session holds an advisory
// lock over any of the queue's own jobs — and never on the age of `q.locked_at`.
//
// One run asserts both halves, in order:
//
//   1. NO-STEAL (negative) — a queue whose job's advisory lock is held by a LIVE
//      connection survives a forced sweep, however long it has been locked, and
//      no second job in that queue is fetched. This is the important one.
//   2. RECLAIM (positive) — that connection dies ⇒ the sweep frees the queue and
//      the job waiting behind it runs.
//
// The setup mirrors crash-recovery's exactly: a dedicated direct-Postgres client
// takes the advisory lock and later has its socket destroyed underneath it, and
// `locked_at` is back-dated only past the sweeper's 30-second ACQUISITION grace —
// the window between graphile's `get_job` stamping the row and `withJobLock`
// taking the lock. Back-dating is what stops the grace from being what the
// assertions measure: in both halves the queue is unambiguously past it, so only
// the advisory lock decides the outcome.
//
// NOTE: not using implement() — the assertions return raw Response objects.

/** Same forged age as crash-recovery, and for the same reason: comfortably past
 * `LOCK_ACQUIRE_GRACE` (30s) so the grace is not what is being tested. */
const FORGED_LOCK_AGE = "2 minutes";

/** How long the follower is given to (not) escape a locked queue. The assertion
 * here is that something does NOT happen, so the window is the test — graphile
 * is notified of the insert immediately and would fetch within milliseconds if
 * the queue lock were not stopping it. */
const ESCAPE_WINDOW_MS = 1_000;

/** Liveness as the rest of the system sees it — the jobs plugin's own public
 * introspection read, not a private query written for the test. */
async function readRunning(jobId: string): Promise<{ alive: boolean } | null> {
  const running = await queryRunningJobs();
  return running.find((r) => r.jobId === jobId) ?? null;
}

export async function handleQueueLockNoSteal(): Promise<Response> {
  resetSerialLane();
  const run = `queue-lock-${randomUUID()}`;
  const victimLabel = `${run}#victim`;
  const followerLabel = `${run}#follower`;

  // Far future so the live worker cannot claim the victim before we forge it —
  // we want the row claimed by our stand-in, not by a real worker whose lock
  // connection we have no business destroying.
  const farFuture = new Date(Date.now() + 60 * 60 * 1000);
  await serialProbe.enqueue(
    { run, label: victimLabel, hold: false },
    { runAt: farFuture },
  );

  const enqueued = await readSerialRows(run);
  const victim = enqueued.find((r) => r.label === victimLabel);
  if (!victim) {
    return fail("setup", "enqueued victim row not found", { rows: enqueued });
  }
  if (victim.queueId === null) {
    return fail(
      "setup",
      "the victim row has job_queue_id IS NULL — it is not in a serialization queue at all, so there is no queue lock to test",
      { victim },
    );
  }
  const queueId = victim.queueId;
  const jobId = victim.jobId;

  // The stand-in worker. A dedicated `pg.Client` is one Postgres session, which
  // is what an advisory lock is scoped to — and it must be DIRECT Postgres
  // (5433, what `connectionString()` returns), never pgbouncer's transaction
  // pooling, which would hand the lock to a shared backend.
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
      "[queue-lock-no-steal] lock-holder connection failed before the simulated crash",
      err,
    );
  });

  try {
    await holder.connect();
    connected = true;
    await holder.query("SELECT pg_advisory_lock($1::bigint)", [jobId]);

    // Make the row AND its queue look claimed, exactly as graphile's `get_job`
    // leaves them (it stamps both in one statement) — except back-dated past the
    // acquisition grace.
    await db.execute(drizzleSql`
      UPDATE graphile_worker._private_jobs
         SET locked_at = now() - ${FORGED_LOCK_AGE}::interval,
             locked_by = 'simulated-worker',
             attempts = 1,
             run_at = now() - interval '1 second'
       WHERE id = ${jobId}::bigint
    `);
    await db.execute(drizzleSql`
      UPDATE graphile_worker._private_job_queues
         SET locked_at = now() - ${FORGED_LOCK_AGE}::interval,
             locked_by = 'simulated-worker'
       WHERE id = ${queueId}::int
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

    // Setup gates: the harness is vacuous unless the lock was really taken and
    // the queue really looks locked before anything is swept.
    const claimed = await readRunning(jobId);
    if (!claimed) {
      return fail("setup", "forged row is not visible as a running job", {
        jobId,
      });
    }
    if (!claimed.alive) {
      return fail(
        "setup",
        "advisory lock was acquired but the row does not read as alive — the pg_locks key encoding and pg_try_advisory_lock(<job id>::bigint) have drifted apart",
        { jobId },
      );
    }
    const forgedQueue = await readQueueLock(queueId);
    if (!forgedQueue?.locked) {
      return fail("setup", "the queue row does not read as locked", {
        queueId,
        forgedQueue,
      });
    }

    // The job that must stay stuck behind the locked queue.
    await serialProbe.enqueue({ run, label: followerLabel, hold: false });

    // ── Case 1 (negative): a LIVE holder must never be swept ────────────────
    await UNSAFE_sweepStuckLocks();

    const survivedJob = await readRunning(jobId);
    if (!survivedJob) {
      return fail(
        "no-steal",
        "the sweeper reclaimed a row whose advisory lock is held by a LIVE connection — a running job would have been double-dispatched",
        { jobId },
      );
    }
    if (!survivedJob.alive) {
      return fail("no-steal", "row still locked but no longer reads as alive", {
        jobId,
      });
    }

    const survivedQueue = await readQueueLock(queueId);
    if (!survivedQueue?.locked) {
      // The corruption case: the lane is now open while its occupant is still
      // running, so graphile is free to fetch a second job into it.
      return fail(
        "no-steal",
        "the sweeper cleared a serialization queue whose job is still held by a LIVE advisory lock — a second job can now enter the queue alongside the running one, and the serialization guarantee is gone",
        { queueId, queueName: survivedQueue?.queueName ?? null },
      );
    }

    // ...and the observable consequence: nothing behind that queue moves.
    const escaped = await retryUntil(
      async () => {
        const rows = await readSerialRows(run);
        const follower = rows.find((r) => r.label === followerLabel);
        if (!follower) return { gone: true as const };
        return follower.locked ? { gone: false as const } : null;
      },
      { delay: fixed(50), deadline: ESCAPE_WINDOW_MS, onDeadline: () => null },
    );
    if (escaped) {
      return fail(
        "no-steal",
        escaped.gone
          ? "a second job in the locked queue ran to completion while the queue's occupant was still live"
          : "a second job in the locked queue was fetched into a worker slot while the queue's occupant was still live",
        { followerLabel, rows: await readSerialRows(run) },
      );
    }
    if (serialRunLog.some((e) => e.label === followerLabel)) {
      return fail(
        "no-steal",
        "the follower's handler ran while its queue was still locked by a live holder",
        { log: serialRunLog.filter((e) => e.run === run) },
      );
    }

    // ── Case 2 (positive): the holder dies ──────────────────────────────────
    // Destroy the socket rather than calling `end()`: no Terminate message, no
    // graceful close — the same thing a SIGKILLed worker does to its
    // connections. Postgres notices the peer is gone, tears the backend down,
    // and releases its session locks as part of that teardown.
    killed = true;
    holder.connection.stream.destroy();

    const released = await retryUntil(
      async () => {
        const still = await readRunning(jobId);
        // Gone from the running set counts as released too: the background
        // sweeper ticks every 60s and may beat our explicit sweep to the
        // reclaim, which it can only do once the lock is actually absent.
        return still === null || !still.alive ? true : null;
      },
      { delay: fixed(50), deadline: 5_000, onDeadline: () => false },
    );
    if (!released) {
      return fail(
        "crash",
        "the advisory lock outlived its connection — Postgres did not release it within 5s of the socket dying",
        { jobId },
      );
    }

    await UNSAFE_sweepStuckLocks();
    // Read for the record, NOT as the assertion. Once the queue is free the live
    // worker re-locks it to run the very jobs that were waiting, so
    // `locked_at IS NULL` here is a race by construction. The conclusive
    // observation is the drain below: with graphile's strategy-2 fetch
    // (`getJob.js:72-88`) a job in a locked queue can never be fetched, so a
    // follower that runs proves the queue lock was released.
    const afterSweep = await readQueueLock(queueId);

    const drained = await retryUntil(
      async () => {
        const ran = serialRunLog.filter(
          (e) => e.run === run && e.phase === "finished",
        );
        return ran.length >= 2 ? ran.map((e) => e.label) : null;
      },
      { delay: fixed(100), deadline: 10_000, onDeadline: () => null },
    );
    if (!drained) {
      return fail(
        "reclaim",
        "the queue did not drain within 10s of the sweep — the reclaimed queue never let its waiting jobs through",
        {
          queueId,
          afterSweep,
          rows: await readSerialRows(run),
          log: serialRunLog.filter((e) => e.run === run),
        },
      );
    }

    return Response.json({
      ok: true,
      run,
      jobId,
      queueId,
      queueName: survivedQueue.queueName,
      queueLockedAfterSweep: afterSweep?.locked ?? null,
      drained,
    });
  } finally {
    // Every early return above leaves a live session holding the advisory lock;
    // a leaked one would wedge this job id — and, through it, this whole lane —
    // for the rest of the process's life. Dropping the holder puts the forged
    // locks back under the sweeper's ordinary rule, so the 60s background tick
    // reclaims both the row and its queue with no special-case cleanup.
    if (connected && !killed) {
      killed = true;
      holder.connection.stream.destroy();
    }
    releaseAllGates();
  }
}
