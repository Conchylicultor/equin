import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { spawnFailuresDemo } from "./internal/demo-resource";

export default {
  description:
    "Answers the conversation-spawn-failures collection inside a demo scope (no launch failed), so the surfaces that read a conversation's spawn failure render in the demo.",
  contributions: [spawnFailuresDemo],
} satisfies PluginDefinition;
