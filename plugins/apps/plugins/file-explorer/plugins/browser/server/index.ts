import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { filesConfig } from "../core";

export default {
  description:
    "Registers the Files start-folder config: the folder the file explorer opens on when launched.",
  contributions: [ConfigV2.Register({ descriptor: filesConfig })],
} satisfies ServerPluginDefinition;
