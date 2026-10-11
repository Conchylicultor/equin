import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  connectionString,
  ExcludeSchemaDataFromFork,
} from "@plugins/database/plugins/admin/server";
import {
  handleCancelJob,
  handleListDeadJobs,
  handleListJobs,
  handleRetryJob,
} from "./internal/handle";
import { deadJobGcJob, reconcileDeadJobs } from "./internal/dead-job-gc";
import {
  deadJobsServed,
  jobRunsServed,
  jobsListServed,
} from "./internal/resources";
import { jobsResumeJob } from "./internal/resume-job";
import { installQueueSchema } from "./internal/queue-schema";
import {
  startStuckLockSweeper,
  stopStuckLockSweeper,
  stuckLockSweeperTimer,
} from "./internal/stuck-lock-sweeper";
import {
  installScheduledCronItems,
  startWorkers,
  stopWorkers,
} from "./internal/worker";
import { listJobs, listDeadJobs, retryJob, cancelJob } from "../core/endpoints";

export {
  defineJob,
  UNSAFE_getRegisteredJob,
  getAllRegisteredJobNames,
  DEFAULT_MAX_ATTEMPTS,
  getJobSlowThresholdMs,
  getJobHold,
} from "./internal/registry";
export { listRegisteredJobs, resolveJobCron } from "./internal/registry";
export {
  nextScheduledRun,
  onJobSchedulesChanged,
  refreshJobSchedules,
} from "./internal/worker";
export { cronRanges } from "./internal/cron-schedule";
export type { CronRanges } from "./internal/cron-schedule";
export {
  onJobRunsChanged,
  readJobRunStats,
  readRecentJobRuns,
  runningJobStarts,
  RECENT_RUNS_RING,
} from "./internal/run-stats";
export type {
  JobRunOutcome,
  JobRunRecord,
  JobRunStats,
} from "./internal/run-stats";
export { QueueSchemaMissingError } from "./internal/queue-schema";
export { sweepOnce as UNSAFE_sweepStuckLocks } from "./internal/stuck-lock-sweeper";
export { singletonJobKey } from "./internal/run-identity";
export type {
  DefineJobSpec,
  EnqueueOpts,
  EnqueueTx,
  JobCtx,
  JobFactory,
  RegisteredJob,
  ScheduleSpec,
  SerialSpec,
} from "./internal/registry";
export {
  isSuspendSignal,
  UNSAFE_installDurableHooks,
} from "./internal/step-ctx";
export type { DurableHooks } from "./internal/step-ctx";
export {
  NonRetryableError,
  isNonRetryableError,
} from "./internal/non-retryable";
export {
  JobDeadlineExceededError,
  isJobDeadlineExceededError,
} from "./internal/deadline";
export { jobDeadlineSink } from "./internal/deadline-seam";
export type { JobDeadlineEvent } from "./internal/deadline-seam";
// The floor's report kind + payload. Exported because the SPELLING must be
// shared: this plugin writes the durable line (synchronously, on the way out of
// a deliberate exit) and the `deadline-audit` sub-plugin registers the kind that
// interprets it. Two hand-typed copies of a kind string would resolve to
// nothing on the next boot's flush, and the failure would be a log line on a
// backend that had already restarted.
export {
  JOB_SLOT_FLOOR_KIND,
  getForfeitedSlots,
  usableSlots,
} from "./internal/forfeit";
export type { ForfeitedSlot, JobSlotFloorReport } from "./internal/forfeit";
export { abortDurableRun } from "./internal/abort-run";
export {
  queryDeadJobStats,
  queryQueueBacklog,
  queryBacklogByJobName,
  queryRunningJobs,
  queryQueuePulse,
  queryOldestWaiting,
  queryRecentDeadJobs,
  DEAD_ERROR_PREVIEW_CHARS,
} from "./internal/introspection";
export type {
  DeadJobStat,
  QueueBacklogStat,
  QueueClassBacklogStat,
  BacklogJobStat,
  RunningJobStat,
  QueueClassPulse,
  WaitingJobStat,
  DeadJobGroupStat,
} from "./internal/introspection";
export {
  getOccupiedSlots,
  getPickupStats,
  onQueueActivity,
  PICKUP_WINDOW_MS,
} from "./internal/slot-ledger";
export type { OccupiedSlot, PickupStats } from "./internal/slot-ledger";
export {
  HOLD_CLASSES,
  HoldClassSchema,
  HOLD_SPECS,
  RUNNERS,
  TOTAL_JOB_SLOTS,
  ALL_JOB_TASKS,
  LEGACY_JOB_TASK,
  taskFor,
  priorityFor,
  ceilingMsFor,
  deadlineMsFor,
  pickupTargetMsFor,
  reachableSlots,
  holdForTask,
} from "../core/hold";
export type { HoldClass, HoldClassSpec, RunnerSpec } from "../core/hold";

