import { rowOrStale } from "@plugins/network/plugins/live/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import {
  modelMeta,
  normalizeModel,
} from "@plugins/conversations/plugins/model-provider/core";
import { HeaderChip } from "@plugins/conversations/plugins/conversation-view/plugins/header/web";

export function ModelBadge() {
  const { convId } = conversationPane.useParams();
  const conversation = rowOrStale(useConversationById(convId));
  if (!conversation) return null;
  const model = normalizeModel(conversation.model);
  const meta = modelMeta(model);
  // The neutral header chip: the palette's `chip` fill (default `muted`, the
  // badge fill it always had) and `subtle` text (default muted).
  return (
    <HeaderChip colorClass="bg-chip text-subtle-foreground border-border">
      {meta.label}
    </HeaderChip>
  );
}
