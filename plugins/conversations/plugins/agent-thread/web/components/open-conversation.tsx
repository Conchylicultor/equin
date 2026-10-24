import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";

export interface OpenConversationButtonProps {
  conversationId: string;
  /**
   * `label` — the ghost "Open conversation" button the default header ends
   * with; `icon` — an icon button ("Open in Agent Manager"), for a host's
   * own, tighter header.
   */
  display?: "label" | "icon";
}

/**
 * Open the thread's full conversation in the Agent Manager (it crosses apps
 * by itself) — the default header's link, exported for a host that draws its
 * own header (`AgentThread`'s `header`).
 */
export function OpenConversationButton({
  conversationId,
  display = "label",
}: OpenConversationButtonProps) {
  const openPane = useOpenPane();
  const link = openPane.link(
    conversationPane,
    { convId: conversationId },
    { mode: "push" },
  );
  return display === "icon" ? (
    <IconButton
      icon={navIcons.expand}
      label="Open in Agent Manager"
      {...link}
    />
  ) : (
    <Button variant="ghost" {...link}>
      Open conversation
    </Button>
  );
}
