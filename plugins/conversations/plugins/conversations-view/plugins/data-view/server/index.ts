import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { conversationListConfig } from "../shared/config";

export default {
  description:
    "Registers the conversation list's config (which title each row shows) so the Settings → Config value persists.",
  contributions: [ConfigV2.Register({ descriptor: conversationListConfig })],
} satisfies ServerPluginDefinition;
