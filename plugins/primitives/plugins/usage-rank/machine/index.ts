import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { usageStatsRetention } from "./internal/retention";

export default {
  description:
    "The usage_stats retention, desktop-only half: the nightly sweep of keys unused for a year, a scheduled job a host without the computer never runs.",
  register: [usageStatsRetention],
} satisfies MachinePluginDefinition;
