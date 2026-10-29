import { DropdownMenuItem } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { useLiveConversation } from "@plugins/conversations/web";
import { holdAndExit } from "../../shared";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const pauseCircleIcon = symbol("pause-circle");

export function HoldAndExitItem({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const live = useLiveConversation(conversation);
  // A predicted write: the conversation reads closed at once, so there is no
  // "Holding…" state and no success notification. A refusal is the rejection
  // toast; a transient failure the sync cloud's Retry.
  const close = useLiveMutation(holdAndExit, { label: "Hold & Close" });

  // Closing stops the agent, which needs the computer: on a host without
  // it (the demo) the entry is disabled and says why.
  const disabled =
    close.kind === "unavailable" ||
    live.status === "gone" ||
    live.status === "done" ||
    live.status === "starting";

  return (
    <DropdownMenuItem
      disabled={disabled}
      title={close.kind === "unavailable" ? close.message : undefined}
      onClick={() => {
        if (close.kind === "available")
          close.mutate({ params: { id: conversation.id } });
      }}
    >
      <Icon icon={pauseCircleIcon} className="size-4" />
      Hold & Close
    </DropdownMenuItem>
  );
}
