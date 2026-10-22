import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useRecordUsage } from "./internal/record-usage";
export type { RecordUsage } from "./internal/record-usage";
export { useUsageOrder } from "./internal/use-usage-order";
export { useRecentUsage } from "./internal/use-recent-usage";

export default {
  description:
    "Frecency usage ranking for any (namespace, key) set: useRecordUsage() returns the recorder that fires one atomic decay-and-increment, useUsageOrder() returns the most-used-first order — one coalesced id-set subscription, frozen per context so chips never move under the cursor, seeded from a local cache so the first paint does not re-sort — and useRecentUsage() lists a namespace's most recently used keys (a bounded window), for a Recent row with no candidate set to rank.",
} satisfies PluginDefinition;
