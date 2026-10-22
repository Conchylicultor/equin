import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  pushesStepBreakdownServed,
  pushesThroughputServed,
  pushesWaitTimeServed,
} from "./internal/served";

export default {
  description:
    "Push contention stats, desktop-only half: the wait-time, throughput and step-breakdown live values, SQL aggregates over op-store's op_log_ops (this machine's op log), so a host without the computer answers them unavailable.",
  contributions: [
    ...pushesWaitTimeServed.declare,
    ...pushesThroughputServed.declare,
    ...pushesStepBreakdownServed.declare,
  ],
} satisfies MachinePluginDefinition;
