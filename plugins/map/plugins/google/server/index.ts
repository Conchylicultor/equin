import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { googleMapConfig } from "../shared/config";

export default {
  description:
    "Stores the Google map's settings (Scroll zoom speed) so Settings can edit them.",
  contributions: [ConfigV2.Register({ descriptor: googleMapConfig })],
} satisfies ServerPluginDefinition;
