import { useMemo } from "react";
import {
  HOLD_SPECS,
  jobRuns,
  jobs,
  type HoldClass,
  type JobRow,
  type JobRunOutcome,
  type JobRunRow,
  type JobState,
} from "@plugins/infra/plugins/jobs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import {
  combineResources,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";

/**
 * Every status a job row can be in: graphile's four queue states for a row
 * still in the queue (the Queue view), a recorded run's outcome for a finished
 * one (the History view).
 */
export type JobListStatus = JobState | JobRunOutcome;

/**
 * What is wrong with a running queue row, when something is:
 * - `no-worker` — nobody holds the job's advisory lock any more (the owning
 *   backend died, or dispatch is inside its sub-second acquisition window);
 *   the stuck-lock sweeper will reclaim the row.
 * - `forfeited` — the opposite: a worker IS still there, it passed its hold
 *   class's deadline, ignored the abort, and the pool stopped counting its
 *   slot. The row is untouched and its lock still held.
 */
export type JobProblem = "no-worker" | "forfeited";

interface JobListRowBase {
  /** `live:<graphile id>` or `run:<run id>` — what a detail pane is opened by. */
  key: string;
  jobName: string;
  hold: HoldClass | null;
  status: JobListStatus;
  problem: JobProblem | null;
  attempt: number;
  maxAttempts: number | null;
  /**
   * The row's one instant: a finished run's end, a running row's lock (when
   * it started), any other queue row's run-at (when it becomes runnable).
   */
  when: Date;
  /** Time spent waiting for a worker slot: a run's `waitMs`, a running row's lock − run-at. */
  waitMs: number | null;
  /** A run's duration; a running row's time since its lock (at the last read). */
  durationMs: number | null;
  /** Set on a running row: the duration cell ticks from here. */
  runningSince: Date | null;
  error: string | null;
}

/**
 * One job row as the detail pane and its recent-runs strip read it: a queue
 * row (`jobs`) or a finished run (`jobRuns`), the fields both share named
 * once.
 */
export type JobListRow =
  | (JobListRowBase & { kind: "live"; job: JobRow })
  | (JobListRowBase & { kind: "run"; run: JobRunRow });

export const ACTIVE_STATUSES: ReadonlySet<JobListStatus> = new Set([
  "pending",
  "running",
  "retrying",
]);

export function isActive(row: JobListRow): boolean {
  return ACTIVE_STATUSES.has(row.status);
}

/** Over its hold class's work ceiling (the `HOLD_SPECS` `ceilingMs`). */
export function isOverCeiling(row: {
  hold: HoldClass | null;
  durationMs: number | null;
}): boolean {
  return (
    row.hold !== null &&
    row.durationMs !== null &&
    row.durationMs > HOLD_SPECS[row.hold].ceilingMs
  );
}

export const liveKey = (graphileId: string) => `live:${graphileId}`;
export const runKey = (runId: string) => `run:${runId}`;

/** What a detail key names: a queue row by its graphile id, or a run by its id. */
export type JobKey = { kind: "live"; id: string } | { kind: "run"; id: string };

/** The row a detail key names — `null` for a key no view mints (an old or hand-typed link). */
export function parseJobKey(key: string): JobKey | null {
  if (key.startsWith("live:")) return { kind: "live", id: key.slice(5) };
  if (key.startsWith("run:")) return { kind: "run", id: key.slice(4) };
  return null;
}

/** A queue row's problem, when it has one (see {@link JobProblem}). */
export function problemOf(job: JobRow): JobProblem | null {
  return job.alive === false ? "no-worker" : job.forfeited ? "forfeited" : null;
}

export function fromLive(job: JobRow, now: number): JobListRow {
  const running = job.state === "running" && job.lockedAt !== null;
  const lockedAt = job.lockedAt;
  return {
    kind: "live",
    job,
    key: liveKey(job.id),
    jobName: job.jobName,
    hold: job.hold,
    status: job.state,
    problem: problemOf(job),
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    when: running && lockedAt !== null ? lockedAt : job.runAt,
    waitMs:
      running && lockedAt !== null
        ? Math.max(0, lockedAt.getTime() - job.runAt.getTime())
        : null,
    durationMs:
      running && lockedAt !== null
        ? Math.max(0, now - lockedAt.getTime())
        : null,
    runningSince: running ? lockedAt : null,
    error: job.lastError,
  };
}

export function fromRun(run: JobRunRow): JobListRow {
  return {
    kind: "run",
    run,
    key: runKey(run.id),
    jobName: run.jobName,
    hold: run.hold,
    status: run.outcome,
    problem: null,
    attempt: run.attempt,
    maxAttempts: run.maxAttempts,
    when: run.finishedAt,
    waitMs: run.waitMs,
    durationMs: run.durationMs,
    runningSince: null,
    error: run.error,
  };
}

/**
 * More recorded runs than one job's ring keeps (`RECENT_RUNS_RING`, 20 per job
 * name — jobs' `server/internal/tables.ts`): a window this wide holds all of
 * them.
 */
const JOB_HISTORY_LIMIT = 50;

/**
 * Every row one job has: its queue rows (`jobs`) and its recorded runs
 * (`jobRuns`, newest first) — what the recent-runs strip draws.
 */
export function useJobHistory(
  jobName: string,
): ResourceResult<readonly JobListRow[]> {
  const live = useLive(jobs, { where: { jobName } });
  const runs = useLive(jobRuns, {
    where: { jobName },
    limit: JOB_HISTORY_LIMIT,
  });
  // A running row's duration is read against this clock; its bar ticks with it.
  const now = useNow(30_000);
  return useMemo(
    () =>
      mapResource(combineResources({ live, runs }), (d) => [
        ...d.runs.map(fromRun),
        ...d.live.map((job) => fromLive(job, now)),
      ]),
    [live, runs, now],
  );
}
