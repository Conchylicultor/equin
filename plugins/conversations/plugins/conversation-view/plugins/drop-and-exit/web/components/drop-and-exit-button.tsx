import { Icon } from "@plugins/ui/plugins/icons/web";
import { DropdownMenuItem } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useMemo } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import {
  useLiveConversation,
  useHasActiveSiblings,
} from "@plugins/conversations/web";
import {
  foldResource,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { toast } from "@plugins/shell/plugins/notifications/web";
import {
  attemptWork,
  standingOf,
  type AttemptWorkPayload,
} from "@plugins/tasks/plugins/attempt-work/core";
import { dropAndExit, dropsTask } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const checkCircleIcon = symbol("check-circle");
const deleteForeverIcon = symbol("delete-forever");

export function DropAndExitItem({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  // The attempt's standing relative to `main`, measured from git. NOT the
  // `pushes` ledger this used to read: that table is written by a background
  // ingest job, so an empty result meant either "nothing was pushed" or "nothing
  // has been ingested yet" — and reading it as the former picked the destructive
  // "Drop & Close" label over landed work.
  const workResult = useLive(attemptWork, {
    attemptId: conversation.attemptId,
  });
  // No computer behind this app, so no git to measure: Drop vs Complete cannot
  // be decided, and the plain "Close" entry already covers closing.
  if (workResult.status === "unavailable") return null;
  return (
    <DropAndExitEntry conversation={conversation} workResult={workResult} />
  );
}

function DropAndExitEntry({
  conversation,
  workResult,
}: {
  conversation: ConversationRecord;
  workResult: ResourceResult<AttemptWorkPayload>;
}) {
  const live = useLiveConversation(conversation);
  const siblingsResult = useHasActiveSiblings(
    conversation.taskId,
    conversation.id,
  );
  // The label/destructiveness decision reads TWO independently-arriving
  // resources; gate on both so the destructive "Drop & Exit" default can never
  // show (or be clicked) while either is still loading.
  const decision = useCombinedResources({
    work: workResult,
    hasOtherActive: siblingsResult,
  });

  // `null` = no standing to decide on: the combine is still loading, one of its
  // reads failed, or the server could measure nothing (the `Resolvable`
  // unresolved arm). A ready decision is one the server vouches for.
  //
  // `standingOf` is the only thing consulted here: a discriminated
  // "none" | "pending" | "landed", never a length compared to zero (invariant
  // I4), so there is no array whose emptiness this component could misread.
  // The label follows the server's own rule for this action (`dropsTask` under
  // "unless-landed"): only work already in `main` reads as Complete; unmerged
  // commits (a push that never finished) still read — and act — as Drop.
  const standing = useMemo(
    () =>
      foldResource(decision, {
        loading: () => null,
        error: () => null,
        ready: ({ work }) => (work.resolved ? standingOf(work.value) : null),
      }),
    [decision],
  );
  const landed = standing !== null && !dropsTask(standing, "unless-landed");

  const { mutate, isPending } = useEndpointMutation(dropAndExit, {
    onSuccess: (data) => {
      const title = data.dropped ? "Task dropped" : "Conversation closed";
      const description = data.dropped
        ? "Task marked dropped and conversation closed"
        : "Conversation closed without changing task state";
      toast({ type: "conversation", title, description, variant: "success" });
    },
    onError: (err) =>
      toast({
        type: "conversation",
        title: `${landed ? "Complete" : "Drop"} & Close failed`,
        description: err.message,
        variant: "error",
      }),
  });

  // Dropping the task only makes sense when this is the last active conversation
  // on it. If a sibling is still active, the plain "Close" exit entry already
  // covers closing this one — hide this entry rather than degrade it to a
  // redundant "Close" (mirrors how Drop dependents hides when there's nothing
  // to drop).
  //
  // A failed read hides the entry too — deliberately, not as a spinner: the
  // plain "Close" entry is right there, and a stale value must never decide a
  // destructive action. An unresolved `work` (a `null` standing) means the
  // server could not measure this attempt at all. The plain "Close" exit entry already covers
  // both cases, and putting a destructive label over an unknown standing is
  // precisely what this change removes. Unknown state is never a licence to drop
  // a task.
  if (
    decision.status === "loading" ||
    decision.status === "error" ||
    decision.data.hasOtherActive ||
    standing === null
  )
    return null;

  const disabled =
    isPending ||
    live.status === "gone" ||
    live.status === "done" ||
    live.status === "starting";

  const { icon, label, variant } = landed
    ? {
        icon: checkCircleIcon,
        label: isPending ? "Completing…" : "Complete & Close",
        variant: "default" as const,
      }
    : {
        icon: deleteForeverIcon,
        label: isPending ? "Dropping…" : "Drop & Close",
        variant: "destructive" as const,
      };

  return (
    <DropdownMenuItem
      variant={variant}
      disabled={disabled}
      onClick={() => mutate({ params: { id: conversation.id } })}
    >
      <Icon icon={icon} className="size-4" />
      {label}
    </DropdownMenuItem>
  );
}
