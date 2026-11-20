import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { DuressShedSummary } from "./components/duress-shed-summary";

export default {
  description:
    "Duress-shed report renderer: a one-line Debug → Reports summary (buffer kind + shed/dropped/replayed accounting) for the duress-shed kind.",
  contributions: [
    Reports.KindView({ match: "duress-shed", component: DuressShedSummary }),
  ],
} satisfies PluginDefinition;
