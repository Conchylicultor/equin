import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { nativeNotificationsConfig } from "../shared/config";

export default {
  description:
    "Registers the native-notifications config (enabled, off by default) so the menu-bar panel's switch persists.",
  contributions: [ConfigV2.Register({ descriptor: nativeNotificationsConfig })],
  portable: true,
} satisfies ServerPluginDefinition;
