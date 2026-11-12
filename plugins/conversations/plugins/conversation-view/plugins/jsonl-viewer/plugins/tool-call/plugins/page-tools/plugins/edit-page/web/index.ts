import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { EditPageView } from "./components/edit-page-view";

export default {
  description:
    "Renders edit_page MCP tool calls as a side-by-side markdown diff, with the edited page as a clickable chip and what the write changed.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: /edit_page$/,
      icon: symbol("article"),
      component: EditPageView,
    }),
  ],
} satisfies PluginDefinition;
