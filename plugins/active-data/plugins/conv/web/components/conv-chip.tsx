import { useConversationOpener } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import {
  ConversationItem,
  CONV_STATUS_DOT,
} from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";

export function ConvChip({
  content,
}: {
  content: string;
  attrs: Record<string, string>;
}) {
  const sideConvId = content.trim();
  const conv = useConversationById(sideConvId || null);
  const opener = useConversationOpener();
  const title = conv?.title?.trim();
  if (!sideConvId) return null;
  return (
    <LinkChip
      activation={opener.toggle(sideConvId)}
      tooltip={title ? `${title} · ${sideConvId}` : sideConvId}
      leading={conv ? undefined : <StatusDot {...CONV_STATUS_DOT.gone} />}
      mono={!conv}
    >
      {conv ? <ConversationItem conv={conv} layout="inline" /> : sideConvId}
    </LinkChip>
  );
}
