import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { buildRunLogsServed } from "./internal/run-logs-value";

export default {
  description:
    "Serves build.run-logs: one build run's persisted log, newest line first, paged, with its steps as the meta — read from the run's files on disk, notified by the supervisor's own tail of its transcript and a watch of its step log.",
  contributions: [...buildRunLogsServed.declare],
} satisfies MachinePluginDefinition;
