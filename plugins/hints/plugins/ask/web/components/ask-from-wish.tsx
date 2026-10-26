import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { WishHeaderActionProps } from "@plugins/wish/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { openAsk } from "../internal/ask-store";

const askIcon = symbol("forum");

/**
 * Ask equin from the Wish popover's header: a question rather than a task.
 * Closes Wish (its draft is kept) and opens the card.
 */
export function AskFromWish({ close }: WishHeaderActionProps) {
  return (
    <IconButton
      icon={askIcon}
      label="Ask equin how to…"
      onClick={() => {
        close();
        openAsk();
      }}
    />
  );
}
