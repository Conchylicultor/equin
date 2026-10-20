import { useCallback, useRef } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import {
  isDraftEmpty,
  useRegisterPromptComposer,
  useAttemptWorkspaceKind,
} from "@plugins/conversations/plugins/conversation-view/web";
import { useLiveConversation } from "@plugins/conversations/web";
import {
  canSendTurn,
  isTurnRunning,
  QUESTION_WAITING_FOR,
} from "@plugins/conversations/core";
import {
  conversationPromptDraft,
  sendConversationTurn,
} from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { PromptEditor } from "@plugins/primitives/plugins/prompt-editor/web";
import { toast } from "@plugins/shell/plugins/notifications/web";

export function PromptInput({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const live = useLiveConversation(conversation);
  const workspace = useAttemptWorkspaceKind(conversation.attemptId);
  const [draft, setDraft, clearDraft] = useDraft(conversationPromptDraft, "", {
    scope: conversation.id,
  });

  // The gate every turn-sending surface shares (canSendTurn): `starting` and
  // `working` stay sendable (the server holds or queues the turn), and so does a
  // waiting question — sending dismisses it and the message goes in its place.
  const disabled = !canSendTurn(live);

  const insertRef = useRef<((text: string) => void) | null>(null);

  // This prompt, published to the rest of the pane (the transcript quotes and
  // answers into it). A quick send is a turn of its own: it goes through the
  // same gate as Enter and leaves whatever is being typed in the draft alone.
  const insert = useCallback((text: string) => {
    const insertNow = insertRef.current;
    // The editor below is mounted with this component, so a missing handle is
    // a broken wiring, not a state to absorb.
    if (!insertNow)
      throw new Error("Prompt editor insert handle is not mounted");
    insertNow(text);
  }, []);
  const sendText = useCallback(
    (text: string) => {
      if (disabled) return;
      sendConversationTurn(conversation.id, { text });
    },
    [conversation.id, disabled],
  );
  useRegisterPromptComposer({ insert, send: sendText, canSend: !disabled });

  // Latest-draft ref so the send handler doesn't capture stale state.
  const draftRef = useLatestRef(draft);

  // The pending-turn store owns the whole send lifecycle (delivery, retry,
  // transcript confirmation); the draft is cleared synchronously so a second
  // Enter is a no-op and the editor stays typable while the send is in flight.
  const send = useCallback(() => {
    const current = draftRef.current;
    if (isDraftEmpty(current) || disabled) return;
    clearDraft();
    sendConversationTurn(conversation.id, { text: current });
  }, [conversation.id, disabled, clearDraft]);

  const placeholder = disabled
    ? live.status === "done"
      ? "Conversation is done"
      : "Conversation is disconnected"
    : live.waitingFor === QUESTION_WAITING_FOR
      ? "Answer above, or send a message to skip the question"
      : live.status === "starting"
        ? "Agent starting — send now, it gets your message when ready"
        : isTurnRunning(live)
          ? "Queue a message — Enter to queue, Shift+Enter for newline"
          : "Send a message — Enter to send, Shift+Enter for newline";

  return (
    <PromptEditor
      value={draft}
      onChange={setDraft}
      onSubmit={send}
      submitMode="enter"
      placeholder={placeholder}
      disabled={disabled}
      autoFocus
      minRows={1}
      maxHeight="10rem"
      namespace={`prompt-input-${conversation.id}`}
      onError={(msg) =>
        toast({
          type: "conversation",
          title: "Editor error",
          description: msg,
          variant: "error",
        })
      }
      insertRef={insertRef}
      workspace={workspace}
    />
  );
}
