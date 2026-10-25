import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  useBrowserNav,
  Favicon,
} from "@plugins/apps/plugins/browser/plugins/shell/web";
import { browserRecents } from "@plugins/apps/plugins/browser/plugins/history/web";
import { hostOf } from "./link-tile";

/**
 * The "Recently visited" section: rows of recently visited pages from the live
 * `browserRecents` value (distinct-by-url, newest first). Each row shows a
 * favicon, the page title, its host and a short relative visit time; clicking
 * navigates. Rendered only once data is present and non-empty (no empty heading
 * while pending or empty).
 */
export function RecentsSection() {
  const { navigate } = useBrowserNav();
  const result = useLive(browserRecents);

  return matchResource(result, {
    loading: () => null,
    ready: (recents) => {
      if (recents.length === 0) return null;
      return (
        <Stack gap="xs">
          <Text variant="label" tone="muted">
            Recently visited
          </Text>
          <Stack gap="none" className="rail-bleed">
            {/* eslint-disable-next-line data-view/no-adhoc-row-list -- start-page quick-access widget (bounded recent window) */}
            {recents.map((r) => (
              <Row
                key={r.url}
                title={r.url}
                icon={<Favicon url={r.url} size={16} />}
                onClick={() => navigate(r.url)}
                actions={
                  <Stack direction="row" gap="md" align="center">
                    <Text variant="caption" tone="faint">
                      {hostOf(r.url)}
                    </Text>
                    <Text
                      variant="caption"
                      tone="faint"
                      className="tabular-nums"
                    >
                      <RelativeTime date={r.visitedAt} format="short" />
                    </Text>
                  </Stack>
                }
                actionsAlwaysVisible
              >
                <Text>{r.title}</Text>
              </Row>
            ))}
          </Stack>
        </Stack>
      );
    },
  });
}
