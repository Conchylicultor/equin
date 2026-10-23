import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { partyConfig } from "../core";

// config_v2 reads back undefined unless the descriptor is registered on BOTH
// web (WebRegister) and server (Register).
export default {
  description: "Server registration of the Keyboard Party config.",
  contributions: [ConfigV2.Register({ descriptor: partyConfig })],
} satisfies ServerPluginDefinition;
