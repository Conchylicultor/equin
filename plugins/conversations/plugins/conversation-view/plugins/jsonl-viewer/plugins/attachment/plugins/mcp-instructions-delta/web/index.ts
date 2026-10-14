import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { McpInstructionsDeltaView } from "./components/mcp-instructions-delta-view";

export default {
  collapsed: true,
  description:
    "Renders mcp_instructions_delta attachment events — an MCP server's standing instructions entering or leaving the agent's context mid-session — in the same +/− grammar as the deferred-tools delta.",
  contributions: [
    ...attachmentRenderer({
      match: "mcp_instructions_delta",
      component: McpInstructionsDeltaView,
      role: "context",
    }),
  ],
} satisfies PluginDefinition;
