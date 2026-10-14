import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { loopConfig } from "../shared/config";

// Server runtime exists solely to register the loop's config descriptor —
// config_v2 reads back undefined unless the descriptor is registered on BOTH
// web (WebRegister) and server (Register).
export default {
  description:
    "Server registration of the A–B loop's repeat options (show loop ahead, rest before repeat).",
  contributions: [ConfigV2.Register({ descriptor: loopConfig })],
} satisfies ServerPluginDefinition;
