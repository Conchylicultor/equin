import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { STEP_REGRESSION_KIND } from "../core";
import { StepRegressionSummary } from "./components/step-regression-summary";

export default {
  description:
    "Build-step-regression report kind's Debug → Reports summary view: one line naming the step, its value against its baseline, and for file calls where the extra calls went. Filed by main's build through the report outbox — no collector here.",
  contributions: [
    Reports.KindView({
      match: STEP_REGRESSION_KIND,
      component: StepRegressionSummary,
    }),
  ],
} satisfies PluginDefinition;
