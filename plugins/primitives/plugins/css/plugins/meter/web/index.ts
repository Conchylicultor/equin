import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  Meter,
  type MeterProps,
  type MeterRole,
  type MeterSize,
  type MeterTone,
} from "./internal/meter";

export default {
  description:
    "Linear meter / progress-bar primitive: <Meter value label tone size marker role> draws a fully-rounded track filling its container's width, filled to a 0..1 fraction (clamped) in a tone (default accent text colour, warning, destructive, muted) with a smooth width transition, plus an optional target/pace tick overhanging the bar. role meter (a measurement) or progressbar (a task's progress), with the aria value attributes.",
  contributions: [],
} satisfies PluginDefinition;
