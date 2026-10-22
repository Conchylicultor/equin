import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleHealth } from "./internal/handle-health";
import { handleHealthReady } from "./internal/handle-health-ready";
import { getHealth, getHealthReady } from "../core/endpoints";

export default {
  description: "Liveness endpoint used by clients to detect server restarts.",
  httpRoutes: {
    [getHealth.route]: handleHealth,
    [getHealthReady.route]: handleHealthReady,
  },
} satisfies ServerPluginDefinition;
