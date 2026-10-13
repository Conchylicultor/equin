import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Cheap aggregated heap breakdown from bun:jsc `heapStats()`. Memory values are
// MB (converted from bytes). `types` is the per-JS-type object count map sorted
// descending by count — the direct "what is on the heap" answer.
export const HeapStatsSchema = z.object({
  heapSizeMb: z.number(),
  heapCapacityMb: z.number(),
  objectCount: z.number(),
  // Real macOS phys_footprint (MB; rss off-darwin). heapSize ≈ footprint ⇒ JS
  // allocation; heapSize ≪ footprint ⇒ off-heap/native (the A3 discriminator).
  physFootprintMb: z.number(),
  types: z.array(z.object({ type: z.string(), count: z.number() })),
});
export type HeapStats = z.infer<typeof HeapStatsSchema>;

// Result of a full on-demand `.heapsnapshot` dump to disk.
export const HeapSnapshotResponseSchema = z.object({
  path: z.string(),
  sizeBytes: z.number(),
  capturedAtMs: z.number(),
});
export type HeapSnapshotResponse = z.infer<typeof HeapSnapshotResponseSchema>;

// Heavy on-demand dump. POST so it never runs from a cache/prefetch.
export const captureHeapSnapshot = defineEndpoint({
  route: "POST /api/debug/heap-snapshot",
  response: HeapSnapshotResponseSchema,
});
