import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { WebSearchToolView } from "./components/web-search-tool-view";

export default {
  description:
    "Renders WebSearch calls as the query and its source count; opened, the model-written summary in full and the sources grouped by site, folded beneath it.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: "WebSearch",
      icon: symbol("travel-explore"),
      component: WebSearchToolView,
    }),
  ],
} satisfies PluginDefinition;
