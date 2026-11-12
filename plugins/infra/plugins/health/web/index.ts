import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { ReconnectWatcher } from "./components/reconnect-watcher";
import { WedgeWatchdog } from "./components/wedge-watchdog";

export { wedgeReportSink } from "./internal/wedge-report-sink";
export type { WedgeReport } from "./internal/wedge-report-sink";
export { PUSH_STALL_MS } from "./internal/push-stall";

export default {
  description:
    "Surfaces server restarts as a toast; exposes /api/health helpers; watches for a live-state channel that stopped delivering (PUSH_STALL_MS, the threshold its Connection row — the connection-row sub-plugin — shares).",
  contributions: [
    Core.Root({ component: ReconnectWatcher, scope: "page" }),
    Core.Root({ component: WedgeWatchdog, scope: "page" }),
  ],
} satisfies PluginDefinition;
