import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { useLiveConversation } from "@plugins/conversations/web";
import { toast } from "@plugins/shell/plugins/notifications/web";
import { useActiveDependentCount } from "@plugins/tasks/web";
import { DropdownMenuItem } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { dropDependents } from "../../shared";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const deleteSweepIcon = symbol("delete-sweep");

export function DropDependentsItem({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const live = useLiveConversation(conversation);
  const blocked = useActiveDependentCount(conversation.taskId);

  const { mutate, isPending } = useEndpointMutation(dropDependents, {
    onSuccess: (data) => {
      toast(
        data.kind === "dropped"
          ? {
              type: "conversation",
              title: "Dependents dropped",
              description: `Dropped ${data.count} task(s) and closed conversation`,
              variant: "success",
            }
          : {
              type: "conversation",
              title: "Task kept",
              description:
                "Another conversation is still working on this task, so only this conversation closed — nothing was dropped",
              variant: "info",
            },
      );
    },
    onError: (err) =>
      toast({
        type: "conversation",
        title: "Drop dependents failed",
        description: err.message,
        variant: "error",
      }),
  });

  // Nothing is waiting on this task (or we do not know yet) ⇒ no sweep to offer.
  // A failed read hides it too, deliberately: a destructive sweep is never
  // offered over a count nobody could read.
  if (
    blocked.status === "loading" ||
    blocked.status === "error" ||
    blocked.data === 0
  )
    return null;
  const dependentCount = blocked.data;

  const disabled =
    isPending ||
    live.status === "gone" ||
    live.status === "done" ||
    live.status === "starting";

  return (
    <DropdownMenuItem
      variant="destructive"
      disabled={disabled}
      onClick={() => mutate({ params: { id: conversation.id } })}
    >
      <Icon icon={deleteSweepIcon} className="size-4" />
      {isPending
        ? "Dropping…"
        : `Drop task + ${dependentCount} dependent(s) & Close`}
    </DropdownMenuItem>
  );
}
