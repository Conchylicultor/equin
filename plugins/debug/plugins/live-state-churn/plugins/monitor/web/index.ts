import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Reports } from "@plugins/reports/web";
import { liveStateChurnConfig } from "../core";
import { NoopSummary } from "./components/noop-summary";

export default {
  description:
    "Live-state churn report renderer: a one-line Debug → Reports summary for the live-state-noop kind, plus the threshold config registration.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: liveStateChurnConfig }),
    Reports.KindView({ match: "live-state-noop", component: NoopSummary }),
  ],
} satisfies PluginDefinition;
