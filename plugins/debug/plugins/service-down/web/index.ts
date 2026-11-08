import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { ServiceDownSummary } from "./components/service-down-summary";

export default {
  collapsed: true,
  description:
    "Service-down report renderer: a one-line Debug → Reports summary for the service-down kind (service, how long it had been up, whether it came back).",
  contributions: [
    Reports.KindView({
      match: "service-down",
      component: ServiceDownSummary,
    }),
  ],
} satisfies PluginDefinition;
