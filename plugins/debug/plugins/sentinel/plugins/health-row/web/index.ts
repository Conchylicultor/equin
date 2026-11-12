import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { MachineWatcherDetail } from "./components/machine-watcher-detail";
import { MachineWatcherGlance } from "./components/machine-watcher-glance";
import { useMachineWatcherHealth } from "./internal/use-machine-watcher-health";

export default {
  description:
    "The health report's Machine watcher row: critical while main's watcher is down or its process is gone or the disk is nearly full, attention while it restarts, the machine is under duress or the disk is low or filling fast (read from the sentinel.status push resource), with its stats — load per core, available memory, free disk and builds at a glance, and, when expanded, each signal that can trip duress against its limit (the sentinel.vitals push resource) and where the machine's CPU and memory go (machine-usage).",
  contributions: [
    HealthReport.Row({
      kind: "status",
      id: "machine-watcher",
      title: "Machine watcher",
      useStatus: useMachineWatcherHealth,
      // Both read the per-tick vitals, and both mount only while the report is
      // open (the detail only while the row is expanded) — the summary above
      // never subscribes to them.
      glance: MachineWatcherGlance,
      component: MachineWatcherDetail,
    }),
  ],
} satisfies PluginDefinition;
