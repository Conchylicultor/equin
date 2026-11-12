import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  PartialWriteInputSchema,
  WriteInputSchema,
  WriteToolView,
} from "./components/write-tool-view";

export default {
  description:
    "Renders Write tool calls with syntax-highlighted file content and clickable path affordances.",
  contributions: [
    // While the model writes it, every field is optional, so the file fills in.
    JsonlViewerTool.Renderer({
      match: "Write",
      icon: symbol("edit"),
      input: WriteInputSchema,
      partialInput: PartialWriteInputSchema,
      component: WriteToolView,
    }),
  ],
} satisfies PluginDefinition;
