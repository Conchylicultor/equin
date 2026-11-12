import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  EditInputSchema,
  EditView,
  PartialEditInputSchema,
} from "./components/edit-view";
import {
  MultiEditInputSchema,
  MultiEditView,
} from "./components/multi-edit-view";

export default {
  description: "Renders Edit and MultiEdit tool calls as side-by-side syntax-highlighted diffs.",
  contributions: [
    // Defaults every field, so the diff fills in as the model writes it.
    JsonlViewerTool.Renderer({
      match: "Edit",
      icon: symbol("edit"),
      input: EditInputSchema,
      partialInput: PartialEditInputSchema,
      component: EditView,
    }),
    JsonlViewerTool.Renderer({
      match: "MultiEdit",
      icon: symbol("edit"),
      input: MultiEditInputSchema,
      component: MultiEditView,
    }),
  ],
} satisfies PluginDefinition;
