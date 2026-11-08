import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { SEND_MESSAGE_TOOL_NAME } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/core";
import { SendMessageView } from "./components/send-message-view";

export default {
  description:
    "Renders SendMessage tool calls: the recipient (a sub-agent by name or by its launch description, main, or another session), the caller's summary or the message's first line, and whether it was queued, resumed a stopped sub-agent or failed; opened, the message as markdown (or a protocol reply in words) and how it was delivered, with a button onto the recipient sub-agent's pane.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: SEND_MESSAGE_TOOL_NAME,
      component: SendMessageView,
    }),
  ],
} satisfies PluginDefinition;
