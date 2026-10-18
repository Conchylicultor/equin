import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  ALL_JOB_TASKS,
  HOLD_CLASSES,
  HoldClassSchema,
  holdForTask,
  pickupTargetMsFor,
  type HoldClass,
} from "../../core/hold";
import { isSlotForfeited } from "./forfeit";
import { SUPERSEDED_FLAG } from "../../server/internal/superseded-trigger";

// THE single home for the graphile-internals coupling. Every read of the queue —
// dead-job reaping (dead-job-gc.ts) and the read-only introspection API below —
// composes these fragments, so the job task scope, the
// `payload->>'jobName'` encoding, the `_private_jobs`/`_private_tasks` table
// names, and the "terminally dead" predicate can never drift across call sites.

// Every Singularity job is stored under one of this plugin's graphile tasks (one
// per hold class, plus the legacy task); the real job name lives in the payload.
// `(unknown)` guards the (theoretical) row with no jobName.
export const jobNameExpr = sql`coalesce(j.payload->>'jobName', '(unknown)')`;

// The live-queue source: the graphile job table joined to its task table.
export const queueJobsFrom = sql`graphile_worker._private_jobs j
  JOIN graphile_worker._private_tasks t ON t.id = j.task_id`;

// Scope to this plugin's graphile tasks (all job states, not just dead). The
// list is composed from `ALL_JOB_TASKS` rather than named here — a class added
// to the table widens every read in this file for free. `IN (…)` over one bound
// param per task, not `= ANY(…)`: drizzle expands a list into separate params,
// and `ANY` wants a single array value.
export const jobTaskScope = sql`t.identifier IN (${sql.join(
  ALL_JOB_TASKS.map((task) => sql`${task}`),
  sql`, `,
)})`;

// A row's hold class, read off the task it sits on. Built by mapping over the
// class table (via `holdForTask`, which also owns the legacy task's `minutes`
// reading) so it cannot drift from it: nothing below restates a task name or a
// class name. Lives here with `jobLockHeldExpr` because it is graphile coupling
// — `_private_tasks.identifier` is the only place the class is recorded.
//
// The `::text` on each result is not decoration: every branch is a bound param,
// and a CASE whose arms are all untyped params leans on Postgres's
// "all-unknown resolves to text" rule. Saying it outright is cheaper than
// relying on it.
export const jobHoldExpr = sql`CASE ${sql.join(
  ALL_JOB_TASKS.map(
    (task) => sql`WHEN t.identifier = ${task} THEN ${holdForTask(task)}::text`,
  ),
  sql` `,
)} END`;

// "A newer intent replaced this run": the row was retired by graphile while it
// was locked. It is NOT a dead job — a newer copy exists and will run — so it is
// excluded from `deadJobPredicate` below and dropped by the stuck-lock sweeper
// once its run is over.
//
// The `coalesce` is load-bearing, not tidiness: `flags` is NULL on almost every
// row, `NULL ? '…'` is NULL, and `NOT NULL` is NULL — so without it, `AND NOT
// supersededExpr` would silently exclude every ordinary row from "dead" and
// hide every genuine dead-letter. Correlated on `j` like every other fragment.
export const supersededExpr = sql`coalesce(j.flags ? ${SUPERSEDED_FLAG}, false)`;

// "Dead" = our task AND exhausted retries AND not currently locked AND not
// superseded. Never reap/aggregate a row a worker is actively running.
//
// The superseded exclusion is why a restart that lands mid-run no longer files
// a dead job. graphile's retirement writes exactly the columns a dead row has
// (`attempts = max_attempts`, key cleared), so once the row is unlocked it is
// indistinguishable from a real failure — except for the flag, which only a
// retirement WHILE LOCKED sets. A dead row retired while unlocked (the next cron
// tick of a job that genuinely dead-lettered) carries no flag and stays dead.
export const deadJobPredicate = sql`${jobTaskScope}
  AND j.attempts >= j.max_attempts
  AND j.locked_at IS NULL
  AND NOT ${supersededExpr}`;

