import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { ReportStormSummary } from "./components/report-storm-summary";

export default {
  description:
    "Report-storm renderer: a one-line Debug → Reports summary (collapsed kind + how many fingerprints raised how many alerts against the window budget) for the report-storm kind.",
  contributions: [
    Reports.KindView({ match: "report-storm", component: ReportStormSummary }),
  ],
} satisfies PluginDefinition;
