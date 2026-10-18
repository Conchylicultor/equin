import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { JobQueue } from "@plugins/infra/plugins/jobs/server";
import { createMemoryQueue } from "./internal/memory-queue";

export default {
  description:
    "The in-process job queue: provides the JobQueue host service in memory — a row runs in this process when it is due (a transaction's enqueue only once it commits), scheduled jobs fire on a one-shot timer to their next due minute, nothing survives a reload. For a host without the desktop's graphile queue; never booted by the desktop.",
  portable: true,
  contributions: [JobQueue.provide(createMemoryQueue())],
} satisfies ServerPluginDefinition;