// "Ready" = eligible to run right now but not yet picked up: overdue, unlocked,
// and still within its retry budget. The single home for the ready predicate,
// shared by the aggregate backlog snapshot and the per-jobName attribution.
export const readyPredicate = sql`j.run_at <= now() AND j.locked_at IS NULL AND j.attempts < j.max_attempts`;

// "Queued behind a held serial lane": the row sits in a named queue
// (`defineJob({ serial })`) whose lock is taken, so graphile's `get_job` will
// not fetch it however many slots are free — it waits for its lane, by design,
// not for a slot. Correlated on `j` like every other fragment here, so a reader
// composes it without changing its FROM clause.
const behindHeldLaneExpr = sql`(j.job_queue_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM graphile_worker._private_job_queues q
     WHERE q.id = j.job_queue_id
       AND q.locked_at IS NOT NULL
  ))`;

// "Waiting for a worker slot": ready, and NOT held back by its lane. The one
// definition of a row the pool is failing to serve — what a queue-health verdict
// may colour on. Rows behind a lane are counted separately and never coloured:
// counting them would turn a correctly-serialized lane into an alarm.
const waitingForSlotPredicate = sql`${readyPredicate} AND NOT ${behindHeldLaneExpr}`;

// A row's class pickup target (`pickupTargetMsFor`), read off its task the same
// way `jobHoldExpr` reads the class — mapped over the class table, never
// restated.
const jobPickupTargetMsExpr = sql`CASE ${sql.join(
  ALL_JOB_TASKS.map(
    (task) =>
      sql`WHEN t.identifier = ${task} THEN ${pickupTargetMsFor(holdForTask(task))}::float8`,
  ),
  sql` `,
)} END`;

// A timestamptz as epoch milliseconds, NULL-preserving. `::bigint` comes back
// from pg as a string (see `toEpochMs`).
function epochMsExpr(expr: SQL): SQL {
  return sql`(extract(epoch FROM ${expr}) * 1000)::bigint`;
}

function toEpochMs(value: string | null): number | null {
  return value === null ? null : Number(value);
}

// "A worker is provably still running this row": a granted, session-scoped
// advisory lock keyed on the graphile job id exists in THIS database. That lock
// is taken by `withJobLock` (job-lock.ts) for exactly the handler's lifetime and
// released by Postgres itself the instant the owning backend goes away — SIGKILL,
// OOM-killer, kernel panic, `process.exit()` alike — because lock release is part
// of backend teardown. So this is a FACT the database maintains, not an estimate
// off a clock: unlike `locked_at` it cannot go stale, and host sleep (which
// freezes every timer we own) cannot forge it.
//
// The key encoding must match `pg_try_advisory_lock(<graphile job id>::bigint)`
// byte for byte: the single-bigint form splits its key across `classid` (high 32
// bits) and `objid` (low 32 bits) and marks it `objsubid = 1` (the two-int form
// uses 2), and advisory locks are database-scoped, so the `datname` guard keeps
// one worktree's fork from reading a sibling fork's locks. That encoding is
// precisely the kind of detail that drifts once it is copied per call site, so
// it lives here with the rest of the graphile coupling and is composed, never
// re-typed. Correlated on `j` like every other fragment in this file.
export const jobLockHeldExpr = sql`EXISTS (
    SELECT 1
      FROM pg_locks l
     WHERE l.locktype = 'advisory'
       AND l.granted
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND l.objsubid = 1
       AND ((l.classid::bigint << 32) | l.objid::bigint) = j.id
  )`;

// One terminally-dead row per distinct jobName: how many, the worst-case attempt
// counters, the latest error, and a sample graphile job id for hand-inspection.
export interface DeadJobStat {
  jobName: string;
  deadCount: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  sampleJobId: string | null;
}

