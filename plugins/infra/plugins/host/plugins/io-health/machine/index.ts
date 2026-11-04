import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { hostIoDegradedKind } from "./internal/report-kind";
import { hostIoHealthServed } from "./internal/served";
import {
  fsLatencyLogWatcher,
  startIoHealth,
  stopIoHealth,
} from "./internal/service";

export default {
  description:
    "Host file-I/O health, desktop-only: follows the fs-latency monitor's log (fs-latency.jsonl in the monitors' log dir, a file watcher — no timer) through the io-health detector, serves the result as the host.io-health live value (the monitor missing, or its newest tick and every finding holding over the trailing hour), and on main files each finding as a host-io-degraded report when raised and every hour it holds.",
  register: [fsLatencyLogWatcher],
  contributions: [hostIoDegradedKind, ...hostIoHealthServed.declare],
  onReady: async () => {
    await startIoHealth();
  },
  onShutdown: async () => {
    await stopIoHealth();
  },
} satisfies MachinePluginDefinition;
