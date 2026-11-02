import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { launchPromptsConfig } from "../shared/config";

export default {
  description:
    "Pre-configured prompts that launch a new background conversation in the same worktree.",
  contributions: [ConfigV2.Register({ descriptor: launchPromptsConfig })],
} satisfies ServerPluginDefinition;
