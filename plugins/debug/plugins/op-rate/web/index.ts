import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Reports } from "@plugins/reports/web";
import { opRateConfig } from "../core";
import { OpRateSummary } from "./components/op-rate-summary";
import { OpTimeSummary } from "./components/op-time-summary";

export default {
  description:
    "Op-rate + op-time report renderers: one-line Debug → Reports summaries for the op-rate (call-count) and op-time (aggregate-time, with View-trace chip) kinds, plus the per-kind threshold/budget config registration.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: opRateConfig }),
    Reports.KindView({ match: "op-rate", component: OpRateSummary }),
    Reports.KindView({ match: "op-time", component: OpTimeSummary }),
  ],
} satisfies PluginDefinition;
