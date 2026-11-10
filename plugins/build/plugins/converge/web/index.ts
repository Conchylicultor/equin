import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { MainDeployFailedSummary } from "./components/main-deploy-failed-summary";

export default {
  collapsed: true,
  description:
    "Main-deploy-failed report renderer: a one-line Debug → Reports summary for the main-deploy-failed kind (how main's convergence run ended, what started it).",
  contributions: [
    Reports.KindView({
      match: "main-deploy-failed",
      component: MainDeployFailedSummary,
    }),
  ],
} satisfies PluginDefinition;
