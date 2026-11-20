import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Reports } from "@plugins/reports/web";
import { stallMonitorConfig } from "../core";
import { StallSummary } from "./components/stall-summary";

export default {
  description:
    "Event-loop stall report renderer: a one-line Debug → Reports summary for the event-loop-stall kind (hot frame + View-trace chip), plus the enabled config registration.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: stallMonitorConfig }),
    Reports.KindView({ match: "event-loop-stall", component: StallSummary }),
  ],
} satisfies PluginDefinition;
