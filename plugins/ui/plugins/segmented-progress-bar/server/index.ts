import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { segmentedProgressBarConfig } from "../core";

export default {
  contributions: [ConfigV2.Register({ descriptor: segmentedProgressBarConfig })],
  portable: true,
} satisfies ServerPluginDefinition;
