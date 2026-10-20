import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { JsonlRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { AssistantTextRow } from "./components/assistant-text-row";
import { CopyAssistantTextAction } from "./components/copy-text-action";
import { MarkdownToggleAction } from "./components/markdown-toggle-action";
import { StreamingText } from "./components/streaming-text";

export default {
  description:
    "Renders assistant text events in the JSONL viewer, with optional markdown rendering, and the message the agent is still writing (the conversations.partial-message value) as a block at the end of the transcript until its finished row lands.",
  contributions: [
    JsonlViewer.EventRenderer({
      match: "assistant-text",
      component: AssistantTextRow,
    }),
    JsonlViewer.TranscriptEnd({
      id: "streaming-text",
      component: StreamingText,
    }),
    JsonlRowActions.Item({
      id: "markdown-toggle",
      component: MarkdownToggleAction,
    }),
    JsonlRowActions.Item({
      id: "copy-assistant-text",
      component: CopyAssistantTextAction,
    }),
  ],
} satisfies PluginDefinition;
