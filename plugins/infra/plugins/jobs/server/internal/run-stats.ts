import type { WorkerEventMap, WorkerEvents } from "graphile-worker";
import { desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { runInBackgroundLane } from "@plugins/infra/plugins/runtime-profiler/core";
import { holdForTask, type HoldClass } from "../../core/hold";
import type { JobRunOutcome } from "../../core/resources";
import { _jobRuns, _jobRunStats } from "./tables";

// RUN HISTORY: what each job did the last times it ran. graphile deletes a row
// the moment its job succeeds, so without this a successful run leaves no trace
// at all — the Background activity page could not say "last ran 2 min ago".
//
// Written from graphile's events on the per-runner emitters, like the slot
// ledger and for the same ordering reason (slot-ledger.ts): `job:complete` is
// emitted only after graphile has written the outcome back, so the history never
// runs ahead of the queue. Bounded by construction (see tables.ts): one stats
// row per job name, and a ring of RECENT_RUNS_RING runs per job name.

/** How many recent runs are kept per job — the ring's size. */
export const RECENT_RUNS_RING = 20;

/**
 * The ring slot run number `seq` (1-based, the stats row's `runs` after it was
 * counted) is written to. Run 21 overwrites run 1's slot.
 */
export function ringSlot(seq: number): number {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(
      `[jobs] run history: run number ${seq} is not a positive integer`,
    );
  }
  return (seq - 1) % RECENT_RUNS_RING;
}

export type { JobRunOutcome };

/** One finished run, as recorded. */
export interface JobRunRecord {
  jobName: string;
  startedAt: Date;
  finishedAt: Date;
  outcome: JobRunOutcome;
  /** The error's message (capped at {@link RUN_ERROR_CHARS}), or null. */
  error: string | null;
  durationMs: number;
  attempt: number;
  /**
   * What the queue row said about the run — graphile's job id, the class of
   * the task it was fetched on, its retry budget, when it became runnable
   * (`run_at`) and the payload's input. `null` on a run recorded before the
   * history kept them.
   */
  jobId: string | null;
  hold: HoldClass | null;
  maxAttempts: number | null;
  queuedAt: Date | null;
  input: unknown;
}

/** A job's latest run and its counters. */
export interface JobRunStats {
  jobName: string;
  lastStartedAt: Date;
  lastFinishedAt: Date;
  lastOutcome: JobRunOutcome;
  lastError: string | null;
  lastDurationMs: number;
  lastSuccessAt: Date | null;
  runs: number;
  failures: number;
}

// A run is started in one event and finished in another; what `job:start` knew
// is held here until then, keyed by graphile job id (one id is one run in one
// slot). Process state: a run that outlives its process is never finished here.
const started = new Map<string, { at: number }>();
// Job ids whose dispatch returned "suspended" (a durable workflow waiting).
// graphile reports those as successes; `dispatch()` knows better and says so.
const suspended = new Set<string>();

const changeListeners = new Set<(jobName: string) => void>();

/**
 * Be told when a job's run history may have changed: a run started in this
 * backend, or a finished run was written. Returns the unsubscribe. Listeners run
 * inside graphile's event emission, so they must be cheap (a live value's
 * `notify()` is the intended shape).
 */
export function onJobRunsChanged(
  listener: (jobName: string) => void,
): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * The runs in flight in THIS backend right now: job name → when its earliest
 * in-flight run started.
 */
export function runningJobStarts(): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const [id, jobName] of inFlight) {
    const start = started.get(id);
    if (start === undefined) continue;
    const prev = out.get(jobName);
    if (prev === undefined || start.at < prev.getTime()) {
      out.set(jobName, new Date(start.at));
    }
  }
  return out;
}
const inFlight = new Map<string, string>(); // job id → job name

/** Called by `dispatch()` when a run returned to wait rather than finishing. */
export function markRunSuspended(jobId: string): void {
  suspended.add(jobId);
}

/**
 * Feed the run history from one runner's events. Attach before `run()`, like
 * the slot ledger. Returns a detach function.
 */
