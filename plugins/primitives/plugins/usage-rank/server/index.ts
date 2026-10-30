import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { recordUsageEndpoint } from "../core";
import { handleRecordUsage } from "./internal/routes";
import { usageStatsServed } from "./internal/resource";
import { usageStatsRetention } from "./internal/retention";

export { _usageStats } from "./internal/tables";

export default {
  portable: true,
  description:
    "Owns the usage_stats table: one frecency rollup per (namespace, key), updated by a single atomic decay-and-increment upsert, served as a lookup-only live collection read by id set, and the nightly sweep of keys unused for a year.",
  register: [usageStatsRetention],
  httpRoutes: {
    [recordUsageEndpoint.route]: handleRecordUsage,
  },
  contributions: [...usageStatsServed.declare],
} satisfies ServerPluginDefinition;
