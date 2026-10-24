# A superseded job row is not a dead job

## Context

On 2026-09-12 at 17:00, a main deploy restarted the backend while the hourly
worktree reaper was running. The Job queue then showed a **dead job**
(`dead_jobs` id 1302207, 5 of 5 attempts, no error), and the health row turned
amber. Nothing had failed: a newer run of the same job finished the sweep two
minutes later.

What happened, step by step:

1. Job row A is running. The backend restarts, so A's process dies. A's row is
   still marked locked.
2. Before the stuck-lock sweeper notices (it runs every 60 s), the same job is
   queued again with the same key. For the reaper, that is its own startup code.
3. graphile's `add_jobs` (`sql/000018.sql:103-116`) sees a locked row with that
   key. It cannot update a locked row, so it inserts a new row B. It also
   **retires** A: `key = null, attempts = max_attempts`.
4. The sweeper releases A. A now matches `deadJobPredicate` (`attempts >=
   max_attempts AND locked_at IS NULL`). So it is archived to `dead_jobs`,
   reported as `queue-dead-job`, and counted in the health row.

The same false "dead" label is reachable two more ways. Both start with a row
retired while it was locked:

- **Graceful shutdown times out.** graphile's `failJobs` unlocks the row and
  writes a shutdown `last_error`. The row then looks dead, with an error.
- **A live overrun fails.** The run is still going when the same key is queued
  again, then it throws. graphile's `fail_job` leaves it dead. This is
  documented as accepted today in `worker.ts:193-198`.

In all three cases a newer copy of the job exists and will run, so the old row
is **superseded**, not dead. The goal: recognise it and drop it, without hiding
any genuinely dead job.

## Why the evidence must be captured at the moment of retirement

After the fact, a retired row is indistinguishable from a genuinely dead one.
graphile's retire UPDATE touches only `key`, `attempts` and `updated_at`. It
does not bump `revision` or touch `flags`.

"Key is now null on a keyed job" is **not** a safe signature on its own. graphile
retires *every* unavailable row with that key, including a genuinely dead one.
For a scheduled job, the next cron tick would clear the key of every real
dead-letter and hide it. The 09-09 to 09-11 deadline failures would have
vanished from the dead list.

The one fact that separates the two is **whether the row was locked when it
was retired**. That is only observable inside the retire UPDATE itself.

## Approach

### 1. Mark the row at retirement: a trigger on graphile's job table

In the jobs plugin, install a row-level `BEFORE UPDATE` trigger on
`graphile_worker._private_jobs`:

```sql
WHEN (OLD.locked_at IS NOT NULL AND OLD.key IS NOT NULL AND NEW.key IS NULL)
-- sets NEW.flags = coalesce(NEW.flags, '{}') || '{"singularity.superseded": true}'
```

- The `WHEN` clause means the function never runs on ordinary fetch, complete or
  fail updates. Only graphile's retire-while-locked writes match. That covers
  both `add_jobs` and `remove_job` on a running row, and both mean "a newer
  intent replaced this run".
- `flags` is graphile's own jsonb column. It only affects fetching when
  `forbiddenFlags` is configured, and we configure none (checked:
  `rg forbiddenFlags` finds nothing). The row already has `attempts =
  max_attempts`, so it is never fetched anyway.
- A dead row retired while **unlocked** (the cron-tick case above) does not
  match, so it stays dead.

**Install** it in `installQueueSchema`
(`plugins/infra/plugins/jobs/server/internal/queue-schema.ts`), right after
`runGraphileMigrations`. That is the one place every database gets its queue
schema: main's boot, a graphile version bump, and `createTestDb` throwaways.
Worktree forks copy the DDL, including the trigger, and every backend calls this
at boot anyway.

The install must be idempotent. Use `CREATE OR REPLACE FUNCTION`, and create or
replace the trigger **only when it is missing or its definition differs** (read
`pg_trigger` / `pg_get_triggerdef`). Otherwise every boot would take a table
lock while the outgoing backend's workers are still fetching.

