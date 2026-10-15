import type { ReactElement } from "react";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import {
  pinQueue,
  queueRanks,
} from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { hoverRevealTargetInAnchor } from "@plugins/primitives/plugins/hover-reveal/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { isAdoptedConversation } from "@plugins/tasks/plugins/tasks-core/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const keepIcon = symbol("keep");

/**
 * Pin / unpin the conversation's task group — the header twin of the sidebar
 * Queue row's pin. Offered only where the queue can rank it: a live
 * (starting / working / waiting) conversation that was not adopted; a closed
 * or lost one has nothing for a pin to lift.
 *
 * Unpinned, it shows only while the header row is hovered (or the button is
 * focused); pinned, it stays visible — then it carries state.
 */
export function PinButton(): ReactElement | null {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  if (!conversation) return null;
  if (
    (conversation.status !== "waiting" &&
      conversation.status !== "working" &&
      conversation.status !== "starting") ||
    isAdoptedConversation(conversation)
  )
    return null;
  return <QueuePin convId={convId} />;
}

function QueuePin({ convId }: { convId: string }): ReactElement {
  const rank = useLiveRow(queueRanks, convId);
  // Not known yet: the loading block, never an "unpinned" that might flip.
  if (rank.status === "loading") {
    return <Loading variant="block" className="size-6" />;
  }
  if (rank.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the pin"
        error={rank.error}
        refetch={rank.refetch}
      />
    );
  }
  // No rank row yet: never pinned (the pin endpoint seeds one on pin).
  const pinned = rank.found && rank.row.pinned;
  return (
    <IconButton
      icon={keepIcon}
      active={pinned}
      label={pinned ? "Unpin" : "Pin to top"}
      className={pinned ? undefined : hoverRevealTargetInAnchor}
      onClick={() =>
        fetchEndpoint(
          pinQueue,
          {},
          { body: { conversationId: convId, pinned: !pinned } },
        )
      }
    />
  );
}
