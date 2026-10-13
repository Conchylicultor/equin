import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { traceConfig } from "../core";
import { Trace } from "./slots";

export { Trace } from "./slots";
export type {
  TraceLaneProps,
  TraceTriggerSummaryProps,
  TraceSelection,
  TraceSelectionField,
} from "./slots";

export default {
  description:
    "Trace-engine web surface: the Trace.Lane / Trace.TriggerSummary dispatch slots (with generic fallbacks so a new event class or trigger kind is visible by default), plus the trace config registration for Settings → Config.",
  contributions: [ConfigV2.WebRegister({ descriptor: traceConfig })],
  slots: Trace,
} satisfies PluginDefinition;
