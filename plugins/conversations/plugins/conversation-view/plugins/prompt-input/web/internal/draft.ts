import { writeDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { conversationPromptDraft } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";

/** Put `text` in a conversation's prompt editor, replacing whatever is there. */
export function setConversationPromptDraft(
  conversationId: string,
  text: string,
): void {
  writeDraft(conversationPromptDraft, text, { scope: conversationId });
}
