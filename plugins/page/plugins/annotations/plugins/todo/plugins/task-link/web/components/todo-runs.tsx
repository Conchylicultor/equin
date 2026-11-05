import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { ConversationChip } from "@plugins/conversations/plugins/conversation-ui/plugins/chip/web";
import { useTaskConversations } from "@plugins/tasks/plugins/tasks-core/web";
import { useTodoTask } from "../hooks";

/**
 * The agents this TODO card has dispatched, as a row of chips — what the card's
 * FOOT renders.
 *
 * ## Why the card says this at all
 *
 * Dispatching used to leave almost no trace: the card's corner name stopped
 * hiding and started spelling the task's status, and that was the whole record.
 * A word in a corner cannot say WHICH run, cannot be clicked, and says nothing
 * at all about a second attempt. The chips do all three — one per run, oldest
 * first, each opening that run in a column beside the page — which is what the
 * `/prompt` block has always shown below its text. The two blocks now say the
 * same thing the same way, through the same chip.
 *
 * The corner name went back to being just the card's name for exactly that
 * reason: the status is here, on something you can act on, and a card that
 * spelled it twice would be a card whose two answers can disagree.
 *
 * ## Nothing at rest, and nothing while hydrating
 *
 * Most TODO cards never dispatch anything, and a card that has not is unchanged
 * — no chips, no reserved row, no foot at all. `null` covers both that and "the
 * link has not loaded yet", which is the call every surface in this family makes
 * (see `useTodoTask`): a spinner per card would be noise on every page, and the
 * cost is that a freshly-opened page's chips settle a beat after it paints.
 *
 * A dispatched card whose run has not been created yet renders nothing either.
 * That window is one round trip wide and closes on its own.
 */
export function TodoRuns({ blockId }: { blockId: string }) {
  const link = useTodoTask(blockId);
  // Nothing while loading, nothing when not dispatched. A failed read keeps the
  // link it last saw, else nothing: the card's anchor renders the failure.
  switch (link.status) {
    case "loading":
      return null;
    case "error":
      return link.stale === undefined ? null : (
        <DispatchedRuns taskId={link.stale.taskId} />
      );
    case "ready":
      return link.found ? <DispatchedRuns taskId={link.row.taskId} /> : null;
  }
}

/**
 * The dispatched arm, split out so the `attempts` subscription is a hook on a
 * component that only mounts once there IS a task to join against — an
 * un-dispatched card must not pay for it, and a hook cannot be called
 * conditionally.
 */
function DispatchedRuns({ taskId }: { taskId: string }) {
  const runs = useTaskConversations(taskId);
  // Nothing while the runs are still loading, and nothing when there are none —
  // rendered the same, decided separately. A placeholder strip at the foot of
  // every dispatched card on a freshly-opened page would be noise, and the
  // window is one round trip wide.
  if (runs.status === "loading") return null;
  if (runs.status === "error") {
    return (
      <ResourceErrorInline
        error={runs.error}
        refetch={runs.refetch}
        variant="inline"
        subject="this card's runs"
      />
    );
  }
  if (runs.data.length === 0) return null;

  return (
    <Cluster gap="xs">
      {runs.data.map((conv) => (
        <ConversationChip key={conv.id} conv={conv} />
      ))}
    </Cluster>
  );
}
