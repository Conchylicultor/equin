import { sql as drizzleSql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { connectionString } from "@plugins/database/plugins/admin/server";
import { createDbClient } from "@plugins/database/plugins/connection/server";
import {
  UNSAFE_sweepStuckLocks,
  queryRunningJobs,
} from "@plugins/infra/plugins/jobs/machine";
import { retryUntil, fixed } from "@plugins/packages/plugins/retry/core";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { logEntries, logPing, resetLog } from "../../server/internal/log-job";
import { jobTaskList } from "../../server/internal/queue-probe";

// End-to-end check that job liveness is EXACT — both halves of it.
//
// A running job's worker is "alive" iff it still holds a session-scoped Postgres
// advisory lock keyed on the graphile job id (`withJobLock`, jobs/job-lock.ts).
// Postgres releases that lock during backend teardown, so it vanishes the instant
// the owning process dies — SIGKILL, OOM-killer, panic, `process.exit()` alike —
// and cannot be forged by a frozen clock or a sleeping host. The stuck-lock
// sweeper reclaims a locked row only when that lock is genuinely absent.
//
// Both halves matter, and one run of this endpoint asserts both, in order:
//
//   1. NO-STEAL (negative) — the lock is held by a LIVE connection ⇒ the sweeper
//      leaves the row completely alone, however long it has been locked.
//   2. RECLAIM (positive) — that connection dies ⇒ the sweeper reclaims the row
//      and the handler actually re-runs.
//
// The negative case is the important one. The mechanism this replaced was a
// 5-minute timestamp lease, and *its* harness synthesized a stuck row with
// `UPDATE ... locked_at = now() - interval '6 minutes'` — a test of a timestamp
// comparison, nothing more. It could not express "held by someone still alive",
// so it passed for three months while every job that ran longer than five minutes
// (nightly backups, DB forks, `./singularity push`) had its row stolen and
// re-dispatched CONCURRENTLY with the still-running handler. Case 1 is the
// assertion that bug could not survive: the row here is two minutes "overdue" by
// every timestamp measure and must still not be touched.
//
// Setup is a real simulated death, not a forged one: a dedicated direct-Postgres
// client takes the advisory lock and then has its socket destroyed underneath it.
// `locked_at` is still back-dated — but only past the sweeper's 30-second
// *acquisition* grace (the window between graphile's `get_job` stamping the row
// and `withJobLock` taking the lock), which is a constant of the dispatch path and
// never a statement about how long a handler may run.
//
// NOTE: Not using implement() because retryUntil and error paths return raw Response objects.

// The forged lock age. Must clear the sweeper's LOCK_ACQUIRE_GRACE (30s) so the
// grace is not what the assertions are measuring — in both cases the row is
// unambiguously past it, and only the advisory lock decides the outcome.
const FORGED_LOCK_AGE = "2 minutes";

function fail(
  step: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { ok: false, step, error: detail, ...extra },
    { status: 500 },
  );
}

// Liveness as the rest of the system sees it: the jobs plugin's own public
// introspection read (`queryRunningJobs`, which joins `pg_locks`), not a private
// query written for the test. If this reports the wrong thing, Debug → Queue and
// the queue-health MCP tool report the wrong thing too.
async function readRunning(jobId: string): Promise<{ alive: boolean } | null> {
  const running = await queryRunningJobs();
  return running.find((r) => r.jobId === jobId) ?? null;
}

