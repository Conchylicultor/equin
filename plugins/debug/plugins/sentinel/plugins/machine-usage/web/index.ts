import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { MachineUsageBreakdown } from "./components/machine-usage-breakdown";

export default {
  description:
    "The Machine watcher card's \"Where it goes\" block (MachineUsageBreakdown): the machine's CPU and memory as two bars split into your Chrome, agent ops, the agent browser and other, then one line per bucket — read from the sentinel.machine-usage value, sampled when the card opens.",
  contributions: [],
} satisfies PluginDefinition;
