import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeSchemaDataFromFork } from "@plugins/database/plugins/admin/server";
import { JobQueue } from "@plugins/infra/plugins/jobs/server";
import { deadJobGcJob } from "./internal/dead-job-gc";
import { graphileQueue } from "./internal/graphile-queue";
import { stuckLockSweeperTimer } from "./internal/stuck-lock-sweeper";

export { nextScheduledRun, onJobSchedulesChanged } from "./internal/worker";
export { cronRanges } from "./internal/cron-schedule";
export type { CronRanges } from "./internal/cron-schedule";
export {
  onJobRunsChanged,
  readJobRunStats,
  readRecentJobRuns,
  runningJobStarts,
} from "./internal/run-stats";
export type {
  JobRunOutcome,
  JobRunRecord,
  JobRunStats,
} from "./internal/run-stats";
export { sweepOnce as UNSAFE_sweepStuckLocks } from "./internal/stuck-lock-sweeper";
export { getForfeitedSlots } from "./internal/forfeit";
export type { ForfeitedSlot } from "./internal/forfeit";
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

export default {
  description:
    "The desktop's job queue: graphile-worker in this backend's database — the hold-class runner ladder, the advisory job lock, cron schedules, the stuck-lock sweeper and the dead-job GC — plus the queue's introspection (backlog, pulse, slot ledger, run stats).",
  loadBearing: true,
  register: [deadJobGcJob, stuckLockSweeperTimer],
  contributions: [
    JobQueue.provide(graphileQueue),
    // Graphile's own bookkeeping — queued jobs, worker locks, and the crontab's
    // last-execution watermarks. Inheriting it is actively wrong for a fresh
    // worktree: it would adopt main's pending jobs and, worse, main's
    // `known_crontabs.last_execution`, silently skipping the first run of every
    // scheduled job.
    //
    // Who puts it back: the queue's `install()` (`graphileQueue`), which the
    // jobs plugin's `onReadyBlocking` runs against this backend's own database
    // before any plugin's `onReady`. A database whose backend had never booted
    // (a fresh worktree where `./singularity test` runs before `./singularity
    // build`) used to have no queue schema and no way to acquire one, and a
    // transactional enqueue on it failed with a bare `3F000`. Dropping the
    // schema costs nothing only because something owns reinstalling it; see
    // `server/internal/queue-schema.ts`.
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
} satisfies MachinePluginDefinition;
