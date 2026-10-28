import { DropdownMenuItem } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  conversationName,
  type Conversation as ConversationRecord,
} from "@plugins/tasks/plugins/tasks-core/core";
import { useLiveConversation } from "@plugins/conversations/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { exitConversation } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const logoutIcon = symbol("logout");

export function ExitItem({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const live = useLiveConversation(conversation);
  const toast = useToast();
  // No success notification: the user saw it close.
  const close = useEndpointMutation(exitConversation, {
    onError: (err) =>
      toast({
        type: "conversation",
        category: "conversations",
        title: "Close failed",
        description: "",
        subjectId: conversation.id,
        subjectName: conversationName(conversation),
        detail: err.message,
        variant: "error",
      }),
  });

  // Closing stops the agent, which needs the computer: on a host without
  // it (the demo) the entry is disabled and says why.
  const isPending = close.kind === "available" && close.isPending;
  const disabled =
    close.kind === "unavailable" ||
    isPending ||
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
      <Icon icon={logoutIcon} className="size-4" />
      {isPending ? "Closing…" : "Close"}
    </DropdownMenuItem>
  );
}
