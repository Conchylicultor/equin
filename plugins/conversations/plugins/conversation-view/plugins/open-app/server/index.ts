import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { openAppConfig } from "../shared/config";

// Server runtime exists solely to register the Open app config descriptor —
// config_v2 reads back undefined unless the descriptor is registered on BOTH
// web (WebRegister) and server (Register).
export default {
  description:
    "Server registration of the Open app config (new tab or pane on plain click).",
  contributions: [ConfigV2.Register({ descriptor: openAppConfig })],
} satisfies ServerPluginDefinition;
