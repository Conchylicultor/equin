import { ConversationChip } from "@plugins/conversations/plugins/conversation-ui/plugins/chip/web";
import { useConversation } from "@plugins/conversations/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import type { PageReferenceChipProps } from "@plugins/page/plugins/page-reference/web";
import { useAgentNotesCreator } from "@plugins/page/plugins/annotations/plugins/agent-notes/plugins/authorship/web";

/** A chip-sized stand-in, for the two reads the chip waits on. */
function ChipLoading() {
  return <Loading variant="block" className="h-5 w-24" />;
}

/**
 * The conversation that CREATED an agent-authored page, as the chip at the
 * right edge of the page's row — clicking it opens that run beside the page.
 *
 * The creator is the page's FIRST authorship record: writes inside an agent
 * page stamp the page itself, and minting one stamps it as its own creator. A
 * page a human made with `/agent-page` has no record until an agent writes into
 * it, and shows no chip until then — that first writer then counts as the
 * creator.
 *
 * Two reads, and neither answers "nobody" for "not known yet": the authorship
 * record, then the conversation it names (its by-id read, which finds any
 * conversation however old). Both wait as a chip-sized shimmer (which paints
 * only on a slow load); a creator whose conversation was deleted shows no chip.
 */
export function AgentPageCreatorChip({ pageId }: PageReferenceChipProps) {
  const creator = useAgentNotesCreator(pageId);
  if (creator.status === "loading") return <ChipLoading />;
  if (creator.status === "error") {
    return (
      <ResourceErrorInline
        error={creator.error}
        refetch={creator.refetch}
        variant="icon"
        subject="the page's creator"
      />
    );
  }
  if (creator.data === null) return null;
  return <CreatorChip conversationId={creator.data.conversationId} />;
}

/** The creator's chip, split out so the lookup hook only runs with an id. */
function CreatorChip({ conversationId }: { conversationId: string }) {
  const conv = useConversation(conversationId);
  if (conv.status === "loading") return <ChipLoading />;
  if (conv.status === "error") {
    return (
      <ResourceErrorInline
        error={conv.error}
        refetch={conv.refetch}
        variant="icon"
        subject="the page's creator"
      />
    );
  }
  if (conv.data === null) return null;
  return <ConversationChip conv={conv.data} />;
}
