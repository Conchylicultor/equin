import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useMemo } from "react";
import { statusDotPaintClass } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Avatar } from "@plugins/primitives/plugins/avatar/web";
import {
  convStatusDot,
  type ConversationItemConv,
} from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import {
  useAvatarCategoryId,
  useCategoryAvatars,
} from "../internal/use-categories";
import { useCategoryRows } from "../internal/use-conversation-categories";

export function CategoryAvatarRow({ conv }: { conv: ConversationItemConv }) {
  // Exactly ONE category paints the avatar, so a sidebar row subscribes to one
  // id — the same per-row budget as before multiple categories existed. With no
  // avatar category chosen the id set is empty and costs no query at all.
  const avatarCategoryId = useAvatarCategoryId();
  const categoryIds = useMemo(
    () => (avatarCategoryId ? [avatarCategoryId] : []),
    [avatarCategoryId],
  );
  const rows = useCategoryRows(conv.id, categoryIds);
  const avatars = useCategoryAvatars(avatarCategoryId);

  // The assignment isn't known yet: a neutral disc (status dot only), never the
  // title-glyph that means "this conversation has no category icon". With no
  // avatar category chosen there is nothing to wait for.
  // A failed read is the error glyph (hover names it, click retries), never
  // the neutral disc, which would read as "still loading" forever.
  if (avatarCategoryId && rows.status === "loading") {
    return (
      <Avatar statusDot={statusDotPaintClass(convStatusDot(conv))} colorless />
    );
  }
  if (avatarCategoryId && rows.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the category"
        error={rows.error}
        refetch={rows.refetch}
      />
    );
  }
  let item: string | undefined;
  if (avatarCategoryId && rows.status === "ready")
    item = rows.data.get(avatarCategoryId)?.item;
  const avatar = item ? avatars[item] : undefined;
  const hasIcon = avatar?.icon != null;

  // Without a category icon, fall back to a title-glyph on a deterministic
  // tint instead of a blank disc (rows must never appear empty).
  return (
    <Avatar
      icon={avatar?.icon ?? null}
      statusDot={statusDotPaintClass(convStatusDot(conv))}
      colorless={hasIcon}
      fallbackGlyph={hasIcon ? undefined : (conv.title?.trim()[0] ?? "?")}
      fallbackKey={hasIcon ? undefined : conv.id}
    />
  );
}
