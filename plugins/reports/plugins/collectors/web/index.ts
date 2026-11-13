import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { ReportSinks } from "./slots";
import { SinkCollectors } from "./components/sink-collectors";

export { ReportSinks } from "./slots";

export default {
  description:
    "The browser's sink collectors, opted into as a set: owns ReportSinks.Collector — a companion keyed by its producer's plugin id (`from`), so a collector ships only where this plugin (named by the reporters pack) AND the producer whose sink it drains both ship — and the host that attaches every collector it sees, at the page root and inside every plugin scope.",
  slots: ReportSinks,
  contributions: [Core.Root({ component: SinkCollectors, scope: "each" })],
} satisfies PluginDefinition;
