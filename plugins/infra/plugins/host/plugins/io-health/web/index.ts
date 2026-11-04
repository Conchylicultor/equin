import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { HOST_IO_DEGRADED_KIND } from "../core";
import { HostIoDegradedSummary } from "./components/host-io-degraded-summary";
import { useIoHealth } from "./internal/use-io-health";

export default {
  description:
    "Host file-I/O health, shown: the health report's Disk I/O row (attention while a finding holds — critical for a metadata stall — or while the fs-latency monitor is not installed or has stopped writing; never green before the read lands) and the one-line Debug → Reports summary of the host-io-degraded kind.",
  contributions: [
    Reports.KindView({
      match: HOST_IO_DEGRADED_KIND,
      component: HostIoDegradedSummary,
    }),
    HealthReport.Row({
      kind: "status",
      id: "host-io",
      title: "Disk I/O",
      useStatus: useIoHealth,
    }),
  ],
} satisfies PluginDefinition;
