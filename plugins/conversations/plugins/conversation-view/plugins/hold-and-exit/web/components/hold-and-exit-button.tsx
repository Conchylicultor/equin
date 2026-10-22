import { DropdownMenuItem } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { useLiveConversation } from "@plugins/conversations/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
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
  const toast = useToast();
  const close = useEndpointMutation(holdAndExit, {
    onSuccess: () =>
      toast({
        type: "conversation",
        title: "Task held",
        description: "Task held and conversation closed",
        variant: "success",
      }),
    onError: (err) =>
      toast({
        type: "conversation",
        title: "Hold & Close failed",
        description: err.message,
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
      <Icon icon={pauseCircleIcon} className="size-4" />
      {isPending ? "Holding…" : "Hold & Close"}
    </DropdownMenuItem>
  );
}