const DeadJobStatRowSchema = z.object({
  job_name: z.string(),
  dead_count: z.number(),
  attempts: z.number(),
  max_attempts: z.number(),
  last_error: z.string().nullable(),
  sample_job_id: z.string().nullable(),
});

// Read-only: terminally-dead jobs in the live queue, grouped by jobName.
export async function queryDeadJobStats(): Promise<DeadJobStat[]> {
  const rows = await executeRows(db, {
    label: "queryDeadJobStats",
    row: DeadJobStatRowSchema,
    query: sql`
    SELECT ${jobNameExpr}                                          AS job_name,
           count(*)::int                                           AS dead_count,
           max(j.attempts)::int                                    AS attempts,
           max(j.max_attempts)::int                                AS max_attempts,
           (array_agg(j.last_error ORDER BY j.updated_at DESC))[1] AS last_error,
           (array_agg(j.id::text ORDER BY j.updated_at DESC))[1]   AS sample_job_id
      FROM ${queueJobsFrom}
     WHERE ${deadJobPredicate}
     GROUP BY 1
  `,
  });
  return rows.map((r) => ({
    jobName: r.job_name,
    deadCount: r.dead_count,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lastError: r.last_error,
    sampleJobId: r.sample_job_id,
  }));
}

// Collapse a job's retry budget to the attempts already spent, so the next
// graphile `get_job` scan skips it (`attempts < max_attempts` is now false) and
// it falls straight into the terminally-dead set above — `deadJobPredicate`
// holds the instant graphile's fail handler clears the lock. This is the
// supported way to dead-letter a DETERMINISTIC failure after a single attempt
// instead of burning the full retry budget on a payload that will never parse.
// Lives here, beside `deadJobPredicate`, because it exists precisely to satisfy
// it. Targeted single-row write by id — no task join needed.
export async function markJobPermanentlyFailed(jobId: string): Promise<void> {
  await db.execute(sql`
    UPDATE graphile_worker._private_jobs
       SET max_attempts = attempts
     WHERE id = ${jobId}::bigint
  `);
}

// The same depth/stall numbers as {@link QueueBacklogStat}, for ONE hold class.
// A class's ready work can only be drained by the runners whose task list serves
// it (`reachableSlots(hold)`), so "how deep is the queue" is a per-class question
// as well as a global one.
export interface QueueClassBacklogStat {
  hold: HoldClass;
  readyCount: number;
  lockedCount: number;
  oldestOverdueMs: number;
}

// A single aggregate snapshot of the queue's depth/stall state, plus the same
// broken out per hold class. The rollup fields are unchanged and stay the whole
// queue — existing consumers keep parsing — and `classes` always carries one
// entry per class in `HOLD_CLASSES`, zeroed when that class has no rows.
export interface QueueBacklogStat {
  readyCount: number;
  lockedCount: number;
  oldestOverdueMs: number;
  classes: QueueClassBacklogStat[];
}

const QueueBacklogRowSchema = z.object({
  // A `CASE`-derived text column, checked against the real class list rather
  // than asserted into it — a `jobHoldExpr` branch that ever fell through to
  // something else used to mistype the row in silence.
  hold: HoldClassSchema,
  ready_count: z.number(),
  locked_count: z.number(),
  // bigint comes back from pg as a string; coerced to number below.
  oldest_overdue_ms: z.string(),
});

