import { Bar } from "@plugins/primitives/plugins/bar/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  useBrowserNav,
  Favicon,
} from "@plugins/apps/plugins/browser/plugins/shell/web";
import { useBookmarks } from "../internal/use-bookmarks";
import { hostOf } from "../internal/host-of";
import { symbol } from "@plugins/ui/plugins/icons/core";
import "./bookmarks-bar.css";

const closeIcon = symbol("close");

/**
 * The bookmarks bar — a `pane`-tier sub-row of clickable chips, one per
 * bookmark in the collection's default window. Clicking a chip navigates; a
 * hover-revealed × removes it; a trailing "More" grows the window when it is
 * full. Renders nothing while loading or when there are no bookmarks (no empty
 * chrome row). It sits in the browser's chrome block, which draws the one
 * hairline under toolbar + bookmarks, so the bar drops its own.
 */
export function BookmarksBar() {
  const { navigate } = useBrowserNav();
  const { result, remove } = useBookmarks();
  switch (result.status) {
    case "loading":
      return null;
    case "error":
      // A failed read is said, in the bar's own row — never the silent
      // nothing a still-loading (or empty) list renders.
      return (
        <Bar tier="pane" className="border-b-0">
          <ResourceErrorInline
            variant="inline"
            subject="bookmarks"
            error={result.error}
            refetch={result.refetch}
          />
        </Bar>
      );
    case "ready":
      break;
  }
  const bookmarks = result.data;
  if (bookmarks.length === 0) return null;
  // A grow in flight reports `canGrow: false` (the grown window's size is not
  // known yet), so the button stays up — loading — while `growing`.
  const more =
    result.canGrow || result.growing ? (
      <Button
        variant="ghost"
        loading={result.growing}
        onClick={result.loadMore}
      >
        More
      </Button>
    ) : null;

  return (
    <Bar tier="pane" className="border-b-0">
      <Stack direction="row" gap="2xs" align="center">
        {/* eslint-disable-next-line data-view/no-adhoc-row-list -- bookmarks bar chrome strip */}
        {bookmarks.map((b) => (
          <Row
            key={b.id}
            size="sm"
            className="browser-bookmark w-auto"
            title={b.title}
            icon={<Favicon url={b.url} size={14} />}
            onClick={() => navigate(b.url)}
            actions={
              <ControlSizeProvider size="xs">
                <IconButton
                  icon={closeIcon}
                  label="Remove bookmark"
                  tooltip="Remove bookmark"
                  onClick={() => void remove(b.id)}
                />
              </ControlSizeProvider>
            }
          >
            <Text variant="body" className="browser-bookmark-label">
              {hostOf(b.url)}
            </Text>
          </Row>
        ))}
        {more}
      </Stack>
    </Bar>
  );
}
