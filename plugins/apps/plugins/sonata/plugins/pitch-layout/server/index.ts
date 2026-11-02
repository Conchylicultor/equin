import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { pitchLayoutConfig } from "../core";

// Server runtime exists solely to register the pitch-layout config descriptor —
// config_v2 reads back undefined unless the descriptor is registered on BOTH
// web (WebRegister) and server (Register).
export default {
  description:
    "Server registration of the Sonata pitch-layout config (piano / Jankó).",
  contributions: [ConfigV2.Register({ descriptor: pitchLayoutConfig })],
} satisfies ServerPluginDefinition;
