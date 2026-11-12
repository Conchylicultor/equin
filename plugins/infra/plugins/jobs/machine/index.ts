import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { JobQueue } from "@plugins/infra/plugins/jobs/server";
import { deadJobGcJob } from "./internal/dead-job-gc";
import { jobsForkExclusions } from "./internal/fork-exclusion";
import { graphileQueue } from "./internal/graphile-queue";
import { stuckLockSweeperTimer } from "./internal/stuck-lock-sweeper";

export { nextScheduledRun, onJobSchedulesChanged } from "./internal/worker";
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
  queryDeadJobsByError,
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
  DeadJobErrorStat,
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
export type {
  OccupiedSlot,
  PickupStats,
  QueueActivity,
} from "./internal/slot-ledger";

export default {
  description:
    "The desktop's job queue: graphile-worker in this backend's database — the hold-class runner ladder, the advisory job lock, cron schedules, the stuck-lock sweeper and the dead-job GC — plus the queue's introspection (backlog, pulse, slot ledger, run stats).",
  loadBearing: true,
  register: [deadJobGcJob, stuckLockSweeperTimer],
  contributions: [JobQueue.provide(graphileQueue), ...jobsForkExclusions],
} satisfies MachinePluginDefinition;
