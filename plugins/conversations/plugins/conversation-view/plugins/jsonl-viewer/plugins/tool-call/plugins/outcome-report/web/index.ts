import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  PartialSubmitOutcomeReportInputSchema,
  SubmitOutcomeReportInputSchema,
  SubmitOutcomeReportToolView,
} from "./components/submit-outcome-report-tool-view";

export default {
  description:
    "Renders submit_outcome_report MCP tool calls: the report's headline as the summary, the markdown body collapsed under it, and the question it asks as a note.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: /submit_outcome_report$/,
      icon: symbol("article"),
      input: SubmitOutcomeReportInputSchema,
      // Every field is optional while the input streams in.
      partialInput: PartialSubmitOutcomeReportInputSchema,
      component: SubmitOutcomeReportToolView,
    }),
  ],
} satisfies PluginDefinition;
