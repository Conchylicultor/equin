import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { WriteNoteView } from "./components/write-note-view";

export default {
  description:
    "Renders write_agent_note MCP tool calls: the page the card lives on, the markdown written into it, and what the write changed.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: /write_agent_note$/,
      icon: symbol("article"),
      component: WriteNoteView,
    }),
  ],
} satisfies PluginDefinition;
