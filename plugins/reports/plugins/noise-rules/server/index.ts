import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportNoiseRule } from "@plugins/reports/server";
import {
  claudeCliSignalKillRule,
  liveStateWedgeRestartRule,
  resizeObserverRule,
  staleFrontendRule,
} from "./internal/rules";

export default {
  description:
    "Built-in noise classification rules for low-signal crashes (e.g. ResizeObserver loop warnings).",
  contributions: [
    ReportNoiseRule(resizeObserverRule),
    ReportNoiseRule(claudeCliSignalKillRule),
    ReportNoiseRule(staleFrontendRule),
    ReportNoiseRule(liveStateWedgeRestartRule),
  ],
} satisfies ServerPluginDefinition;
