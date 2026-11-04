import { rowOrStale } from "@plugins/network/plugins/live/web";
import { PaneIconAction } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const codeIcon = symbol("code");

export function VscodeButton() {
  const { convId } = conversationPane.useParams();
  const conversation = rowOrStale(useConversationById(convId));
  if (!conversation) return null;
  return (
    <PaneIconAction
      label="VSCode"
      icon={codeIcon}
      onClick={() => {
        if (!conversation.worktreePath) return;
        window.open(
          `http://localhost:8110/?folder=${encodeURIComponent(conversation.worktreePath)}`,
          "_blank",
        );
      }}
    />
  );
}