export function attachRunStats(events: WorkerEvents): () => void {
  const onStart = ({ job }: WorkerEventMap["job:start"]): void => {
    guarded("job:start", () => {
      const jobName = jobNameOf(job.payload);
      if (jobName === null) return;
      const id = String(job.id);
      started.set(id, { at: Date.now() });
      inFlight.set(id, jobName);
      emitChanged(jobName);
    });
  };
  const onComplete = ({ job, error }: WorkerEventMap["job:complete"]): void => {
    guarded("job:complete", () => {
      const id = String(job.id);
      const start = started.get(id);
      started.delete(id);
      inFlight.delete(id);
      const wasSuspended = suspended.delete(id);
      const jobName = jobNameOf(job.payload);
      // A run whose start this process never saw (attached mid-run) has no
      // honest duration, so it is not recorded rather than recorded wrong.
      if (jobName === null || start === undefined) return;
      const finishedAt = Date.now();
      const failed = error !== null && error !== undefined;
      const record: JobRunRecord = {
        jobName,
        startedAt: new Date(start.at),
        finishedAt: new Date(finishedAt),
        outcome: failed ? "failed" : wasSuspended ? "suspended" : "succeeded",
        error: failed ? errorMessage(error) : null,
        durationMs: finishedAt - start.at,
        attempt: job.attempts,
        jobId: id,
        hold: holdForTask(job.task_identifier),
        maxAttempts: job.max_attempts,
        queuedAt: queuedAtOf(job.run_at),
        input: inputOf(job.payload),
      };
      // Detached on purpose — graphile's emitter must not wait on our write,
      // and a failed write must not reach it (see `guarded`). A rejection is
      // NOT swallowed: it surfaces as an unhandled rejection, which the reports
      // plugin files.
      void runInBackgroundLane(async () => {
        await recordJobRun(db, record);
        emitChanged(jobName);
      });
    });
  };
  events.on("job:start", onStart);
  events.on("job:complete", onComplete);
  return () => {
    events.off("job:start", onStart);
    events.off("job:complete", onComplete);
  };
}

/** Forget every in-flight run. `stopWorkers` calls it, like `clearSlotLedger`. */
export function clearRunStats(): void {
  started.clear();
  inFlight.clear();
  suspended.clear();
}

/**
 * Write one finished run: bump the job's stats row and put the run in its ring
 * slot, in ONE statement — the slot is derived from the counter the same
 * statement just incremented, so two runs finishing together can never be given
 * the same slot.
 */
export async function recordJobRun(
  dbx: Pick<NodePgDatabase, "execute">,
  run: JobRunRecord,
): Promise<void> {
  const failed = run.outcome === "failed" ? 1 : 0;
  const successAt = run.outcome === "failed" ? null : run.finishedAt;
  // The stats row keeps a one-line preview; the run's own row the full message.
  const lastError =
    run.error === null ? null : cap(run.error, STATS_ERROR_CHARS);
  const input = run.input === undefined ? null : JSON.stringify(run.input);
  await dbx.execute(sql`
    WITH s AS (
      INSERT INTO job_run_stats AS st (
        job_name, last_started_at, last_finished_at, last_outcome, last_error,
        last_duration_ms, last_success_at, runs, failures
      ) VALUES (
        ${run.jobName}, ${run.startedAt.toISOString()}, ${run.finishedAt.toISOString()},
        ${run.outcome}, ${lastError}, ${run.durationMs},
        ${successAt === null ? null : successAt.toISOString()}, 1, ${failed}
      )
      ON CONFLICT (job_name) DO UPDATE SET
        last_started_at = excluded.last_started_at,
        last_finished_at = excluded.last_finished_at,
        last_outcome = excluded.last_outcome,
        last_error = excluded.last_error,
        last_duration_ms = excluded.last_duration_ms,
        last_success_at = COALESCE(excluded.last_success_at, st.last_success_at),
        runs = st.runs + 1,
        failures = st.failures + excluded.failures
      RETURNING runs
    )
    INSERT INTO job_runs (
      job_name, slot, seq, started_at, finished_at, outcome, error, duration_ms,
      attempt, job_id, hold, max_attempts, queued_at, input
    )
    SELECT ${run.jobName}, (s.runs - 1) % ${RECENT_RUNS_RING}, s.runs,
      ${run.startedAt.toISOString()}, ${run.finishedAt.toISOString()},
      ${run.outcome}, ${run.error}, ${run.durationMs}, ${run.attempt},
      ${run.jobId}, ${run.hold}, ${run.maxAttempts},
      ${run.queuedAt === null ? null : run.queuedAt.toISOString()},
      ${input}::jsonb
    FROM s
    ON CONFLICT (job_name, slot) DO UPDATE SET
      seq = excluded.seq,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      outcome = excluded.outcome,
      error = excluded.error,
      duration_ms = excluded.duration_ms,
      attempt = excluded.attempt,
      job_id = excluded.job_id,
      hold = excluded.hold,
      max_attempts = excluded.max_attempts,
      queued_at = excluded.queued_at,
      input = excluded.input
  `);
}

