import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Reports } from "@plugins/reports/web";
import { clientRateConfig } from "../core";
import { ClientRateSummary } from "./components/client-rate-summary";

export default {
  description:
    "Client-rate report renderer: a one-line Debug → Reports summary (how many page loads one tab made this hour, against the usual client-hour, marked when automated), plus the config registration.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: clientRateConfig }),
    Reports.KindView({ match: "client-rate", component: ClientRateSummary }),
  ],
} satisfies PluginDefinition;
