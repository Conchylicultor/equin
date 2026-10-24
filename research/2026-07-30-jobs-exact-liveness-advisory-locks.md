# Exact job liveness via Postgres advisory locks — design

Replaces the jobs plugin's timeout-based lock recovery (`stuck-lock-sweeper.ts`) and its broken
keepalive (`lock-heartbeat.ts`) with a mechanism Postgres maintains for free.

## Context

**Observed symptom (2026-07-30):** every nightly backup in `~/.backups/singularity` exists twice —
two complete, concurrent archives per night. `backup_runs` in the `singularity` DB confirms two
`trigger: "periodic"` rows per night, the second starting ~5 min after the first while the first is
still running (07-23 `03:00:00` + `03:05:16`; 07-24 `03:00:00` + `03:05:30`; 07-29 `03:00:00` +
`03:05:08`).

**Root cause chain:**

1. `stuck-lock-sweeper.ts` ticks every 60 s and clears `locked_at`/`locked_by` on any
   `graphile_worker._private_jobs` row locked longer than `STUCK_LOCK_THRESHOLD = "5 minutes"`.
   Graphile then re-dispatches the job **while the original handler is still running**. `backup.run`
   takes 5–15 min, so it is stolen every single night. `maxAttempts: 2` is the only reason it stops
   at two.
2. `lock-heartbeat.ts` (`8e2fc64ac`, 2026-07-11) was added to prevent exactly this by renewing
   `locked_at` every 60 s. It renews `WHERE id = $jobId AND locked_by = $workerId` — and `workerId`
   is **always the literal string `"undefined"`**, so it has never renewed a single row.
   `worker.ts:107` reads `String(helpers.workerId)`, but graphile's `JobHelpers` has no `workerId`
   field (the per-job worker id is `helpers.job.locked_by`). `helpers` is typed `any`, so this was a
   silent runtime bug rather than a tsc error. Its own guard has been firing all along —
   `[jobs] lock heartbeat renewed 0 rows for job N (worker undefined)`, 185 hits in the current
   `~/.singularity/logs/singularity.log`, 372 in the previous rotation.
3. **Blast radius is not backup-specific.** Across main's last two log rotations (~8 days),
   **25 distinct jobs** crossed the 5-minute line and were therefore stolen and double-dispatched —
   roughly 3/day; the worst ran 69 minutes. Affected long jobs include the Google Drive backup
   upload, `./equin push`, DB fork / `pg_restore`, and long git checkouts. For non-idempotent
   handlers concurrent execution is a corruption hazard, not just wasted CPU.

**Why not just fix `workerId`.** That restores the intended lease, but a lease is a *timeout*, and a
timeout cannot distinguish "worker dead" from "worker frozen". Machine sleep defeats it by
construction, and that is not hypothetical — the 07-28 and 07-30 pairs both report finishing within
~3 s of each other, hours after starting (`03:07:28` and `03:57:34` both "finishing" at `10:08:3x`).
While the host sleeps no timer fires, so on wake `locked_at` is hours stale and the sweeper steals a
live job on its first tick.

**Why this deployment can do better than a timeout.** Timeouts exist in job queues because the
library cannot assume shared fate with the worker. Here it can: exactly one instance per user
(`research/2026-07-02-global-adr-single-instance-per-user.md`), one local Postgres over a unix
socket, and graphile already holds a direct-5433 connection. A **session-scoped advisory lock** is
released by Postgres the instant the owning backend goes away — SIGKILL, OOM, panic, `process.exit()`
alike — because the client socket closes and lock release is part of backend teardown. Liveness stops
being estimated from a clock and becomes a fact the database maintains.

**Prior art check.** Two research docs previously rejected Postgres advisory locks; neither objection
transfers:

- `research/2026-06-16-global-host-wide-cpu-admission-flock-broker.md:53` — "add load to the very
  resource we're protecting". That protects *host CPU*; here the protected resource **is** the
  Postgres-backed job queue, whose rows and worker connections already live in Postgres.
- `research/2026-07-10-global-worktree-db-fork-cli-and-drift.md:22` — cites the above plus pgbouncer
  tx-mode incompatibility. You cannot hold a lock inside a DB you are about to `RENAME`; we are not
  renaming, and we connect direct to 5433.

`plugins/database/plugins/pgbouncer/CLAUDE.md` already documents the routing rule this design needs:
*"adminPool, graphile-worker, pg_dump/pg_restore → Direct PG socket (5433) — LISTEN/NOTIFY, advisory
locks, subprocesses."* This will be the repo's first real advisory-lock consumer.

## Decisions taken

The user declined to arbitrate these; they are taken here and are cheap to reverse.

1. **Ship the one-line `workerId` fix first**, as its own commit, so double-runs stop tonight while
   this design is reviewed. It is deleted again in Step 3 — one throwaway commit for immediate
   correctness.
