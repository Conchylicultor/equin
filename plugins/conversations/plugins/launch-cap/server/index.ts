import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { agentLaunchConfig } from "../core";

export default {
  description:
    "Registers the agent-launch config (maxConcurrent: the host-wide cap on agents the auto-start queue runs at once), from a portable barrel so every host serves it.",
  portable: true,
  contributions: [ConfigV2.Register({ descriptor: agentLaunchConfig })],
} satisfies ServerPluginDefinition;
