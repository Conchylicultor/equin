import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useOptimisticResource } from "./internal/use-optimistic-resource";
export type {
  OptimisticOptions,
  OptimisticResult,
  OptimisticSettled,
} from "./internal/use-optimistic-resource";
export { awaitResourceWrite } from "./internal/await-resource-write";
export { OpNoLongerApplies } from "./internal/overlay";
export {
  enqueueResourceWrite,
  enqueueDetachedWrite,
} from "./internal/send-lane";
export {
  optimisticDivergenceReportSink,
  optimisticRejectionSink,
} from "./reporter";
export type {
  OptimisticDivergenceReport,
  OptimisticRejectionReport,
} from "./reporter";

export default {
  description:
    "Optimistic-mutation primitive over live-state: useOptimisticResource replays pending ops on server truth (overlay/replay) under the never-revert policy — causal (ack-watermark) and content-based confirmation, denial only under causal proof, keep-rendered transient failures with reconnect auto-retry, and permanent (4xx) rejections dropped and reported.",
  contributions: [],
} satisfies PluginDefinition;
