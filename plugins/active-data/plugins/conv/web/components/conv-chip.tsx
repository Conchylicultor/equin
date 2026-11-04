import { rowOrStale } from "@plugins/network/plugins/live/web";
import { useConversationOpener } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import {
  ConversationItem,
  convStatusDot,
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
  const read = useConversationById(sideConvId || null);
  const opener = useConversationOpener();
  // The row as far as it is known (a failed re-read keeps the last-seen one);
  // the "gone" dot only once the read answered that there is no such
  // conversation — never while it loads.
  const conv = rowOrStale(read);
  const gone = read.status === "ready" && !read.found;
  const title = conv?.title?.trim();
  if (!sideConvId) return null;
  return (
    <LinkChip
      activation={opener.toggle(sideConvId)}
      tooltip={title ? `${title} · ${sideConvId}` : sideConvId}
      leading={
        !gone ? undefined : (
          <StatusDot
            {...convStatusDot({ status: "gone", statusUnverifiedSince: null })}
          />
        )
      }
      mono={!conv}
    >
      {conv ? <ConversationItem conv={conv} layout="inline" /> : sideConvId}
    </LinkChip>
  );
}
