import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export type { PagePauses } from "./internal/pauses";
export { pausesDuring, STALL_MIN_MS } from "./internal/pauses";

export default {
  description:
    "Was this page paused during a span of wall-clock time? pausesDuring(start, end): how long it was hidden or frozen inside it (visibilitychange, Page Lifecycle freeze), and how long its main thread was stalled outside that (long animation frames ≥ 1 s, the bar main-thread-stall files its own slow-op at) — the one record every client latency consumer reads instead of tracking visibility itself.",
  contributions: [],
} satisfies PluginDefinition;
