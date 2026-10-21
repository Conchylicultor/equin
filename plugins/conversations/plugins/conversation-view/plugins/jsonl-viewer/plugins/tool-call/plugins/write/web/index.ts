import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { WriteToolView } from "./components/write-tool-view";

export default {
  description:
    "Renders Write tool calls with syntax-highlighted file content and clickable path affordances.",
  contributions: [
    // Defaults every field, so the file fills in as the model writes it.
    JsonlViewerTool.Renderer({
      match: "Write",
      component: WriteToolView,
      partialInput: true,
    }),
  ],
} satisfies PluginDefinition;