/** Every job's stats row. Bounded by the number of job names ever run here. */
export async function readJobRunStats(): Promise<JobRunStats[]> {
  return db.select().from(_jobRunStats);
}

/** A job's recorded runs, newest first — at most {@link RECENT_RUNS_RING}. */
export async function readRecentJobRuns(
  jobName: string,
): Promise<JobRunRecord[]> {
  const rows = await db
    .select()
    .from(_jobRuns)
    .where(eq(_jobRuns.jobName, jobName))
    .orderBy(desc(_jobRuns.seq))
    .limit(RECENT_RUNS_RING);
  return rows.map((r) => ({
    jobName: r.jobName,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    outcome: r.outcome,
    error: r.error,
    durationMs: r.durationMs,
    attempt: r.attempt,
    jobId: r.jobId,
    hold: r.hold,
    maxAttempts: r.maxAttempts,
    queuedAt: r.queuedAt,
    input: r.input,
  }));
}

function emitChanged(jobName: string): void {
  for (const listener of [...changeListeners]) {
    guarded("run-history listener", () => listener(jobName));
  }
}

// The error's message, capped. A run's own row keeps enough to read a long
// message (a command's output, a multi-line SQL error) in Debug → Queue's run
// detail; the stats row keeps a one-line preview of the latest. The full stack
// is in the job's own failure report (`dispatch()` files one).
const RUN_ERROR_CHARS = 8000;
const STATS_ERROR_CHARS = 500;
function errorMessage(error: unknown): string {
  return cap(
    error instanceof Error ? error.message : String(error),
    RUN_ERROR_CHARS,
  );
}
function cap(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text;
}

// graphile reads its rows through a raw `pg` pool, which decodes `timestamptz`
// to a `Date` (see slot-ledger.ts `epochMs`). Checked, not assumed: a
// non-Date would land as a wrong `queued_at` in every row. Reported, not
// thrown, by the caller's `guarded` — and then the run is not recorded.
function queuedAtOf(runAt: unknown): Date {
  if (!(runAt instanceof Date)) {
    throw new Error(
      `[jobs] run history: run_at = ${String(runAt)}, expected a Date`,
    );
  }
  return runAt;
}

function inputOf(payload: unknown): unknown {
  if (typeof payload === "object" && payload !== null && "input" in payload) {
    return payload.input ?? null;
  }
  return null;
}

function jobNameOf(payload: unknown): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "jobName" in payload &&
    typeof payload.jobName === "string"
  ) {
    return payload.jobName;
  }
  return null;
}

// Report-and-continue, never re-throw — a throw inside graphile's emitter would
// cost a worker slot (slot-ledger.ts, `emitQueueActivity`).
function guarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    const message = `[jobs] run history: ${label} threw: ${errObj.message}`;
    console.error(message, errObj);
    reportServerError({
      message,
      stack: errObj.stack ?? null,
      errorType: errObj.name,
    });
  }
}
