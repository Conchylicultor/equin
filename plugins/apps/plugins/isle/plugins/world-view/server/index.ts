import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { isleConfig } from "../core";

export default {
  description:
    "Server registration of the Isle config (seed, time of day, music).",
  contributions: [ConfigV2.Register({ descriptor: isleConfig })],
} satisfies ServerPluginDefinition;
