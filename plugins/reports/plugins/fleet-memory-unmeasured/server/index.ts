import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { fleetMemoryUnmeasuredKind } from "./internal/kind";

export default {
  description:
    "fleet-memory-unmeasured report kind: validates the payload a cpu grant acquire files (through the report outbox) when no fresh fleet memory reading exists — main's owner sampler stopped or main is down — and renders a task naming the cause, the reading's age and the acquiring process. One row per cause.",
  contributions: [fleetMemoryUnmeasuredKind],
} satisfies ServerPluginDefinition;
