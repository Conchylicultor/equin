import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { INTERACTION_BUDGET_KIND } from "../core";
import { InteractionBudgetSummary } from "./components/interaction-budget-summary";

export default {
  description:
    "Interaction-budget report kind's Debug → Reports summary view: one line naming the scenario, each case over budget against its budget, and the commit range. Filed by a scenario's budget run through the report outbox — no collector here.",
  contributions: [
    Reports.KindView({
      match: INTERACTION_BUDGET_KIND,
      component: InteractionBudgetSummary,
    }),
  ],
} satisfies PluginDefinition;
