import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { setConversationPromptDraft } from "@plugins/conversations/plugins/conversation-view/plugins/prompt-input/web";
import { useGoBackToMessage, type RewindMode } from "../hooks/use-go-back";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";

const MODES: Record<RewindMode, { title: string; icon: IconRef }> = {
  rewind: { title: "Rewind to here", icon: symbol("undo") },
  fork: { title: "Fork from here", icon: symbol("call-split") },
};

/**
 * On each of the user's own messages: go back to just before it, either in this
 * conversation (Rewind to here) or in a new one (Fork from here) — two actions,
 * one per mode. `IconButton`s, so whichever the row-actions config puts behind
 * the `⋯` (Fork from here, by default) reads there as a labelled row. The
 * message's text lands in the prompt editor either way, ready to be rewritten.
 */
function GoBackAction({
  event,
  mode,
}: {
  event: JsonlEvent;
  mode: RewindMode;
}) {
  const { convId } = conversationPane.useParams();
  const { available, busy, run } = useGoBackToMessage({
    convId,
    uuid: event.kind === "user-text" ? event.uuid : undefined,
    onBack: setConversationPromptDraft,
  });

  if (!available) return null;

  const { title, icon } = MODES[mode];
  return (
    <IconButton
      icon={icon}
      label={title}
      disabled={busy}
      onClick={() => void run(mode)}
    />
  );
}

export function RewindAction({ event }: { event: JsonlEvent }) {
  return <GoBackAction event={event} mode="rewind" />;
}

export function ForkFromMessageAction({ event }: { event: JsonlEvent }) {
  return <GoBackAction event={event} mode="fork" />;
}