// Read-only: queue depth/stall metrics. readyCount = overdue, unlocked,
// retry-eligible; lockedCount = currently running; oldestOverdueMs = age of the
// oldest ready job.
//
// ONE grouped query, summed in TS, rather than a rollup query beside a grouped
// one: the total is then the sum of the parts by construction, and cannot
// disagree with them across two round-trips. `oldestOverdueMs` rolls up as a max
// (the oldest of the per-class oldests IS the global oldest), the counts as sums.
export async function queryQueueBacklog(): Promise<QueueBacklogStat> {
  const rows = await executeRows(db, {
    label: "queryQueueBacklog",
    row: QueueBacklogRowSchema,
    query: sql`
    SELECT ${jobHoldExpr}                                          AS hold,
           count(*) FILTER (WHERE ${readyPredicate})::int           AS ready_count,
           count(*) FILTER (WHERE j.locked_at IS NOT NULL)::int     AS locked_count,
           coalesce(
             extract(epoch FROM (
               now() - min(j.run_at) FILTER (WHERE ${readyPredicate})
             )) * 1000,
             0
           )::bigint AS oldest_overdue_ms
      FROM ${queueJobsFrom}
     WHERE ${jobTaskScope}
     GROUP BY 1
  `,
  });

  const byHold = new Map<HoldClass, QueueClassBacklogStat>(
    HOLD_CLASSES.map((hold) => [
      hold,
      { hold, readyCount: 0, lockedCount: 0, oldestOverdueMs: 0 },
    ]),
  );
  for (const r of rows) {
    const entry = byHold.get(r.hold);
    if (!entry) continue;
    entry.readyCount = r.ready_count;
    entry.lockedCount = r.locked_count;
    entry.oldestOverdueMs = Number(r.oldest_overdue_ms);
  }
  const classes = [...byHold.values()];

  return {
    readyCount: classes.reduce((n, c) => n + c.readyCount, 0),
    lockedCount: classes.reduce((n, c) => n + c.lockedCount, 0),
    oldestOverdueMs: classes.reduce(
      (ms, c) => Math.max(ms, c.oldestOverdueMs),
      0,
    ),
    classes,
  };
}

// One ready row per distinct jobName: how many are waiting and how overdue the
// oldest is. GROUP BY jobName over the ready predicate, ordered by depth, top-N.
// Attributes the aggregate backlog rollup to the jobs filling the ready queue.
export interface BacklogJobStat {
  jobName: string;
  /** The class of the task these rows sit on — i.e. which runners can drain
   * them. Grouped alongside the name, so a backlog reads as "this much
   * `instant` work is waiting" rather than just "this much work". One jobName
   * normally yields one row (all its rows share its class's task); mid-deploy
   * it can briefly yield two, when some of its rows are still on the legacy
   * task and the boot re-point has not run yet. Two truthful rows beat one
   * averaged one. */
  hold: HoldClass;
  readyCount: number;
  oldestOverdueMs: number;
}

const BacklogJobStatRowSchema = z.object({
  job_name: z.string(),
  hold: HoldClassSchema,
  ready_count: z.number(),
  // bigint comes back from pg as a string; coerced to number below.
  oldest_overdue_ms: z.string(),
});

// Read-only: ready-queue depth per jobName, top-N by readyCount.
export async function queryBacklogByJobName(
  limit = 5,
): Promise<BacklogJobStat[]> {
  const rows = await executeRows(db, {
    label: "queryBacklogByJobName",
    row: BacklogJobStatRowSchema,
    query: sql`
    SELECT ${jobNameExpr}                                          AS job_name,
           ${jobHoldExpr}                                          AS hold,
           count(*)::int                                           AS ready_count,
           coalesce(
             extract(epoch FROM (now() - min(j.run_at))) * 1000,
             0
           )::bigint                                               AS oldest_overdue_ms
      FROM ${queueJobsFrom}
     WHERE ${jobTaskScope} AND ${readyPredicate}
     GROUP BY 1, 2
     ORDER BY ready_count DESC
     LIMIT ${limit}
  `,
  });
  return rows.map((r) => ({
    jobName: r.job_name,
    hold: r.hold,
    readyCount: r.ready_count,
    oldestOverdueMs: Number(r.oldest_overdue_ms),
  }));
}

