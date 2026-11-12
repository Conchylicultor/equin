import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { useConnectionHealth } from "./internal/use-connection-health";

export default {
  description:
    "The health report's Connection row: this worktree's server and central notification sockets folded into one status — critical when one is closed or every push stopped, attention while one reconnects or one resource's push is stuck.",
  contributions: [
    HealthReport.Row({
      kind: "status",
      id: "connection",
      title: "Connection",
      useStatus: useConnectionHealth,
    }),
  ],
} satisfies PluginDefinition;
