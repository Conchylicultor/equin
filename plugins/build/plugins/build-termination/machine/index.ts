import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { buildRunTerminationServed } from "./internal/termination-value";

export default {
  description:
    "Per-run termination record, desktop-only: the build.run-termination live value — what the host-global signal-origin sink recorded about the death of one build run (which signal, and who sent it), notified by a watch on the sink.",
  contributions: [...buildRunTerminationServed.declare],
} satisfies MachinePluginDefinition;
