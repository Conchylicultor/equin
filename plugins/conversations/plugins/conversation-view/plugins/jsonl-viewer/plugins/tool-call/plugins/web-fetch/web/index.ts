import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { WebFetchToolView } from "./components/web-fetch-tool-view";
import {
  PartialWebFetchInputSchema,
  WebFetchInputSchema,
} from "./internal/web-fetch";

export default {
  description:
    "Renders WebFetch calls as the page's host and path; opened, the prompt asked of it and the answer as markdown.",
  contributions: [
    // While the model writes it, every field is optional, so the card fills in.
    JsonlViewerTool.Renderer({
      match: "WebFetch",
      icon: symbol("language"),
      input: WebFetchInputSchema,
      partialInput: PartialWebFetchInputSchema,
      component: WebFetchToolView,
    }),
  ],
} satisfies PluginDefinition;
