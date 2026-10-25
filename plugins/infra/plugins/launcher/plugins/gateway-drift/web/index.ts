import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { UpdateGatewayButton } from "./components/update-gateway-button";
import { useGatewayHealth } from "./internal/use-gateway-health";

export default {
  description:
    "Gateway drift, shown: the health report's Gateway row — attention while the machine's login-service gateway (installed or running) differs from what ./equin start --force would install now from main, in one line, with an Update remedy launching an agent briefed with each difference (binary, -listen and the other flags, cwd, signature) to run it; folded with Connection, Database and Live reads while current.",
  contributions: [
    HealthReport.Row({
      kind: "status",
      id: "gateway",
      title: "Gateway",
      useStatus: useGatewayHealth,
      // Drawn only while out of date, so the row still folds while current.
      remedy: UpdateGatewayButton,
    }),
  ],
} satisfies PluginDefinition;
