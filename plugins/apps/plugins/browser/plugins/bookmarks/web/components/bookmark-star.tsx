import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useBrowserNav } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { useBookmarkToggle } from "../internal/use-bookmarks";
import { hostOf } from "../internal/host-of";
import { symbol } from "@plugins/ui/plugins/icons/core";

const starIcon = symbol("star");

/**
 * Star toggle for the chrome bar's trailing actions. Filled when the current
 * URL is bookmarked, outline otherwise. Disabled on the start page, where
 * there is no URL to look up (so nothing is read).
 */
export function BookmarkStar() {
  const { current } = useBrowserNav();
  if (current === "") {
    return <IconButton icon={starIcon} label="Add bookmark" disabled />;
  }
  return <UrlBookmarkStar url={current} />;
}

/**
 * The star for one url. Disabled until the url's bookmark is known, rather
 * than claiming "not bookmarked" — and a click then could add a duplicate.
 */
function UrlBookmarkStar({ url }: { url: string }) {
  const state = useBookmarkToggle(url);
  if (state.status === "loading") {
    return <IconButton icon={starIcon} label="Add bookmark" disabled />;
  }
  if (state.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={starIcon}
        subject="this page's bookmark"
        error={state.error}
        refetch={state.refetch}
      />
    );
  }
  const { bookmarked, toggle } = state.data;
  return (
    <IconButton
      icon={starIcon}
      active={bookmarked}
      label={bookmarked ? "Remove bookmark" : "Add bookmark"}
      tooltip={bookmarked ? "Remove bookmark" : "Add bookmark"}
      aria-pressed={bookmarked}
      className={bookmarked ? "text-primary-text" : undefined}
      onClick={() => toggle(hostOf(url))}
    />
  );
}
