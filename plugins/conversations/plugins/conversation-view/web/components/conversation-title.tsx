import { rowOrStale } from "@plugins/network/plugins/live/web";
import { useConversationById } from "@plugins/conversations/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { conversationPane } from "../panes";

export function ConversationTitle() {
  const { convId } = conversationPane.useParams();
  const conversation = rowOrStale(useConversationById(convId));
  if (!conversation) return null;
  // The pane's one emphasised line: the palette's strong text step (body text
  // by default).
  return (
    <Text variant="label" tone="strong" className="truncate">
      {conversation.title ?? conversation.id}
    </Text>
  );
}