export default {
  description:
    "Durable background jobs primitive built on graphile-worker. Plugins declare jobs via defineJob and enqueue via job.enqueue.",
  loadBearing: true,
  httpRoutes: {
    [listJobs.route]: handleListJobs,
    [listDeadJobs.route]: handleListDeadJobs,
    [retryJob.route]: handleRetryJob,
    [cancelJob.route]: handleCancelJob,
  },
  register: [jobsResumeJob, deadJobGcJob, stuckLockSweeperTimer],
  contributions: [
    ...jobsListServed.declare,
    ...deadJobsServed.declare,
    ...jobRunsServed.declare,
    // Graphile's own bookkeeping — queued jobs, worker locks, and the crontab's
    // last-execution watermarks. Inheriting it is actively wrong for a fresh
    // worktree: it would adopt main's pending jobs and, worse, main's
    // `known_crontabs.last_execution`, silently skipping the first run of every
    // scheduled job.
    //
    // Who puts it back: `onReadyBlocking` below, which runs
    // `installQueueSchema()` against this backend's own database before any
    // plugin's `onReady`. It is NOT "the first worker start" any more — that
    // read the invariant off a side effect of `makeWorkerUtils`, so a database
    // whose backend had never booted (a fresh worktree where `./singularity
    // test` runs before `./singularity build`) had no queue schema and no way
    // to acquire one, and a transactional enqueue on it failed with a bare
    // `3F000`. Dropping the schema costs nothing only because something owns
    // reinstalling it; see `internal/queue-schema.ts`.
    //
    // The fork used to copy this schema and then `DROP SCHEMA ... CASCADE` it
    // afterwards. Excluding it at dump time reaches the same end state without
    // the copy.
    ExcludeSchemaDataFromFork({
      schema: "graphile_worker",
      // `migrations` and nothing else. Graphile records its migration watermark
      // in that table, INSIDE the schema it owns — so emptying it too would make
      // graphile boot believing it is unmigrated and re-issue CREATE TABLE
      // against tables the fork already has. Keeping just the watermark hands
      // the fork a schema graphile already considers installed, while the rows
      // that describe MAIN's queue — pending jobs, and the
      // `known_crontabs.last_execution` watermarks that would otherwise skip the
      // first run of every scheduled job — stay behind.
      //
      // This is why the fork no longer removes the schema. A forked database is
      // born queue-capable: `enqueue(input, { tx })` works on it before any
      // backend has booted against it.
      keep: ["migrations"],
      // Two consequences worth knowing before changing this. The fork inherits
      // graphile's schema at MAIN's version, so a branch that DOWNGRADES
      // graphile-worker now meets graphile's own breaking-migration guard at
      // boot instead of quietly installing its older schema — loud, and the
      // right answer, but it is a new way to brick a worktree. And the schema's
      // sequences carry main's high-water marks, so a fork's first job id is
      // large rather than 1; that is cosmetic and not worth "fixing".
      reason:
        "Queue bookkeeping for the source database; inheriting main's pending jobs and crontab watermarks would run main's work in a fresh worktree and skip the first run of every scheduled job. The migration watermark is kept so the fork's schema is already installed.",
    }),
  ],
  // The queue schema is a property of the DATABASE, and this is where a
  // database that does not yet have one acquires it. Since the fork exclusion
  // above keeps the migration watermark, a worktree database arrives already
  // installed and this is one connect and one `SELECT`; what it still covers is
  // a database that never had the schema at all (main's very first boot, a
  // `createTestDb` throwaway) and a graphile version bump that adds migrations.
  //
  // `onReadyBlocking` rather than `onReady` because it completes across ALL
  // plugins before any plugin's `onReady` runs, so a plugin that tx-enqueues
  // from its own `onReady` can never observe a half-installed schema.
  onReadyBlocking: async () => {
    await installQueueSchema(connectionString());
  },
  onReady: async () => {
    await startWorkers();
    startStuckLockSweeper();
    // Immediate boot purge of the permanently-failed backlog (idempotent; the
    // scheduled deadJobGcJob keeps it bounded thereafter). Runs after the
    // onReadyBlocking migration barrier, so dead_jobs exists. Fire-and-forget:
    // a failure surfaces as an unhandled rejection (the reports plugin files it)
    // rather than being swallowed into an invisible boot-time no-op.
    void runTracked("jobs:reconcile-dead", () => reconcileDeadJobs());
  },
  // Cron schedules are installed only after every plugin's onReady has run, so
  // resolver-form schedules (e.g. backup's, which reads config) see ready state.
  onAllReady: () => {
    installScheduledCronItems();
  },
  onShutdown: async () => {
    stopStuckLockSweeper();
    await stopWorkers();
  },
} satisfies ServerPluginDefinition;
