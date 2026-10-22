import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { ReconnectWatcher } from "./components/reconnect-watcher";
import { WedgeWatchdog } from "./components/wedge-watchdog";
import { useConnectionHealth } from "./internal/use-connection-health";

export { wedgeReportSink } from "./internal/wedge-report-sink";
export type { WedgeReport } from "./internal/wedge-report-sink";

export default {
  description:
    "Surfaces server restarts as a toast; exposes /api/health helpers; reports the server and central socket connection as the health report's Connection row.",
  contributions: [
    Core.Root({ component: ReconnectWatcher }),
    Core.Root({ component: WedgeWatchdog }),
    HealthReport.Row({
      kind: "status",
      id: "connection",
      title: "Connection",
      order: 10,
      useStatus: useConnectionHealth,
    }),
  ],
} satisfies PluginDefinition;
