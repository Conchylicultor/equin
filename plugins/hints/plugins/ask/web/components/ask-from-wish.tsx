import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { WishHeaderActionProps } from "@plugins/wish/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { askAbout } from "../internal/ask-store";

const askIcon = symbol("forum");

/**
 * Ask equin from the Wish popover's header: a question rather than a task.
 * Closes Wish (its draft is kept) and opens the card — on what the user typed
 * in Wish, as the question to send, when they typed anything.
 */
export function AskFromWish({ close, draft }: WishHeaderActionProps) {
  return (
    <IconButton
      icon={askIcon}
      label="Ask equin how to…"
      onClick={() => {
        close();
        askAbout(draft);
      }}
    />
  );
}
