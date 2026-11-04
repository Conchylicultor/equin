import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { ExitCleanToolView } from "./components/exit-clean-tool-view";

export default {
  description:
    "Renders exit_clean MCP tool calls as one quiet line — the agent closing its conversation as all-smooth; a refusal opens with the tool's reason.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: /exit_clean$/,
      component: ExitCleanToolView,
    }),
  ],
} satisfies PluginDefinition;
