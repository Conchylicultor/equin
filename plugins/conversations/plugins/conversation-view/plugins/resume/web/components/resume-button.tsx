import { useState } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  conversationName,
  type Conversation as ConversationRecord,
} from "@plugins/tasks/plugins/tasks-core/core";
import { useLiveConversation } from "@plugins/conversations/web";
import { useMachineAvailability } from "@plugins/infra/plugins/endpoints/web";
import { resumeConversationEndpoint } from "@plugins/conversations/plugins/conversation-view/plugins/resume/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useResumeConversation } from "../internal/use-resume-conversation";

const replayIcon = symbol("replay");

export function ResumeButton({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const live = useLiveConversation(conversation);
  const resume = useResumeConversation();
  const machine = useMachineAvailability(resumeConversationEndpoint);
  const [pending, setPending] = useState(false);

  const isNotRunning = live.status === "gone" || live.status === "done";
  const hasSession = !!live.claudeSessionId;
  const canResume = isNotRunning && hasSession;

  // Resuming respawns the agent, which needs the computer: on a host without
  // it (the demo) the button is disabled and says why.
  const tooltip = !machine.available
    ? machine.message
    : !isNotRunning
      ? "Resume is available once the session has exited"
      : !hasSession
        ? "No saved Claude session to resume"
        : "Resume conversation (claude --resume)";

  async function onClick() {
    if (!machine.available || pending || !canResume) return;
    setPending(true);
    try {
      await resume({
        id: conversation.id,
        name: conversationName(conversation),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <IconButton
      icon={replayIcon}
      label="Resume"
      tooltip={pending ? "Resuming…" : tooltip}
      variant="outline"
      loading={pending}
      disabled={!machine.available || !canResume}
      onClick={() => void onClick()}
    />
  );
}
