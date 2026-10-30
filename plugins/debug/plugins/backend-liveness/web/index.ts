import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { BackendFrozenSummary } from "./components/backend-frozen-summary";

export default {
  collapsed: true,
  description:
    "Backend-frozen report renderer: a one-line Debug → Reports summary for the backend-frozen kind.",
  contributions: [
    Reports.KindView({
      match: "backend-frozen",
      component: BackendFrozenSummary,
    }),
  ],
} satisfies PluginDefinition;
