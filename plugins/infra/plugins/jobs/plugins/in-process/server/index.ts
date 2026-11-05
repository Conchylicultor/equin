import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { JobQueue } from "@plugins/infra/plugins/jobs/server";
import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { createInProcessQueue } from "./internal/in-process-queue";
import { _inProcessJobRows, _inProcessJobSchedules } from "./internal/tables";

export { settleJobQueue } from "./internal/in-process-queue";

export default {
  description:
    "The in-process job queue: provides the JobQueue host service for a host without the desktop's graphile queue — a row runs in this process when it is due, kept in the host's own database (written in the enqueuing transaction, so it commits or rolls back with it, and outlives a reload); scheduled jobs fire on a one-shot timer to their next due minute, a tick missed while no process ran caught up per the job's catchUpWithinMs. Never booted by the desktop.",
  contributions: [
    JobQueue.provide(createInProcessQueue()),
    ExcludeFromChangeFeed({
      table: _inProcessJobRows,
      reason:
        "The queue's own bookkeeping, written on every attempt and read by nothing but the queue (its working copy is in memory; Debug → Queue reads that, notified by the queue's own activity).",
    }),
    ExcludeFromChangeFeed({
      table: _inProcessJobSchedules,
      reason:
        "The schedules' last-tick watermarks, read by the queue alone when it installs its schedules.",
    }),
  ],
} satisfies ServerPluginDefinition;
