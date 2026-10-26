import { Avatar } from "@plugins/primitives/plugins/avatar/web";
import type { ConversationItemConv } from "./conversation-item";
import { statusDotPaintClass } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { convStatusDot } from "./conv-status-dot";

// Placeholder rendered by Item.Avatar when no contribution's predicate matches.
// Keeps all rows aligned along their title column. Shows the title's first
// letter on a deterministically-tinted disc so rows never appear blank.
export function AvatarFallback({ conv }: { conv: ConversationItemConv }) {
  return (
    <Avatar
      statusDot={statusDotPaintClass(convStatusDot(conv))}
      fallbackGlyph={conv.title?.trim()[0] ?? "?"}
      fallbackKey={conv.id}
    />
  );
}
