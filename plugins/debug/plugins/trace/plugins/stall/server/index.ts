import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { stallClass } from "./internal/class";

export { stallClass } from "./internal/class";

export default {
  description:
    "Built-in trace event class 'stall': the sampled JS call-stack histogram (top leaves + collapsed stack signatures) captured during an event-loop freeze, passed in by the health-monitor sampler through stallClass.supply.",
  contributions: [stallClass.contribution],
} satisfies ServerPluginDefinition;
