import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  conversationName,
  type Conversation as ConversationRecord,
} from "@plugins/tasks/plugins/tasks-core/core";
import { useLiveConversation } from "@plugins/conversations/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useActiveDependentCount } from "@plugins/tasks/web";
import { DropdownMenuItem } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { dropDependents } from "../../shared";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const deleteSweepIcon = symbol("delete-sweep");
const keptIcon = symbol("info");

export function DropDependentsItem({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const live = useLiveConversation(conversation);
  const blocked = useActiveDependentCount(conversation.taskId);

  const toast = useToast();
  const subject = {
    subjectId: conversation.id,
    subjectName: conversationName(conversation),
  };
  const close = useEndpointMutation(dropDependents, {
    onSuccess: (data) => {
      toast(
        data.kind === "dropped"
          ? {
              type: "conversation",
              category: "conversations",
              icon: deleteSweepIcon,
              // `count` is every task dropped: this one and its follow-ups.
              title: followUpsTitle(data.count - 1),
              description: "",
              ...subject,
              detail: `dropped ${data.count} tasks`,
              variant: "success",
            }
          : {
              type: "conversation",
              category: "conversations",
              icon: keptIcon,
              title: "Task kept",
              description:
                "Another conversation is still working on it — only this one closed",
              ...subject,
              variant: "info",
            },
      );
    },
    onError: (err) =>
      toast({
        type: "conversation",
        category: "conversations",
        title: "Drop with follow-ups failed",
        description: "",
        ...subject,
        detail: err.message,
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
      variant="destructive"
      disabled={disabled}
      title={close.kind === "unavailable" ? close.message : undefined}
      onClick={() => {
        if (close.kind === "available")
          close.mutate({ params: { id: conversation.id } });
      }}
    >
      <Icon icon={deleteSweepIcon} className="size-4" />
      {isPending
        ? "Dropping…"
        : `Drop task + ${dependentCount} dependent(s) & Close`}
    </DropdownMenuItem>
  );
}

/** "Dropped with 20 follow-ups" — sentence case, singular for one. */
export function followUpsTitle(followUps: number): string {
  if (followUps <= 0) return "Conversation dropped";
  return `Dropped with ${followUps} follow-up${followUps === 1 ? "" : "s"}`;
}
