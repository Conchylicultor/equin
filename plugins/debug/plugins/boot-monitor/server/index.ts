import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { bootMonitorConfig } from "../core";
import { gatewayReport } from "../shared/endpoints";
import { handleGatewayReport } from "./internal/gateway-report";
import { bootMonitorJob } from "./internal/monitor-job";

export { getGatewayBootReport } from "./internal/gateway-report";

export default {
  description:
    "Time-to-ready boot monitor: a cheap per-worktree scheduled job that, once the server is ready (markServerReady stamped the profiler's timeToReadyMs), mints ONE 'boot' slow-op row (operation server-ready) + coherent trace per boot that took longer than its budget to become ready — evidence-first, deduped per boot epoch — folding in the gateway-observed readiness wait when the gateway POSTed /api/boot/gateway-report. Post-ready warm-ups are not judged here (each has its own budget).",
  register: [bootMonitorJob],
  contributions: [ConfigV2.Register({ descriptor: bootMonitorConfig })],
  httpRoutes: {
    [gatewayReport.route]: handleGatewayReport,
  },
} satisfies ServerPluginDefinition;
