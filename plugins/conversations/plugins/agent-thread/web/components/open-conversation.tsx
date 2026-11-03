import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";

export interface OpenConversationButtonProps {
  conversationId: string;
  /**
   * Called after a plain click opened the conversation here — for a host
   * that should get out of the way once it is on screen (a floating card).
   * Not on a ⌘/middle-click: that opens it in another browser tab, so this
   * one stays as it was.
   */
  onOpened?: () => void;
}

/**
 * Open the thread's full conversation in the Agent Manager (it crosses apps
 * by itself) as the standard expand icon — the default header's link, exported for a host that draws its
 * own header (`AgentThread`'s `header`).
 */
export function OpenConversationButton({
  conversationId,
  onOpened,
}: OpenConversationButtonProps) {
  const openPane = useOpenPane();
  const target = openPane.to(
    conversationPane,
    { convId: conversationId },
    { mode: "push" },
  );
  const link = linkProps({
    open: () => {
      target.open();
      onOpened?.();
    },
    href: target.href,
  });
  return (
    <IconButton
      icon={navIcons.expand}
      label="Open in Agent Manager"
      {...link}
    />
  );
}
