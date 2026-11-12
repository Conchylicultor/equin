import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { SystemPrompt } from "./internal/registry";
export type { SystemPromptSection } from "./internal/registry";

export default {
  description:
    "What equin appends to an agent's system prompt: the SystemPrompt.Section contribution — a plugin's context about this agent and its task (mandate, global page instructions, task tree), rendered at every spawn of its process and joined in id order inside <equin-context id> after the preprompt (system-prompt/composer composes and records it). The channel for agent context instead of MCP server instructions, which Claude Code cuts at 4,096 characters.",
} satisfies ServerPluginDefinition;
