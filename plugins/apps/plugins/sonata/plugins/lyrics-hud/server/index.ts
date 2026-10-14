import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { lyricsHudConfig } from "../shared/config";

// Server runtime exists solely to register the lyrics corner's config
// descriptor — config_v2 reads back undefined unless the descriptor is
// registered on BOTH web (WebRegister) and server (Register).
export default {
  description:
    "Server registration of the Sonata lyrics corner config (show lyrics over the piano roll).",
  contributions: [ConfigV2.Register({ descriptor: lyricsHudConfig })],
} satisfies ServerPluginDefinition;
