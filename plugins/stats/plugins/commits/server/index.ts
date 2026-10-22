import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { commitsConfig } from "../shared/config";

export default {
  description: "Commit-based stats: commits and lines of change over time.",
  contributions: [ConfigV2.Register({ descriptor: commitsConfig })],
  portable: true,
} satisfies ServerPluginDefinition;
