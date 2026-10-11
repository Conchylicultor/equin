import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { bootMonitorConfig } from "../core";
import { gatewayReport } from "../shared/endpoints";
import { handleGatewayReport } from "./internal/gateway-report";
import { bootMonitorJob } from "./internal/monitor-job";

export { getGatewayBootReport } from "./internal/gateway-report";

export default {
  description:
    "Whole-boot monitor: a cheap per-worktree scheduled job that, once the boot profile is complete (drainWarmups present), mints ONE 'boot' slow-op row + coherent trace per over-budget server boot — evidence-first, deduped per boot epoch — folding in the gateway-observed readiness wait when the gateway POSTed /api/boot/gateway-report.",
  register: [bootMonitorJob],
  contributions: [ConfigV2.Register({ descriptor: bootMonitorConfig })],
  httpRoutes: {
    [gatewayReport.route]: handleGatewayReport,
  },
} satisfies ServerPluginDefinition;
