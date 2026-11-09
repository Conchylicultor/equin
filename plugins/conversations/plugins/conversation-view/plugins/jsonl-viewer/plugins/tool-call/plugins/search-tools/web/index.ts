import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { SearchToolView } from "./components/search-tool-view";

export default {
  description:
    "Renders Grep and Glob calls as the pattern with its filters and the result count; opened, the matched files as clickable paths, or the matching lines.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: "Grep",
      component: SearchToolView,
      partialInput: true,
    }),
    JsonlViewerTool.Renderer({
      match: "Glob",
      component: SearchToolView,
      partialInput: true,
    }),
  ],
} satisfies PluginDefinition;
