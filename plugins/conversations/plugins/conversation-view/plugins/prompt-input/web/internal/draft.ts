import { useCallback } from "react";
import { writeDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { useStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { conversationPromptDraft } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";

/**
 * Put `text` in a conversation's prompt editor, replacing whatever is there —
 * the draft of the composition scope the caller renders in.
 */
export function useSetConversationPromptDraft(): (
  conversationId: string,
  text: string,
) => void {
  const drafts = useStore(conversationPromptDraft);
  return useCallback(
    (conversationId, text) =>
      writeDraft(drafts, text, { scope: conversationId }),
    [drafts],
  );
}
