import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Reports } from "@plugins/reports/web";
import { bootBudgetConfig } from "../core";
import { BootBudgetSummary } from "./components/boot-budget-summary";

export default {
  description:
    "Boot-budget report renderer: a one-line Debug → Reports summary for the boot-budget kind, plus the per-phase budget config registration.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: bootBudgetConfig }),
    Reports.KindView({ match: "boot-budget", component: BootBudgetSummary }),
  ],
} satisfies PluginDefinition;
