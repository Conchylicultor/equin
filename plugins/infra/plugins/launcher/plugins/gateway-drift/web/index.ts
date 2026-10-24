import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { useGatewayHealth } from "./internal/use-gateway-health";

export default {
  description:
    "Gateway drift, shown: the health report's Gateway row — attention while the machine's login-service gateway (installed or running) differs from what ./equin start --force would install now from main, naming each difference (binary, -listen and the other flags, cwd, signature) and the command; folded with Connection, Database and Live reads while current.",
  contributions: [
    HealthReport.Row({
      kind: "status",
      id: "gateway",
      title: "Gateway",
      // After Connection (10), Database (20) and Live reads (30): the
      // infrastructure the page runs on, ending with the front door's own
      // currency. Summary-only, so it folds with them while current.
      order: 40,
      useStatus: useGatewayHealth,
    }),
  ],
} satisfies PluginDefinition;