// One currently-locked (running) row, holding a slot from the shared pool: which
// job, its graphile id, how long it has held the slot, and the worker that owns
// it. Ordered by locked duration so the longest slot-holders lead. Attributes
// slot saturation — a job locked for many minutes is why new work waits.
export interface RunningJobStat {
  jobName: string;
  /** The class of the task this row sits on — which tier of the ladder's slots
   * it is occupying. A `minutes` holder occupies one of the 4 wide slots; an
   * `instant` holder may be sitting in the reserved floor. */
  hold: HoldClass;
  jobId: string;
  lockedForMs: number;
  lockedBy: string | null;
  // Whether a worker is still provably running this row (`jobLockHeldExpr`).
  // Deliberately NOT inferred from `lockedForMs`: duration says nothing about
  // liveness — a six-hour handler is as alive as a 200 ms one. `false` means
  // either the owning backend died (the stuck-lock sweeper reclaims the row on
  // its next tick) or dispatch is still inside the sub-second window between
  // graphile's `get_job` stamping `locked_at` and `withJobLock` taking the lock.
  alive: boolean;
  /**
   * Whether this run's slot has been WRITTEN OFF: it passed its class deadline,
   * ignored the abort, and outlived the zombie grace, so the pool no longer
   * counts the slot as available.
   *
   * `alive && forfeited` is the interesting combination and is not a
   * contradiction: the handler is still running (that is what `alive` says) and
   * we have stopped waiting for it (that is what this says). Nothing was taken
   * from it — see `forfeit.ts`.
   *
   * Read from THIS process's memory, never from the DB. A forfeit is a fact
   * about the backend holding the slot, so a row locked by a different backend
   * reads `false` here, correctly: this process has written nothing off for it.
   */
  forfeited: boolean;
}

const RunningJobStatRowSchema = z.object({
  job_name: z.string(),
  hold: HoldClassSchema,
  job_id: z.string(),
  // bigint comes back from pg as a string; coerced to number below.
  locked_for_ms: z.string(),
  locked_by: z.string().nullable(),
  alive: z.boolean(),
});

// Read-only: currently-locked (running) jobs, longest-held slot first.
// `locked_at` still answers "for how long" (graphile stamps it exactly once, at
// dispatch); `pg_locks` answers "is it alive". Those are two different questions
// and this is the one place both are read together.
export async function queryRunningJobs(): Promise<RunningJobStat[]> {
  const rows = await executeRows(db, {
    label: "queryRunningJobs",
    row: RunningJobStatRowSchema,
    query: sql`
    SELECT ${jobNameExpr}                                              AS job_name,
           ${jobHoldExpr}                                              AS hold,
           j.id::text                                                  AS job_id,
           (extract(epoch FROM (now() - j.locked_at)) * 1000)::bigint  AS locked_for_ms,
           j.locked_by                                                 AS locked_by,
           ${jobLockHeldExpr}                                          AS alive
      FROM ${queueJobsFrom}
     WHERE ${jobTaskScope} AND j.locked_at IS NOT NULL
     ORDER BY locked_for_ms DESC
  `,
  });
  // Joined in post-processing rather than in SQL, deliberately: forfeit is
  // PROCESS state (a module-level map in forfeit.ts), not a column — there is
  // nothing in the database to join against, and writing one would be claiming
  // durably something that is only true while this backend lives.
  return rows.map((r) => ({
    jobName: r.job_name,
    hold: r.hold,
    jobId: r.job_id,
    lockedForMs: Number(r.locked_for_ms),
    lockedBy: r.locked_by,
    alive: r.alive,
    forfeited: isSlotForfeited(r.job_id),
  }));
}

// ─── The health-row reads ─────────────────────────────────────────────────
//
// What `debug/queue-health`'s pulse is built from, besides the slot ledger
// (which answers "which slot holds what" from memory, with no query). All three
// are bounded: one aggregate row per class, and two top-N lists. Timestamps come
// back as epoch ms (database clock) or `null` when there is no such row — never
// `0`, which would read as "1970".

