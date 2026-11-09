import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { TeammateMessageRow } from "./components/teammate-message-row";

export default {
  description:
    "Renders messages from other Claude sessions (<teammate-message> blocks, and cross-session messages: the sender's task as a chip opening its conversation, the message open) distinctly from human user messages.",
  contributions: [
    JsonlViewer.EventRenderer({ match: "teammate-message", component: TeammateMessageRow }),
  ],
} satisfies PluginDefinition;
