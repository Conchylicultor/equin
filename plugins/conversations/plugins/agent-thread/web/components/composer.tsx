import { useCallback } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { TextEditor } from "@plugins/primitives/plugins/text-editor/web";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  getEndpointErrorMessage,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { canSendTurn, stopConversation } from "@plugins/conversations/core";
import type { ConversationEntry } from "@plugins/conversations/core";
import { isDraftEmpty } from "@plugins/conversations/plugins/conversation-view/web";
import {
  conversationPromptDraft,
  useSendConversationTurn,
  useTurnSendAvailability,
} from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { resumeConversationEndpoint } from "@plugins/conversations/plugins/conversation-view/plugins/resume/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";

const sendIcon = symbol("arrow-upward");
const stopIcon = symbol("stop");

export interface ThreadComposerViewProps {
  value: string;
  onChange: (markdown: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled: boolean;
  /** The agent is on a turn: the trailing button stops it. */
  onStop?: () => void;
  /** A send or a stop is in flight. */
  busy?: boolean;
  namespace: string;
}

/** The thread's prompt line: a slim editor and one trailing Send / Stop button. */
export function ThreadComposerView({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  onStop,
  busy = false,
  namespace,
}: ThreadComposerViewProps) {
  return (
    <Stack
      direction="row"
      gap="xs"
      align="end"
      className="border-t border-border p-sm"
    >
      <Fill>
        <TextEditor
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          submitMode="enter"
          placeholder={placeholder}
          disabled={disabled}
          minRows={1}
          maxHeight="8rem"
          namespace={namespace}
        />
      </Fill>
      {onStop ? (
        <IconButton
          icon={stopIcon}
          label="Stop the agent"
          variant="outline"
          loading={busy}
          onClick={onStop}
        />
      ) : (
        <IconButton
          icon={sendIcon}
          label="Send"
          variant="default"
          loading={busy}
          disabled={disabled || isDraftEmpty(value)}
          onClick={onSubmit}
        />
      )}
    </Stack>
  );
}

function failed(title: string, err: unknown): void {
  showToast({
    title,
    description: getEndpointErrorMessage(err),
    variant: "error",
  });
}

/**
 * The composer of a live thread. Its draft is the conversation's own prompt
 * draft (the Agent Manager's prompt reads the same key), so a turn sent back
 * to the draft — Copy to draft, a Stop's rewound text — lands here too.
 *
 * Every turn goes through `useSendConversationTurn`. A conversation whose process
 * ended (gone, done) is resumed first and the turn sent once it is back, so
 * the user can always reply — unless it has no Claude session to resume.
 */
export function ThreadComposer({
  conversation,
  status,
  turnRunning,
  placeholder,
}: {
  conversation: ConversationEntry;
  /** The status as the user sees it (`useOptimisticConversationStatus`). */
  status: ConversationStatus;
  /** Whether a turn runs, as the user sees it (`useTurnRunning`). */
  turnRunning: boolean;
  placeholder: string;
}) {
  const id = conversation.id;
  const [draft, setDraft, clearDraft] = useDraft(conversationPromptDraft, "", {
    scope: id,
  });
  const draftRef = useLatestRef(draft);
  const sendConversationTurn = useSendConversationTurn();
  const sendAvailability = useTurnSendAvailability();
  const resume = useEndpointMutation(resumeConversationEndpoint, {
    onError: (err) => failed("Couldn't resume the conversation", err),
  });
  const stop = useEndpointMutation(stopConversation, {
    onSuccess: (data) => {
      if (data.rewindText) setDraft(data.rewindText);
    },
    onError: (err) => failed("Couldn't stop the agent", err),
  });

  const ended = status === "gone" || status === "done";
  const resumable = ended && conversation.claudeSessionId !== null;
  const resumePending = resume.kind === "available" && resume.isPending;
  const stopPending = stop.kind === "available" && stop.isPending;
  // Sending, resuming and stopping all drive the agent, which needs the
  // computer: on a host without it (the demo) the composer is disabled and
  // its placeholder says why.
  const disabled =
    !sendAvailability.available ||
    (ended ? !resumable || resumePending : !canSendTurn({ status }));

  const send = useCallback(() => {
    const text = draftRef.current;
    if (isDraftEmpty(text) || disabled) return;
    // Spent the moment it is sent, as in the conversation's own prompt: the
    // turn's record holds the text for Retry.
    clearDraft();
    if (!ended) {
      sendConversationTurn(id, { text });
      return;
    }
    // Resume needs the computer like a send does, so the gate above already
    // holds whenever this is unavailable.
    if (resume.kind === "unavailable") throw new Error(resume.message);
    resume.mutate(
      { params: { id } },
      {
        onSuccess: () => sendConversationTurn(id, { text }),
        // Nothing was sent: the words go back where they were typed.
        onError: () => setDraft(text),
      },
    );
  }, [
    draftRef,
    disabled,
    clearDraft,
    ended,
    id,
    resume,
    setDraft,
    sendConversationTurn,
  ]);

  const working = turnRunning || status === "starting";
  return (
    <ThreadComposerView
      value={draft}
      onChange={setDraft}
      onSubmit={send}
      placeholder={
        !sendAvailability.available
          ? sendAvailability.message
          : ended && !resumable
            ? "This conversation can't be resumed"
            : placeholder
      }
      disabled={disabled}
      onStop={
        working && stop.kind === "available"
          ? () => stop.mutate({ params: { id } })
          : undefined
      }
      busy={resumePending || stopPending}
      namespace={`agent-thread-${id}`}
    />
  );
}