/** One hold class's queue state, as the database sees it. */
export interface QueueClassPulse {
  hold: HoldClass;
  /** Rows waiting for a worker slot: due, unlocked, retry-eligible, and not
   * held back by their serial lane (`waitingForSlotPredicate`). */
  waitingForSlot: number;
  /** `run_at` of the oldest such row; `null` when `waitingForSlot` is 0. */
  oldestWaitingRunAt: number | null;
  /** Ready rows queued behind a held serial lane. They wait by design. */
  behindLanes: number;
  /** Rows graphile has locked, whoever holds them — this backend's workers or a
   * dead one's (the stuck-lock sweeper's work). */
  lockedCount: number;
  /** Earliest FUTURE `run_at` among unlocked, retry-eligible rows — the next
   * moment new work becomes due (a retry backoff, a scheduled run); `null` if
   * nothing is scheduled. */
  nextDueAt: number | null;
}

const QueuePulseRowSchema = z.object({
  hold: HoldClassSchema,
  waiting_for_slot: z.number(),
  oldest_waiting_run_at: z.string().nullable(),
  behind_lanes: z.number(),
  locked_count: z.number(),
  next_due_at: z.string().nullable(),
});

/**
 * One aggregate over the live queue, one entry per class in `HOLD_CLASSES`
 * order (zeroed when a class has no rows). The table is normally near-empty, so
 * this is cheap enough to run on every queue change.
 */
export async function queryQueuePulse(): Promise<QueueClassPulse[]> {
  const rows = await executeRows(db, {
    label: "queryQueuePulse",
    row: QueuePulseRowSchema,
    query: sql`
    SELECT ${jobHoldExpr}                                                         AS hold,
           count(*) FILTER (WHERE ${waitingForSlotPredicate})::int                AS waiting_for_slot,
           ${epochMsExpr(sql`min(j.run_at) FILTER (WHERE ${waitingForSlotPredicate})`)}::text
                                                                                  AS oldest_waiting_run_at,
           count(*) FILTER (WHERE ${readyPredicate} AND ${behindHeldLaneExpr})::int AS behind_lanes,
           count(*) FILTER (WHERE j.locked_at IS NOT NULL)::int                   AS locked_count,
           ${epochMsExpr(
             sql`min(j.run_at) FILTER (WHERE j.run_at > now() AND j.locked_at IS NULL AND j.attempts < j.max_attempts)`,
           )}::text                                                               AS next_due_at
      FROM ${queueJobsFrom}
     WHERE ${jobTaskScope}
     GROUP BY 1
  `,
  });

  const byHold = new Map(rows.map((r) => [r.hold, r]));
  return HOLD_CLASSES.map((hold) => {
    const r = byHold.get(hold);
    if (!r) {
      return {
        hold,
        waitingForSlot: 0,
        oldestWaitingRunAt: null,
        behindLanes: 0,
        lockedCount: 0,
        nextDueAt: null,
      };
    }
    return {
      hold,
      waitingForSlot: r.waiting_for_slot,
      oldestWaitingRunAt: toEpochMs(r.oldest_waiting_run_at),
      behindLanes: r.behind_lanes,
      lockedCount: r.locked_count,
      nextDueAt: toEpochMs(r.next_due_at),
    };
  });
}

/** One row waiting for a worker slot. */
export interface WaitingJobStat {
  jobId: string;
  jobName: string;
  hold: HoldClass;
  /** When it became due (epoch ms). Its wait is `now - runAt`. */
  runAt: number;
  /** Attempts already spent — `> 0` means this is a retry waiting. */
  attempts: number;
}

const WaitingJobRowSchema = z.object({
  job_id: z.string(),
  job_name: z.string(),
  hold: HoldClassSchema,
  run_at: z.string(),
  attempts: z.number(),
});

/**
 * The rows waiting for a slot that most need a human's eye, most severe first.
 *
 * "Most severe" is the wait measured against the row's OWN class's pickup
 * target, not the raw wait: a `minutes` job waiting 4 min is inside its target,
 * an `instant` job waiting 2 min is at its deadline, and ordering by `run_at`
 * alone would list the first and hide the second. Because every class's
 * deadline is the same multiple of its target (`core/hold.ts`), this ratio
 * orders by severity without this file knowing any threshold.
 */
