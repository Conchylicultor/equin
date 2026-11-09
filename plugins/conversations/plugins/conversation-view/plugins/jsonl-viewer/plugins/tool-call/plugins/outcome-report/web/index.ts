import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { SubmitOutcomeReportToolView } from "./components/submit-outcome-report-tool-view";

export default {
  description:
    "Renders submit_outcome_report MCP tool calls: the report's headline as the summary, the markdown body collapsed under it, and the question it asks as a note.",
  contributions: [
    // Every field is optional while the input streams in.
    JsonlViewerTool.Renderer({
      match: /submit_outcome_report$/,
      component: SubmitOutcomeReportToolView,
      partialInput: true,
    }),
  ],
} satisfies PluginDefinition;
