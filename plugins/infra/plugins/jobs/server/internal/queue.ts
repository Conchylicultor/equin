import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { HoldClass } from "../../core/hold";
import type { JobsPayload } from "../../core/resources";
import type { EnqueueTx, JobTaskPayload, SerialSpec } from "./registry";

/** What one inserted job row is made of besides its payload. */
export interface JobRowOpts {
  /** The queue-row dedup key — taken literally (see `run-identity.ts`). */
  jobKey?: string | null;
  runAt?: Date | null;
  maxAttempts?: number;
  /**
   * Insert on the CALLER's transaction: the row commits (and the job may run)
   * only if that transaction does, and a rollback drops it with the caller's
   * writes.
   */
  tx?: EnqueueTx;
}

/** The registered job a row is inserted for — what the queue derives the
 *  row's routing from (its hold class, its serialization lane). */
export interface QueuedJob {
  name: string;
  hold: HoldClass;
  serial?: SerialSpec;
}

/**
 * The job queue this host runs: where `job.enqueue(...)` rows go and who
 * dispatches them. The portable jobs layer — `defineJob`, the registry, the
 * durable step / wait logs, `jobs.resume` — is written against this; what a row
 * IS and how it is fetched is the provider's.
 *
 * The desktop's provider is graphile-worker (`jobs#machine`: the three-runner
 * hold-class ladder, the advisory job lock, the cron schedules, the stuck-lock
 * sweeper). A host without the computer runs the in-memory queue
 * (`jobs/plugins/in-process`), whose rows are lost on reload.
 *
 * The lifecycle methods are called by the jobs plugin's own phase hooks, so
 * every plugin that depends on `jobs` keeps observing them in the order it
 * always has.
 */
export interface JobQueueImpl {
  /** Insert one row for `job`. The payload is stored verbatim. */
  enqueue(
    job: QueuedJob,
    payload: JobTaskPayload,
    opts: JobRowOpts,
  ): Promise<{ jobId: string }>;
  /**
   * Drop the not-yet-started rows whose key is `key` (or starts with
   * `keyPrefix`) — a durable run's cancelled timeout racer or resume. A row
   * already running is left to finish.
   */
  cancelUnstarted(
    match: { key: string } | { keyPrefix: string },
  ): Promise<void>;
  /**
   * The queue's rows, newest `runAt` first, at most `limit` — what Debug →
   * Queue lists (`jobs-list`, `GET /api/jobs`).
   */
  list(limit: number): Promise<JobsPayload>;
  /** Run a row again now, with its attempts reset (`POST /api/jobs/:id/retry`). */
  retry(jobId: string): Promise<void>;
  /** Remove a row (`DELETE /api/jobs/:id`). */
  cancel(jobId: string): Promise<void>;
  /**
   * Be told whenever the queue's rows may have changed — a row inserted,
   * started, finished, retried or removed. Returns the unsubscribe. What
   * `jobs-list` reloads on, while a tab watches it.
   */
  onActivity(listener: () => void): () => void;
  /** `onReadyBlocking`: make the queue usable (the desktop installs its schema
   *  in this backend's database), before any plugin's `onReady` enqueues. */
  install(): Promise<void>;
  /** `onReady`: start dispatching. */
  start(): Promise<void>;
  /** `onAllReady`: install the scheduled jobs' schedules — after every plugin
   *  is ready, since a schedule resolver may read another plugin's config. */
  schedule(): void;
  /** Re-read every resolver-form schedule now and install the result; a no-op
   *  before `schedule()` has run. */
  refreshSchedules(): void;
  /** `onShutdown`: stop dispatching and release what `start` opened. */
  stop(): Promise<void>;
}

export const JobQueue = defineHostService<JobQueueImpl>("jobs.queue");