2. **A dispatch that finds the lock held defers *and* files a report.** Under this design that should
   be near-impossible, so it is a real signal. Silence is the sweeper's worst trait and is precisely
   why this bug hid for three months.
3. **Full cutover.** No timestamp threshold survives as a fallback. Two overlapping recovery paths
   with different thresholds is today's mess.

## Design

### The honest residual: a grace window that bounds *acquisition*, not *runtime*

Graphile sets `locked_at` inside `get_job`; our handler acquires the advisory lock a few ms later in
`dispatch()`. A row in that gap has `locked_at` set and no advisory lock, and would look abandoned.
So recovery keeps a small `LOCK_ACQUIRE_GRACE = 30 seconds`.

This is categorically different from today's threshold. It bounds *how long acquisition may take*, a
constant of the dispatch path, and **never grows with handler duration**. A six-hour handler is as
safe as a 200 ms one. Nothing a job author writes can violate it.

### Step 0 — interim stopgap (separate commit, later reverted)

`plugins/infra/plugins/jobs/server/internal/worker.ts:107`:

```ts
workerId: String(helpers.job.locked_by),   // was: String(helpers.workerId)
```

Also drop the `any` on `helpers` and type it as graphile's `JobHelpers` — the `any` is what turned a
type error into three months of silent double-runs.

### Step 1 — `job-lock.ts`: the lock connection

**New file** `plugins/infra/plugins/jobs/server/internal/job-lock.ts`.

One module-level `pg.Pool` built from `connectionString()`
(`plugins/database/plugins/admin/server` — direct 5433, already imported by `worker.ts:11`), sized
`max: JOB_CONCURRENCY` (4). Structurally bounded: at most one held connection per in-flight job, so a
backend adds ≤4 direct connections. Measured headroom: `max_connections = 500`, 57 in use.

Do **not** use the main `db` handle: it routes through pgbouncer on 6432 in transaction mode, which
does not preserve session state (the lock would silently vanish between statements), and holding a
`pool.connect()` lease for a whole job body would pin one of only `BACKGROUND_TX_MAX = 3` background
slots and break the deadlock proof in `plugins/database/server/internal/client.ts`, which assumes tx
leases are transaction-scoped.

```ts
// Exact liveness for a running job. Postgres releases a session-scoped advisory
// lock when the owning backend dies — no clock, no lease, no heartbeat.
export async function withJobLock<T>(
  jobId: string,
  onLost: (err: unknown) => void,
  fn: () => Promise<T>,
): Promise<T | typeof LOCK_HELD>
```

- `SELECT pg_try_advisory_lock($jobId::bigint)`. `false` → release the client, return `LOCK_HELD`.
- Register `client.on("error", onLost)` so a mid-handler connection death is loud rather than a
  silent re-entry into double-run territory.
- `finally`: `pg_advisory_unlock`, then `client.release()`. On **any** error path (including a failed
  unlock) call `client.release(true)` to destroy the connection — a destroyed session releases its
  locks unconditionally, so a lock can never be leaked back into the pool.

### Step 2 — wire it into `dispatch()`

`worker.ts`, at exactly the lines `startLockHeartbeat` / `stopHeartbeat()` occupy today (before the
`try`, released in the `finally`). That placement is already correct for all three exit paths —
success, throw, and the `isSuspendSignal` `return` — which matters because a suspended workflow
resumes as a **different graphile job row**, so the lock must be per-`jobId`, never per
`workflowRunId`.

On `LOCK_HELD`: do not run the handler. Re-schedule the tick (`reschedule_jobs`, or throw a plain
retryable error so graphile re-queues) and `reportServerError` — never return success, which would
delete the row and silently drop the tick.

### Step 3 — delete the heartbeat, rewrite the sweeper

Delete `lock-heartbeat.ts` and its `worker.ts` call sites (reverting Step 0).

`stuck-lock-sweeper.ts` keeps its shape — the raw `setInterval`, deliberately **not** a `defineJob`
(recovery infra must not depend on the queue it recovers), which is the one part of the current
design that was right. Only `sweepOnce()`'s predicate changes, from "aged" to "genuinely absent":

```sql
UPDATE graphile_worker._private_jobs j
   SET locked_at = NULL, locked_by = NULL, run_at = greatest(j.run_at, now())
 WHERE j.locked_at IS NOT NULL
   AND j.locked_at < now() - interval '30 seconds'          -- acquisition grace only
   AND NOT EXISTS (
     SELECT 1 FROM pg_locks l
      WHERE l.locktype = 'advisory'
        AND l.granted
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.objsubid = 1                                   -- single-bigint advisory key
        AND ((l.classid::bigint << 32) | l.objid::bigint) = j.id
   )
```

