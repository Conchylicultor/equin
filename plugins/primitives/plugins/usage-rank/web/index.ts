import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { usageStatsDemo } from "./internal/demo-resource";

export { recordUsage } from "./internal/record-usage";
export { useUsageOrder } from "./internal/use-usage-order";
export { useRecentUsage } from "./internal/use-recent-usage";

export default {
  description:
    "Frecency usage ranking for any (namespace, key) set: recordUsage() fires one atomic decay-and-increment, useUsageOrder() returns the most-used-first order — one coalesced id-set subscription, frozen per context so chips never move under the cursor, seeded from a local cache so the first paint does not re-sort — and useRecentUsage() lists a namespace's most recently used keys (a bounded window), for a Recent row with no candidate set to rank.",
  contributions: [usageStatsDemo],
} satisfies PluginDefinition;
