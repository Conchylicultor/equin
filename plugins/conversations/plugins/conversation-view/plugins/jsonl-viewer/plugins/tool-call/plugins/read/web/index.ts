import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { ReadInputSchema, ReadToolView } from "./components/read-tool-view";

export default {
  description:
    "Renders Read tool calls with syntax-highlighted file content, line-number gutter, and image thumbnails.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: "Read",
      icon: symbol("description"),
      input: ReadInputSchema,
      component: ReadToolView,
    }),
  ],
} satisfies PluginDefinition;
