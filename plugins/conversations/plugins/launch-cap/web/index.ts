import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { agentLaunchConfig } from "../core";

export default {
  description:
    "Web registration of the agent-launch config (the host-wide auto-start cap), for Settings → Config.",
  contributions: [ConfigV2.WebRegister({ descriptor: agentLaunchConfig })],
} satisfies PluginDefinition;
