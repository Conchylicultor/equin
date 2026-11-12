import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { ReadPageView } from "./components/read-page-view";

export default {
  description:
    "Renders read_page MCP tool calls: the page the read was scoped to as a clickable chip, and the markdown it returned.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: /read_page$/,
      icon: symbol("article"),
      component: ReadPageView,
    }),
  ],
} satisfies PluginDefinition;
