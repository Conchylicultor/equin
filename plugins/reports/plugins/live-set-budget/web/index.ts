import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { OverBudgetKindView } from "./components/over-budget-kind-view";

export default {
  collapsed: true,
  description:
    "Live-set-over-budget report renderer: a one-line Debug → Reports summary (the set's key, its rows against its budget).",
  contributions: [
    Reports.KindView({
      match: "live-set-over-budget",
      component: OverBudgetKindView,
    }),
  ],
} satisfies PluginDefinition;
