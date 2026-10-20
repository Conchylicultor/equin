import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineUsageServed } from "./internal/sample";

export default {
  description:
    "Where the machine's CPU and memory go: the sentinel.machine-usage value — one ps over every process, attributed to the user's Chrome, the agents' ops (each running op marker's process tree), the agent browser (its host's process tree) or other, memory as each process's physical footprint — sampled on subscribe, served on every backend.",
  contributions: [...machineUsageServed.declare],
} satisfies MachinePluginDefinition;
