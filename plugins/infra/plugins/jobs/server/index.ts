import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  handleCancelJob,
  handleListDeadJobs,
  handleListJobs,
  handleRetryJob,
} from "./internal/handle";
import {
  deadJobsServed,
  jobRunsServed,
  jobsListServed,
} from "./internal/resources";
import { jobsResumeJob } from "./internal/resume-job";
import { JobQueue } from "./internal/queue";
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
export { refreshJobSchedules } from "./internal/refresh-schedules";
export { JobQueue } from "./internal/queue";
export type { JobQueueImpl, JobRowOpts, QueuedJob } from "./internal/queue";
export type { JobTaskPayload } from "./internal/registry";
export { UNSAFE_runJobRow } from "./internal/run-row";
export type { JobRowOutcome } from "./internal/run-row";
export { singletonJobKey } from "./internal/run-identity";
export { isSuspendSignal } from "./internal/step-ctx";
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
export { UNSAFE_installDurableHooks } from "./internal/step-ctx";
export type { DurableHooks } from "./internal/step-ctx";
export {
  NonRetryableError,
  isNonRetryableError,
} from "./internal/non-retryable";
export {
  JobDeadlineExceededError,
  isJobDeadlineExceededError,
} from "./internal/deadline-error";
export { jobDeadlineSink } from "./internal/deadline-seam";
export type { JobDeadlineEvent } from "./internal/deadline-seam";
// The floor's report kind + payload. Exported because the SPELLING must be
// shared: this plugin writes the durable line (synchronously, on the way out of
// a deliberate exit) and the `deadline-audit` sub-plugin registers the kind that
// interprets it. Two hand-typed copies of a kind string would resolve to
// nothing on the next boot's flush, and the failure would be a log line on a
// backend that had already restarted.
export { JOB_SLOT_FLOOR_KIND } from "./internal/slot-floor";
export type { JobSlotFloorReport } from "./internal/slot-floor";
export { abortDurableRun } from "./internal/abort-run";
// The tables a served value reading the jobs API declares in its `reads`.
export { _deadJobs, _jobRunStats, _jobRuns } from "./internal/tables";
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
    "Durable background jobs primitive: plugins declare jobs via defineJob and enqueue via job.enqueue, onto the host's job queue (JobQueue — graphile-worker on the desktop).",
  loadBearing: true,
  portable: true,
  httpRoutes: {
    [listJobs.route]: handleListJobs,
    [listDeadJobs.route]: handleListDeadJobs,
    [retryJob.route]: handleRetryJob,
    [cancelJob.route]: handleCancelJob,
  },
  register: [jobsResumeJob],
  contributions: [
    ...jobsListServed.declare,
    ...deadJobsServed.declare,
    ...jobRunsServed.declare,
  ],
  // The queue's lifecycle runs in THIS plugin's phase hooks, through the
  // host's provider, so every plugin depending on `jobs` observes it exactly
  // where it always has.
  //
  // `onReadyBlocking` rather than `onReady` for the install because it
  // completes across ALL plugins before any plugin's `onReady` runs, so a
  // plugin that tx-enqueues from its own `onReady` can never observe a
  // half-installed queue.
  onReadyBlocking: async () => {
    await JobQueue.get().install();
  },
  onReady: async () => {
    await JobQueue.get().start();
  },
  // Schedules are installed only after every plugin's onReady has run, so
  // resolver-form schedules (e.g. backup's, which reads config) see ready
  // state.
  onAllReady: () => {
    JobQueue.get().schedule();
  },
  onShutdown: async () => {
    await JobQueue.get().stop();
  },
} satisfies ServerPluginDefinition;
