import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { TimelineToolView } from "./components/timeline-tool-view";

export default {
  description:
    "Renders get_timeline MCP tool calls: the window and filters asked for in the summary, the events found in the note, and the report as sections inside — events as a compact table, duress, host pressure and backend health as lines.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: /get_timeline$/,
      icon: symbol("timeline"),
      component: TimelineToolView,
    }),
  ],
} satisfies PluginDefinition;
