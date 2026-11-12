import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { WebFetchToolView } from "./components/web-fetch-tool-view";

export default {
  description:
    "Renders WebFetch calls as the page's host and path; opened, the prompt asked of it and the answer as markdown.",
  contributions: [
    // Every input field is optional, so the card fills in as the model writes it.
    JsonlViewerTool.Renderer({
      match: "WebFetch",
      icon: symbol("language"),
      component: WebFetchToolView,
      partialInput: true,
    }),
  ],
} satisfies PluginDefinition;
