import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { PinDriftDetail } from "./components/pin-drift-detail";
import { usePinDriftHealth } from "./internal/use-pin-health";

export default {
  description:
    "The health report's Pinned binaries row: attention while a pinned dependency (a host daemon's binaries — Postgres, PgBouncer) lags what main's checkout declares, or its live daemon still runs a pin moved since; expanded, each one's pinned and declared versions and the `./equin deps pin <id>` command that switches it — or, for a move its pin refuses (a Postgres major), why it is blocked.",
  contributions: [
    HealthReport.Row({
      kind: "status",
      id: "pinned-deps",
      title: "Pinned binaries",
      useStatus: usePinDriftHealth,
      component: PinDriftDetail,
    }),
  ],
} satisfies PluginDefinition;
