import { DropdownMenuItem } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useStar } from "../internal/use-star";

const starIcon = symbol("star");

/**
 * The favorites toggle in the page's "⋯" menu (`PageDetail.MenuItem`). The
 * star is drawn filled when the page is a favorite.
 */
export function StarMenuItem({ pageId }: { pageId: string }) {
  const star = useStar(pageId);
  if (star.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="favorites"
        error={star.error}
        refetch={star.refetch}
      />
    );
  }
  if (star.status === "loading") {
    // Not known yet: never "Add to favorites", which is a claim the page is
    // not one.
    return (
      <DropdownMenuItem disabled>
        <Icon icon={starIcon} />
        <Loading variant="text" label="Loading favorites…" />
      </DropdownMenuItem>
    );
  }
  const { isStarred, toggle } = star.data;
  return (
    <DropdownMenuItem onClick={toggle}>
      <Icon icon={starIcon} active={isStarred} />
      {isStarred ? "Remove from favorites" : "Add to favorites"}
    </DropdownMenuItem>
  );
}
