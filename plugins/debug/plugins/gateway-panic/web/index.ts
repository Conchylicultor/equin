import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { GatewayPanicSummary } from "./components/gateway-panic-summary";

export default {
  collapsed: true,
  description:
    "Gateway-panic report renderer: a one-line Debug → Reports summary for the gateway-panic kind (where the gateway panicked, the request, how many times).",
  contributions: [
    Reports.KindView({
      match: "gateway-panic",
      component: GatewayPanicSummary,
    }),
  ],
} satisfies PluginDefinition;
