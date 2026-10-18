import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { shelfConfig } from "../core";

export default {
  description:
    "Desktop shell, server side: registers the desktop's global shelf config (the apps kept in the dock).",
  contributions: [ConfigV2.Register({ descriptor: shelfConfig })],
} satisfies ServerPluginDefinition;
