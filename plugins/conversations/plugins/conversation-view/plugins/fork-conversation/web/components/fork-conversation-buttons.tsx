import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { LaunchControl } from "@plugins/primitives/plugins/launch/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const addCommentIcon = symbol("add-comment");

/**
 * Side chat: a new, blank conversation in this conversation's worktree — no
 * pre-prompt. The icon starts one on the default model; the chevron picks
 * another (or makes it the default).
 */
export function ForkConversationButtons({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  return (
    <LaunchControl
      size="icon"
      variant="outline"
      action={{
        icon: addCommentIcon,
        label: "New conversation in this worktree",
      }}
      getRequest={() => ({ attemptId: conversation.attemptId })}
    />
  );
}
