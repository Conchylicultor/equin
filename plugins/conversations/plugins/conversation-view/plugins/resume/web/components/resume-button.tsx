import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { useLiveConversation } from "@plugins/conversations/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import {
  useEndpointMutation,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { resumeConversationEndpoint } from "@plugins/conversations/plugins/conversation-view/plugins/resume/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const replayIcon = symbol("replay");

export function ResumeButton({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const live = useLiveConversation(conversation);
  const toast = useToast();
  const resume = useEndpointMutation(resumeConversationEndpoint, {
    onSuccess: () =>
      toast({
        type: "conversation",
        title: "Resuming conversation",
        description: "Reconnecting the agent session…",
        variant: "success",
      }),
    onError: (err) =>
      toast({
        type: "conversation",
        title: "Resume failed",
        description: getEndpointErrorMessage(err),
        variant: "error",
      }),
  });

  const isNotRunning = live.status === "gone" || live.status === "done";
  const hasSession = !!live.claudeSessionId;
  const canResume = isNotRunning && hasSession;

  // Resuming respawns the agent, which needs the computer: on a host without
  // it (the demo) the button is disabled and says why.
  const pending = resume.kind === "available" && resume.isPending;
  const tooltip =
    resume.kind === "unavailable"
      ? resume.message
      : !isNotRunning
        ? "Resume is available once the session has exited"
        : !hasSession
          ? "No saved Claude session to resume"
          : "Resume conversation (claude --resume)";

  function onClick() {
    if (resume.kind === "unavailable" || resume.isPending || !canResume) return;
    resume.mutate({ params: { id: conversation.id } });
  }

  return (
    <IconButton
      icon={replayIcon}
      label="Resume"
      tooltip={pending ? "Resuming…" : tooltip}
      variant="outline"
      loading={pending}
      disabled={resume.kind === "unavailable" || !canResume}
      onClick={onClick}
    />
  );
}
