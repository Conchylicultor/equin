import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { actionBarConfig } from "../shared/config";

export default {
  description:
    "Shared cross-app action set: registers the action-bar config so the bar's enabled toggle persists.",
  contributions: [ConfigV2.Register({ descriptor: actionBarConfig })],
} satisfies ServerPluginDefinition;