### 2. One shared predicate, excluded from "dead"

In `plugins/infra/plugins/jobs/server/internal/introspection.ts`, which owns the
graphile coupling:

- Add `supersededExpr` (`j.flags ? 'singularity.superseded'`), the only place
  the flag name is spelled. The trigger SQL imports the same constant.
- Change `deadJobPredicate` to add `AND NOT <supersededExpr>`. Every consumer
  inherits the change with no edits of its own: `dead-job-gc.ts` (archive),
  `queryDeadJobStats` (the `queue-dead-job` report), `queryRecentDeadJobs` (the
  health row), and the pulse.
- `loadJobsList` (`resources.ts`) skips unlocked superseded rows, so Debug →
  Queue never shows one as "dead" in the seconds before it is swept. A locked
  superseded row is still a live run and keeps showing as "running".

### 3. The sweeper drops superseded rows instead of re-queueing them

In `plugins/infra/plugins/jobs/server/internal/stuck-lock-sweeper.ts`, before
the existing release UPDATE:

- **Superseded, and its owner is dead** (locked past `LOCK_ACQUIRE_GRACE` with no
  advisory lock held): `DELETE` it. Report it the way reclaims are reported
  today, because a worker died holding it. The wording must be right: "dropped
  X (job N): its worker died mid-run and a newer copy was already queued". Today
  the release path would say "re-queueing", which is wrong for this row.
- **Superseded and already unlocked** (the graceful-shutdown and failed-overrun
  cases): `DELETE` it with one line on the jobs log channel and no report. The
  run's real failure, if there was one, was already reported by `dispatch()`
  (`worker.ts:650`).
- The existing queue-lock half then runs unchanged. A serial lane held by a
  deleted superseded row has no live holder, so it is reclaimed as it is today.

Leave the step and wait logs alone. For a keyed direct enqueue, the old and new
rows share one `workflowRunId`, so the log now belongs to the newer row. Its
replay of completed steps is the ordinary resume behaviour.

### 4. Docs and comments

- `plugins/infra/plugins/jobs/CLAUDE.md`: a short "Superseded rows" section
  covering the retire-while-locked rule, why it has to be a trigger (the
  evidence exists only inside the UPDATE), and why "key is null" alone would
  hide real dead-letters.
- `worker.ts:193-198`: the overrun paragraph now says a failing superseded run
  is reported and dropped, no longer dead-lettered.
- The stuck-lock sweeper header: the new delete branch.

## Out of scope

- Moving the reaper and `database.fork` to detached runs:
  `task-1789458096651-ms5ha2`.
- The crash-report fingerprint and re-alert bug: `task-1789456782728-16f3bl`.
  Until that lands, the sweeper's "dropped" report still falls into the stackless
  crash bucket, like every reclaim report today.
- Changing graphile's retirement behaviour itself.

## Verification

1. **Unit test on a throwaway database** (`createTestDb` + `installQueueSchema`,
   next to `queue-schema.test.ts`), using graphile's own `add_job` SQL:
   - A keyed row that is locked, then re-queued with the same key: the old row
     is flagged and fails `deadJobPredicate`.
   - A keyed row that is dead (`attempts = max`, unlocked), then re-queued: it is
     **not** flagged and still matches `deadJobPredicate`. This is the negative
     arm that proves real dead-letters stay visible.
   - Ordinary fetch, complete and fail updates never flag.
   - Running `installQueueSchema` twice is a no-op the second time.
2. **End-to-end harness**, a new `POST /api/events-test/superseded` modelled on
   `crash-recovery.ts`. Queue a keyed job whose handler blocks. Hold its advisory
   lock on a direct client, queue the same key again, destroy the socket, then
   `UNSAFE_sweepStuckLocks()`. Assert: the old row is deleted (not released),
   no row matches the dead predicate, and the new row runs to completion.
3. `./equin test plugins/infra/plugins/jobs`, then `./equin build`.
   Call the harness on this worktree's deploy, and `query_db` the worktree
   database to confirm the trigger exists.
