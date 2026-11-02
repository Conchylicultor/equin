import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { sonataLookConfig } from "../core";

// Server runtime exists solely to register the look config descriptor —
// config_v2 reads back undefined unless the descriptor is registered on BOTH
// web (WebRegister) and server (Register).
export default {
  description:
    "Server registration of the Sonata look config (flat / realistic / sketch).",
  contributions: [ConfigV2.Register({ descriptor: sonataLookConfig })],
} satisfies ServerPluginDefinition;
