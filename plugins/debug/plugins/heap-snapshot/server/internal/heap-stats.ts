import { heapStats } from "bun:jsc";
import { physFootprintBytes } from "@plugins/framework/plugins/server-core/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import type { HeapStats } from "../../shared/endpoints";
import { heapStatsValue } from "../../shared/resources";

const BYTES_PER_MB = 1024 * 1024;

// `heapStats()` is a cheap aggregated snapshot (no full graph walk), so it is
// safe to re-measure on every read — it backs the everyday object-type table.
function measureHeap(): HeapStats {
  const stats = heapStats();
  const types = Object.entries(stats.objectTypeCounts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  // Real footprint vs JS heap — the discriminator for "is the balloon JS or native?".
  const footprintBytes = physFootprintBytes() ?? process.memoryUsage().rss;
  return {
    heapSizeMb: stats.heapSize / BYTES_PER_MB,
    heapCapacityMb: stats.heapCapacity / BYTES_PER_MB,
    objectCount: stats.objectCount,
    physFootprintMb: footprintBytes / BYTES_PER_MB,
    types,
  };
}

export const heapStatsServed = serveValue(heapStatsValue, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "a point-in-time measure of this process's heap; re-measured on refresh()",
    },
  },
  loader: measureHeap,
});
