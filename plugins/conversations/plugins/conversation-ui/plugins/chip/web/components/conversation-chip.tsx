import {
  ConversationItem,
  conversationTitle,
  type ConversationItemConv,
} from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { useConversationOpener } from "@plugins/conversations/plugins/conversation-view/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";

export type ConversationChipProps = {
  /**
   * The conversation to name. Structural, like `ConversationItem`'s own prop —
   * a full `Conversation` row and the narrower `ConversationSummary` carried by
   * the `attempts` set (`attemptRows`) both fit.
   */
  conv: ConversationItemConv;
};

/**
 * A conversation, as a clickable chip that opens its run beside the surface
 * naming it.
 *
 * The sibling `item` plugin is pure presentation — it paints a conversation and
 * nothing else, on purpose, so that a row, a chip and a card can each wrap their
 * own chrome around one rendering. This is that wrapper for the chip case,
 * written once; `row` is its full-width twin. Both take their navigation and
 * their active state from `useConversationOpener`, so the chip lights up for
 * exactly the column the row would.
 *
 * A chip with no title yet reads "Starting…" — a conversation is created before
 * its title is generated, so the alternative is a chip that is momentarily blank.
 */
export function ConversationChip({ conv }: ConversationChipProps) {
  const opener = useConversationOpener();

  return (
    <ToggleChip
      variant="ghost"
      active={opener.isOpen(conv.id)}
      title={conversationTitle(conv)}
      {...activationProps(opener.toggle(conv.id))}
    >
      <ConversationItem conv={conv} layout="inline" />
    </ToggleChip>
  );
}
