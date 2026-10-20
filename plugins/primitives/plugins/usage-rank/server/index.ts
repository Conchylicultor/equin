import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { recordUsageEndpoint } from "../core";
import { handleRecordUsage } from "./internal/routes";
import { usageStatsServed } from "./internal/resource";

export { _usageStats } from "./internal/tables";

export default {
  portable: true,
  description:
    "Owns the usage_stats table: one frecency rollup per (namespace, key), updated by a single atomic decay-and-increment upsert, served as a lookup-only live collection read by id set (the nightly 1-year retention sweep is the machine half).",
  httpRoutes: {
    [recordUsageEndpoint.route]: handleRecordUsage,
  },
  contributions: [...usageStatsServed.declare],
} satisfies ServerPluginDefinition;
