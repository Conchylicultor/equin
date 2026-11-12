import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { BrowserToolView } from "./components/browser-tool-view";
import { browserToolIcon } from "./internal/tool-icon";
import { BrowserCallInputSchema } from "./internal/describe";

export default {
  description:
    "Renders the agent browser's browser_* MCP calls as the salient input (URL, first line of the script, action and target, query, viewport) with the call's code or action list and its result text folded beneath; a screenshot's frame is the browser-recording footer's.",
  contributions: [
    JsonlViewerTool.Renderer({
      match:
        /browser_(javascript|navigate|screenshot|act|find|get_page_text|console|close|viewport|tabs|attach|read_page|network|batch)$/,
      icon: browserToolIcon,
      component: BrowserToolView,
      input: BrowserCallInputSchema,
      partialInput: BrowserCallInputSchema,
    }),
  ],
} satisfies PluginDefinition;
