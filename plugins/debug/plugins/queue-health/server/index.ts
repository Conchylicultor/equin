import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { queueHealthConfig } from "../core";

// The settings are portable data; everything that reads graphile's queue is
// this plugin's machine half (`../machine`).
export default {
  description:
    "Queue-health settings: registers the queue-health config (watchdog thresholds) for Settings → Config. The watchdog, its report kinds, the summary endpoint, the get_queue_health MCP tool and the queue-health.pulse resource read the desktop's graphile queue and live in this plugin's machine half.",
  contributions: [ConfigV2.Register({ descriptor: queueHealthConfig })],
} satisfies ServerPluginDefinition;
