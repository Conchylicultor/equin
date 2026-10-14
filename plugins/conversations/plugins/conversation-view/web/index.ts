import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "./panes";
import { Conversation as ConversationSlots } from "./slots";

export { Conversation } from "./slots";
export { conversationPane } from "./panes";
export {
  useConversationOpener,
  type ConversationOpener,
} from "./use-conversation-opener";
export { ConversationView } from "./components/conversation-view";
export { useAttemptWorkspaceKind } from "./use-attempt-workspace-kind";
export { draftToPlainText, isDraftEmpty } from "./prompt-draft-utils";
export {
  usePromptComposer,
  useRegisterPromptComposer,
  type PromptComposer,
} from "./prompt-composer-context";

export default {
  description:
    "Conversation pane host. The header is the pane's own Actions slot (title plus chips); the prompt bar is slot-driven.",
  contributions: [Pane.Register({ pane: conversationPane })],
  slots: { ...ConversationSlots, conversation: conversationPane },
} satisfies PluginDefinition;
