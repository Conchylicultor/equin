import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { bootClass } from "./internal/class";

export { bootClass } from "./internal/class";

export default {
  description:
    "Built-in trace event class 'boot': the server-boot profile (phase spans + memory checkpoints + optional gateway readiness wait) pre-aggregated by debug/boot-monitor and supplied by the producer through bootClass.supply.",
  contributions: [bootClass.contribution],
} satisfies ServerPluginDefinition;
