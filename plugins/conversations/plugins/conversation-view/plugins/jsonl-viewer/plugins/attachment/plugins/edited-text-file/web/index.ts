import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { EditedTextFileView } from "./components/edited-text-file-view";

export default {
  collapsed: true,
  description:
    "Renders edited-text-file attachment events as a collapsible file path with the resulting file content shown as a syntax-highlighted code listing.",
  contributions: [
    ...attachmentRenderer({
      match: "edited_text_file",
      component: EditedTextFileView,
      role: "conversation",
    }),
  ],
} satisfies PluginDefinition;