export async function handleCrashRecovery(): Promise<Response> {
  resetLog();
  const label = `crash-recovery-${randomUUID()}`;

  const farFuture = new Date(Date.now() + 60 * 60 * 1000);
  await logPing.enqueue({ label }, { runAt: farFuture });

  // Find the row by payload — addJob doesn't return the private-table id.
  const rows = await executeRows(db, {
    label: "crash-recovery: locate enqueued row",
    // Uncast `_private_jobs.id` is `bigint`, which pg hands back as a string.
    row: z.object({ id: z.string() }),
    query: drizzleSql`
    SELECT id FROM graphile_worker._private_jobs
     WHERE task_id IN (
       SELECT id FROM graphile_worker._private_tasks
        WHERE identifier IN (${jobTaskList})
     )
       AND payload->'input'->>'label' = ${label}
     LIMIT 1
  `,
  });
  const row = rows[0];
  if (!row) {
    return Response.json(
      { ok: false, error: "enqueued row not found" },
      { status: 500 },
    );
  }
  const jobId = row.id;

  // The stand-in worker. A dedicated `pg.Client` is one Postgres session, which
  // is what an advisory lock is scoped to — and it must be DIRECT Postgres (5433,
  // what `connectionString()` returns, the same string graphile-worker itself
  // dials). Going through pgbouncer's transaction pooling would hand the lock to
  // a shared backend and let it silently outlive, or vanish under, this test.
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
  // We rip this socket out deliberately below; the resulting read error IS the
  // scenario. An error BEFORE that is a genuine setup failure and is collected so
  // it can be reported rather than swallowed (an unhandled 'error' event on a pg
  // Client would otherwise take the server down).
  holder.on("error", (err) => {
    if (killed) return;
    preKillErrors.push(err);
    console.error(
      "[crash-recovery] lock-holder connection failed before the simulated crash",
      err,
    );
  });

  try {
    await holder.connect();
    connected = true;
    await holder.query("SELECT pg_advisory_lock($1::bigint)", [jobId]);

    // Make the row look claimed, exactly as graphile's `get_job` leaves it —
    // except back-dated well past the acquisition grace. `is_available` is a
    // generated column off `locked_at`, so this also gates the live worker from
    // claiming the row until the lock is legitimately reclaimed.
    await db.execute(drizzleSql`
      UPDATE graphile_worker._private_jobs
         SET locked_at = now() - ${FORGED_LOCK_AGE}::interval,
             locked_by = 'simulated-worker',
             attempts = 1,
             run_at = now() - interval '1 second'
       WHERE id = ${jobId}::bigint
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

    // Setup gate: the whole harness is vacuous if the lock was never really taken,
    // so prove it is visible as liveness before asserting anything about sweeps.
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

    // ── Case 1 (negative): a LIVE holder must never be swept ────────────────
    // Two minutes locked, past every grace, and still untouchable — because
    // somebody is demonstrably still running it. This is the case the old
    // timestamp lease got wrong.
    await UNSAFE_sweepStuckLocks();

    const survived = await readRunning(jobId);
    if (!survived) {
      return fail(
        "no-steal",
        "the sweeper reclaimed a row whose advisory lock is held by a LIVE connection — a running job would have been double-dispatched",
        { jobId },
      );
    }
    if (!survived.alive) {
      return fail("no-steal", "row still locked but no longer reads as alive", {
        jobId,
      });
    }
    if (logEntries.some((e) => e.label === label)) {
      return fail("no-steal", "handler ran while its lock was still held", {
        jobId,
        label,
      });
    }

    // ── Case 2 (positive): the holder dies ──────────────────────────────────
    // Destroy the socket instead of calling `end()`: no Terminate message, no
    // graceful close — the same thing a SIGKILLed worker does to its connections.
    // Postgres notices the peer is gone, tears the backend down, and releases its
    // session locks as part of that teardown.
    killed = true;
    holder.connection.stream.destroy();

    // Teardown is asynchronous on the server side, so wait for the fact rather
    // than assuming it — this also proves the lock really was tied to that
    // connection's lifetime, which is the entire premise of the design.
    const released = await retryUntil(
      async () => {
        const still = await readRunning(jobId);
        // Gone from the running set counts as released too: the background
        // sweeper ticks every 60s and may beat our explicit sweep to the reclaim,
        // which it can only do once the lock is actually absent.
        return still === null || !still.alive ? true : null;
      },
      {
        delay: fixed(50),
        deadline: 5_000,
        onDeadline: () => false,
      },
    );
    if (!released) {
      return fail(
        "crash",
        "the advisory lock outlived its connection — Postgres did not release it within 5s of the socket dying",
        { jobId },
      );
    }

    await UNSAFE_sweepStuckLocks();

    // Worker polls every 2s by default; give it enough headroom.
    return retryUntil(
      async () =>
        logEntries.some((e) => e.label === label)
          ? Response.json({ ok: true, label, jobId })
          : null,
      {
        delay: fixed(100),
        deadline: 8_000,
        onDeadline: () =>
          Response.json(
            {
              ok: false,
              step: "reclaim",
              error: "handler did not run within 8s",
              label,
              jobId,
            },
            { status: 504 },
          ),
      },
    );
  } finally {
    // Every early return above leaves a live session still holding the lock; a
    // leaked one would wedge this job id for the rest of the process's life and
    // make every later run of this endpoint fail for the wrong reason.
    if (connected && !killed) {
      killed = true;
      holder.connection.stream.destroy();
    }
  }
}
