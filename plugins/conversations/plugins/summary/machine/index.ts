import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { generateConversationSummary } from "../shared/endpoints";
import { handleGenerate } from "./internal/handle-generate";
import { submitConversationSummaryTool } from "./internal/mcp-tools";

export default {
  description:
    "Conversation summaries, desktop-only half: the generate endpoint (needsMachine) — writes the transcript context to a file and launches the Sonnet conversation that curates the summary — and the submit_conversation_summary MCP tool that conversation calls.",
  register: [submitConversationSummaryTool],
  httpRoutes: {
    [generateConversationSummary.route]: handleGenerate,
  },
} satisfies MachinePluginDefinition;
