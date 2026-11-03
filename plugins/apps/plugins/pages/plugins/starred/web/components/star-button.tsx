import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useStar } from "../internal/use-star";
import { symbol } from "@plugins/ui/plugins/icons/core";

const starIcon = symbol("star");

/**
 * Presentational star toggle shared by the sidebar row action and the page
 * header. The star is drawn active (filled) when favorited, at rest when not.
 */
export function StarButton({ pageId }: { pageId: string }) {
  const star = useStar(pageId);
  if (star.status === "loading") {
    // Not known yet: the button's own loading state (a spinner, disabled) —
    // never the hollow star, which is what "not a favorite" looks like.
    return <IconButton icon={starIcon} label="Loading favorites" loading />;
  }
  if (star.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={starIcon}
        subject="favorites"
        error={star.error}
        refetch={star.refetch}
      />
    );
  }
  const { isStarred, toggle } = star.data;
  return (
    <IconButton
      icon={starIcon}
      active={isStarred}
      label={isStarred ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={isStarred}
      onClick={toggle}
    />
  );
}
