import { liveValue } from "@plugins/network/plugins/live/core";
import { HeapStatsSchema } from "./endpoints";

/**
 * This backend's bun:jsc heap breakdown (`heapStats()` plus the process
 * footprint), measured when a reader asks — on mount and on the pane's Refresh
 * (`refresh()`). Cheap: an aggregated count, no graph walk.
 */
export const heapStatsValue = liveValue("heap.stats", {
  schema: HeapStatsSchema,
  load: "snapshot",
});