Drop the `_private_job_queues` sweep entirely: `defineJob`/`enqueue` expose no queue option, nothing
ever sets `queue_name`, and clearing that lock would defeat the serialization a named queue exists to
provide if one is ever adopted.

Every reclaim must `console.warn` + `reportServerError` with the job name — a silent reclaim is the
failure mode that hid this bug.

### Step 4 — dependent read sites

- `introspection.ts` → `queryRunningJobs()` reads `locked_at`/`locked_by` to answer "what is running
  and for how long". Still correct for *duration* (graphile still stamps `locked_at`), but "is it
  alive" should now join `pg_locks`. Add an `alive` column.
- `resources.ts` → `loadJobsList` display: same treatment, surfaced in Debug → Queue.
- `deadJobPredicate` / `readyPredicate` (`locked_at IS NULL`) are unaffected — they test presence,
  not age.

### Step 5 — rewrite the crash-recovery harness

`plugins/infra/plugins/events-test/server/internal/crash-recovery.ts` currently forges a stuck row by
`UPDATE ... locked_at = now() - interval '6 minutes', locked_by = 'fake-dead-worker'`. That only
tested a timestamp predicate. Replace the setup with a *real* simulated death: open a separate direct
client, `pg_advisory_lock` the job id, then destroy the connection — which is precisely what a
SIGKILLed worker does. Then call `UNSAFE_sweepStuckLocks()` and assert re-run within the existing 8 s
deadline. The `retryUntil` assertion is unchanged.

Add a second case the old harness could not express: hold the lock on a live connection, sweep, and
assert the row is **not** reclaimed.

## Files

| File | Change |
|---|---|
| `plugins/infra/plugins/jobs/server/internal/job-lock.ts` | **new** — lock pool + `withJobLock` |
| `plugins/infra/plugins/jobs/server/internal/worker.ts` | Step 0 one-liner, then swap heartbeat → `withJobLock`; type `helpers` |
| `plugins/infra/plugins/jobs/server/internal/lock-heartbeat.ts` | **delete** |
| `plugins/infra/plugins/jobs/server/internal/stuck-lock-sweeper.ts` | predicate → `pg_locks`; drop queue sweep; report every reclaim |
| `plugins/infra/plugins/jobs/server/internal/introspection.ts` | `queryRunningJobs` gains `alive` |
| `plugins/infra/plugins/jobs/server/internal/resources.ts` | surface `alive` in the queue debug list |
| `plugins/infra/plugins/events-test/server/internal/crash-recovery.ts` | real connection-death simulation + negative case |
| `plugins/infra/plugins/jobs/CLAUDE.md` | document the liveness model |
| `plugins/database/plugins/pgbouncer/CLAUDE.md` | note jobs as the first real advisory-lock consumer |

## Verification

1. `./equin build`, then confirm a clean boot: `tail ~/.singularity/logs/<worktree>.log`.
2. **Crash recovery (positive):** `POST /api/events-test/crash-recovery` — asserts a job whose lock
   connection died is re-run within 8 s. This is the existing gate, now testing the real mechanism.
3. **No-steal (negative, new):** hold the lock live, force `UNSAFE_sweepStuckLocks()`, assert the row
   survives. This is the case that would have caught the original bug.
4. **Long-job soak — the actual regression test.** Enqueue a job that sleeps 12 min (well past both
   the old 5-min threshold and the new 30-s grace) and assert via `query_db` that it runs **exactly
   once**:
   ```sql
   SELECT id, locked_at, locked_by FROM graphile_worker._private_jobs WHERE id = <id>;
   ```
   Watch `locked_at` stay stamped once and never be cleared mid-run.
5. **Lock hygiene:** after the soak, assert no advisory locks leak —
   `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'` returns to baseline, and the lock pool
   holds ≤ `JOB_CONCURRENCY` connections (`SELECT count(*) FROM pg_stat_activity WHERE datname = …`).
6. **Suspend/resume:** exercise an `events-test` workflow that hits `ctx.waitFor`, confirming the lock
   is released on the suspend path (step 5's advisory-lock count returns to baseline while the
   workflow is suspended, not after it resumes).
7. **End-to-end:** wait one nightly cycle, then confirm a single folder in `~/.backups/singularity`
   and one `backup_runs` row:
   ```sql
   SELECT started_at, finished_at, status FROM backup_runs ORDER BY started_at DESC LIMIT 5;
   ```

## Out of scope

- **Gateway-informed recovery** (the gateway is each backend's parent and already `cmd.Wait()`s at
  `gateway/worktree.go:943`, so it knows authoritatively when a backend dies). Explicitly dropped —
  the advisory lock already covers it, and this would couple the jobs plugin to the gateway.
- Backfilling / de-duplicating the existing double backups in `~/.backups/singularity`.
- `maxAttempts: 2` on `backup.run` — worth revisiting once double-runs stop, but not part of this.