export async function queryOldestWaiting(limit = 5): Promise<WaitingJobStat[]> {
  const rows = await executeRows(db, {
    label: "queryOldestWaiting",
    row: WaitingJobRowSchema,
    query: sql`
    SELECT j.id::text                               AS job_id,
           ${jobNameExpr}                           AS job_name,
           ${jobHoldExpr}                           AS hold,
           ${epochMsExpr(sql`j.run_at`)}::text      AS run_at,
           j.attempts                               AS attempts
      FROM ${queueJobsFrom}
     WHERE ${jobTaskScope} AND ${waitingForSlotPredicate}
     ORDER BY extract(epoch FROM (now() - j.run_at)) * 1000 / ${jobPickupTargetMsExpr} DESC,
              j.run_at ASC,
              j.id ASC
     LIMIT ${limit}
  `,
  });
  return rows.map((r) => ({
    jobId: r.job_id,
    jobName: r.job_name,
    hold: r.hold,
    runAt: Number(r.run_at),
    attempts: r.attempts,
  }));
}

/** Longest `lastError` a {@link DeadJobGroupStat} carries. The full text stays
 * in Debug → Queue → Dead; this is a preview that keeps the pulse small. */
export const DEAD_ERROR_PREVIEW_CHARS = 200;

/** Every death of one job name since some instant. */
export interface DeadJobGroupStat {
  jobName: string;
  /** Deaths in the window — live dead rows plus archived ones. */
  count: number;
  /** When the most recent one died (epoch ms). */
  lastDiedAt: number;
  /** The most recent death's error, cut to {@link DEAD_ERROR_PREVIEW_CHARS};
   * `null` when graphile recorded none. */
  lastError: string | null;
}

const DeadJobGroupRowSchema = z.object({
  job_name: z.string(),
  count: z.number(),
  last_died_at: z.string(),
  last_error: z.string().nullable(),
});

/**
 * Jobs that died since `since` (epoch ms), grouped by name, most recent first.
 *
 * A dead job lives in one of two places, and this reads both: still in
 * graphile's table (`deadJobPredicate`, died at its `updated_at`), or already
 * moved to the `dead_jobs` archive by the hourly GC. `reconcileDeadJobs` moves a
 * row in one transaction, so no death is counted twice.
 *
 * The archive read is on `died_at`, which is indexed for exactly this: the
 * archive is capped at 2000 rows but each carries its job's input inline, so a
 * scan reads one heap page per row.
 */
export async function queryRecentDeadJobs(opts: {
  since: number;
  limit?: number;
}): Promise<DeadJobGroupStat[]> {
  const limit = opts.limit ?? 5;
  const since = sql`to_timestamp(${opts.since}::float8 / 1000)`;
  const rows = await executeRows(db, {
    label: "queryRecentDeadJobs",
    row: DeadJobGroupRowSchema,
    query: sql`
    WITH deaths AS (
      SELECT ${jobNameExpr} AS job_name, j.updated_at AS died_at, j.last_error
        FROM ${queueJobsFrom}
       WHERE ${deadJobPredicate} AND j.updated_at >= ${since}
      UNION ALL
      SELECT d.job_name, d.died_at, d.last_error
        FROM dead_jobs d
       WHERE d.died_at >= ${since}
    )
    SELECT job_name,
           count(*)::int                                                   AS count,
           ${epochMsExpr(sql`max(died_at)`)}::text                         AS last_died_at,
           left((array_agg(last_error ORDER BY died_at DESC))[1], ${DEAD_ERROR_PREVIEW_CHARS}::int)
                                                                           AS last_error
      FROM deaths
     GROUP BY job_name
     ORDER BY max(died_at) DESC
     LIMIT ${limit}
  `,
  });
  return rows.map((r) => ({
    jobName: r.job_name,
    count: r.count,
    lastDiedAt: Number(r.last_died_at),
    lastError: r.last_error,
  }));
}
