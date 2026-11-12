import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { ToolSearchToolView } from "./components/tool-search-tool-view";
import { ToolSearchInputSchema } from "./internal/tool-search";

export default {
  description:
    "Renders ToolSearch calls as the deferred tools they loaded: the tool names in the row, a select's not-found names flagged, a keyword search's query and match count.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: "ToolSearch",
      icon: symbol("search"),
      input: ToolSearchInputSchema,
      component: ToolSearchToolView,
    }),
  ],
} satisfies PluginDefinition;
