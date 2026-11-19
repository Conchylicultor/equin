import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { useSectionStart } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const verticalAlignTopIcon = symbol("vertical-align-top");

/**
 * Jump back to where a prompt starts. Offered only while that start is above
 * the viewport — the prompt pinned over the turn it opened, or expanded and
 * read past its top: a prompt sitting at its own place has nowhere to jump to.
 */
export function ScrollToMessageAction({ event }: { event: JsonlEvent }) {
  const start = useSectionStart();
  if (event.kind !== "user-text" || start === null || !start.scrolledPast)
    return null;
  return (
    <IconButton
      icon={verticalAlignTopIcon}
      label="Scroll to this message"
      onClick={start.jump}
    />
  );
}
