import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { hibernationConfig } from "@plugins/conversations/core";

export { useMarkConversationViewed } from "./internal/mark-viewed";

export default {
  description:
    "Records conversation selection so idle hibernation can reset the idle timer and transparently resume.",
  contributions: [ConfigV2.WebRegister({ descriptor: hibernationConfig })],
} satisfies PluginDefinition;
