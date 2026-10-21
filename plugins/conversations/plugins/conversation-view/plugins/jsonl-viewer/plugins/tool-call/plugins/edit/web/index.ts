import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { EditView } from "./components/edit-view";
import { MultiEditView } from "./components/multi-edit-view";

export default {
  description: "Renders Edit and MultiEdit tool calls as side-by-side syntax-highlighted diffs.",
  contributions: [
    // Defaults every field, so the diff fills in as the model writes it.
    JsonlViewerTool.Renderer({
      match: "Edit",
      component: EditView,
      partialInput: true,
    }),
    JsonlViewerTool.Renderer({ match: "MultiEdit", component: MultiEditView }),
  ],
} satisfies PluginDefinition;
