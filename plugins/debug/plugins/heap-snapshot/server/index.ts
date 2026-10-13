import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { heapStatsServed } from "./internal/heap-stats";
import { handleCaptureSnapshot } from "./internal/handle-capture-snapshot";
import { captureHeapSnapshot } from "../shared/endpoints";

export default {
  description:
    "On-demand heap inspector: a cheap bun:jsc heapStats() object-type breakdown (the heap.stats snapshot value, re-measured on Refresh) plus a heavy full V8 .heapsnapshot dump to disk for offline Chrome DevTools / VS Code analysis (POST). Surfaced as the Debug → Heap pane.",
  httpRoutes: {
    [captureHeapSnapshot.route]: handleCaptureSnapshot,
  },
  contributions: [...heapStatsServed.declare],
} satisfies ServerPluginDefinition;
