import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { createShedBuffer } from "./internal/shed-buffer";
export type {
  ShedBuffer,
  ShedBufferOptions,
  ShedCascadeStats,
  ShedSummary,
} from "./internal/shed-buffer";

export default {
  description:
    "The duress shed engine: createShedBuffer routes an observability choke point's durable writes through per-episode first-N persistence, a bounded in-memory buffer and a flush-on-clear replay, gated on the duress latch and tuned live by the duress config.",
} satisfies ServerPluginDefinition;
