import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { backgroundMusicConfig } from "../shared/config";

export default {
  description:
    "Registers the background music config (Keep playing across apps) for Settings → Config.",
  contributions: [ConfigV2.Register({ descriptor: backgroundMusicConfig })],
} satisfies ServerPluginDefinition;
