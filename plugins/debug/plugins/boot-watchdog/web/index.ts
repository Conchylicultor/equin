import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Reports } from "@plugins/reports/web";
import { bootWatchdogConfig } from "../core";
import { BootWedgeSummary } from "./components/boot-wedge-summary";

export default {
  description:
    "Boot-wedge report renderer: a one-line Debug → Reports summary for the boot-wedge kind, plus the boot-watchdog budget/lookback config registration.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: bootWatchdogConfig }),
    Reports.KindView({ match: "boot-wedge", component: BootWedgeSummary }),
  ],
} satisfies PluginDefinition;
