import {
  HOLD_SPECS,
  jobRuns,
  jobsList,
  type HoldClass,
  type JobRow,
  type JobRunRow,
  type JobsPayload,
} from "@plugins/infra/plugins/jobs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import {
  combineResources,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";

/**
 * Every status a row of the Jobs list can be in: graphile's four queue states
 * for a row still in the queue, a recorded run's outcome for a finished one.
 */
export type JobListStatus =
  | "pending"
  | "running"
  | "retrying"
  | "dead"
  | "succeeded"
  | "failed"
  | "suspended";

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
  /** `live:<graphile id>` or `run:<run id>` — unique across both sources. */
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
  /** Sort key putting in-flight rows first (oldest first), then finished rows newest first. */
  order: number;
}

/** One row of the Jobs list: a live graphile queue row, or a finished run. */
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

// Far above any epoch-ms instant, so every in-flight row sorts (descending)
// before every finished one, earliest first among themselves.
const ACTIVE_BASE = 1e14;

function orderOf(status: JobListStatus, when: Date): number {
  return ACTIVE_STATUSES.has(status)
    ? ACTIVE_BASE - when.getTime()
    : when.getTime();
}

function fromLive(job: JobRow, now: number): JobListRow {
  const runAt = new Date(job.runAt);
  const lockedAt = job.lockedAt === null ? null : new Date(job.lockedAt);
  const running = job.state === "running" && lockedAt !== null;
  const when = running ? lockedAt : runAt;
  return {
    kind: "live",
    job,
    key: liveKey(job.id),
    jobName: job.jobName,
    hold: job.hold ?? null,
    status: job.state,
    problem:
      job.alive === false
        ? "no-worker"
        : job.forfeited === true
          ? "forfeited"
          : null,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    when,
    waitMs: running ? Math.max(0, lockedAt.getTime() - runAt.getTime()) : null,
    durationMs: running ? Math.max(0, now - lockedAt.getTime()) : null,
    runningSince: running ? lockedAt : null,
    error: job.lastError,
    order: orderOf(job.state, when),
  };
}

function fromRun(run: JobRunRow): JobListRow {
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
    order: orderOf(run.outcome, run.finishedAt),
  };
}

/** The merged Jobs rows plus the queue's per-state counts. */
export interface JobRowsData {
  rows: JobListRow[];
  counts: JobsPayload["counts"];
}

/**
 * The Jobs list's rows: the live graphile queue (`jobsList`) and the whole run
 * history (`jobRuns`, the whole per-job ring as one `all` set), merged on the
 * client. They cannot be one server-side
 * union: graphile's tables sit outside the schema the change feed covers.
 *
 * One read for every consumer — the list, the detail pane and its resolve
 * guard — so they agree on what exists; identical tuples share one cache entry.
 */
export function useJobRows(): ResourceResult<JobRowsData> {
  const live = useLive(jobsList);
  const runs = useLive(jobRuns);
  // A running row's duration is read against this clock — it orders the Slow
  // view; its cell ticks on its own (`runningSince`).
  const now = useNow(30_000);
  return mapResource(combineResources({ live, runs }), (d) =>
    mergeRows(d.live, d.runs, now),
  );
}

// Merges are cached on the inputs' identities (the cached query values — an
// `all` read's array keeps its identity until a push changes the set), so
// every consumer and every render of an unchanged read gets the same rows —
// the DataView's memos hold — and the run rows (20 per job name) map once per
// change.
const runRowsCache = new WeakMap<readonly JobRunRow[], JobListRow[]>();
const mergeCache = new WeakMap<
  JobsPayload,
  { runs: readonly JobRunRow[]; now: number; data: JobRowsData }
>();

function mergeRows(
  live: JobsPayload,
  runs: readonly JobRunRow[],
  now: number,
): JobRowsData {
  const hit = mergeCache.get(live);
  if (hit !== undefined && hit.runs === runs && hit.now === now) {
    return hit.data;
  }
  let runRows = runRowsCache.get(runs);
  if (runRows === undefined) {
    runRows = runs.map(fromRun);
    runRowsCache.set(runs, runRows);
  }
  const data = {
    rows: [...live.rows.map((job) => fromLive(job, now)), ...runRows],
    counts: live.counts,
  };
  mergeCache.set(live, { runs, now, data });
  return data;
}

/**
 * The row a Jobs detail key names. A live key whose queue row is gone (it
 * finished between the read and now) answers with the run that row became —
 * the newest recorded run carrying its graphile id — so the open pane follows
 * the job instead of turning into "not found". `followed` says that happened.
 */
export function findJobRow(
  rows: readonly JobListRow[],
  key: string,
): { row: JobListRow; followed: boolean } | null {
  const direct = rows.find((r) => r.key === key);
  if (direct !== undefined) return { row: direct, followed: false };
  if (!key.startsWith("live:")) return null;
  const graphileId = key.slice("live:".length);
  let best: JobListRow | null = null;
  for (const r of rows) {
    if (r.kind !== "run" || r.run.jobId !== graphileId) continue;
    if (best === null || (best.kind === "run" && r.run.seq > best.run.seq)) {
      best = r;
    }
  }
  return best === null ? null : { row: best, followed: true };
}
