import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useBrowserNav } from "@plugins/apps/plugins/browser/plugins/shell/web";
import {
  browserBookmarks,
  type BookmarkRow,
} from "@plugins/apps/plugins/browser/plugins/bookmarks/web";
import { LinkTile, hostOf } from "./link-tile";

/**
 * A curated set of framing-friendly default sites — these allow iframe
 * embedding, so clicking a pin actually loads the page inside the webview.
 */
const QUICK_LINKS: { url: string; label: string }[] = [
  { url: "https://example.com", label: "Example" },
  { url: "https://news.ycombinator.com", label: "Hacker News" },
  { url: "https://developer.mozilla.org", label: "MDN" },
];

/**
 * The pins grid: the curated quick links, then every bookmark in the live
 * `browserBookmarks` collection's default window (oldest first), with a "Show
 * more" that grows it when it is full. While the bookmarks load the grid holds
 * the quick links alone — the bookmarks join them once known, never an empty
 * stand-in — and a failed read is said under the grid.
 */
export function Pins() {
  const { navigate } = useBrowserNav();
  const result = useLive(browserBookmarks);
  const quickHosts = new Set(QUICK_LINKS.map((l) => hostOf(l.url)));

  const grid = (bookmarks: BookmarkRow[]) => (
    <Grid minCellWidth="5.5rem" gap="sm">
      {QUICK_LINKS.map((link) => (
        <LinkTile
          key={link.url}
          url={link.url}
          label={link.label}
          onClick={() => navigate(link.url)}
        />
      ))}
      {bookmarks
        .filter((b) => !quickHosts.has(hostOf(b.url)))
        .map((b) => (
          <LinkTile
            key={b.id}
            url={b.url}
            label={b.title}
            onClick={() => navigate(b.url)}
          />
        ))}
    </Grid>
  );

  switch (result.status) {
    case "loading":
      return grid([]);
    case "error":
      return (
        <Stack gap="sm">
          {grid([])}
          <ResourceErrorInline
            variant="inline"
            subject="bookmarks"
            error={result.error}
            refetch={result.refetch}
          />
        </Stack>
      );
    case "ready":
      break;
  }
  return (
    <Stack gap="sm">
      {grid(result.data)}
      {/* A grow in flight reports `canGrow: false` (the grown window's size is
      not known yet), so the button stays up — loading — while `growing`. */}
      {(result.canGrow || result.growing) && (
        <Button
          variant="ghost"
          loading={result.growing}
          onClick={result.loadMore}
        >
          Show more
        </Button>
      )}
    </Stack>
  );
}
