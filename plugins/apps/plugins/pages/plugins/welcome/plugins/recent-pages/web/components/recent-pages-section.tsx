import { type ReactElement } from "react";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { pagesTree, pageData } from "@plugins/page/plugins/editor/core";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import { pageDetailPane } from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const arrowForwardIcon = symbol("arrow-forward");

const RECENT_LIMIT = 6;

export function RecentPagesSection(): ReactElement | null {
  const openPane = useOpenPane();
  const result = useLive(pagesTree);

  if (result.status === "loading" || result.status === "error") {
    return (
      <Stack gap="md">
        <Text as="span" variant="label" tone="muted">
          Recent pages
        </Text>
        {result.status === "loading" ? (
          <Loading variant="rows" count={3} />
        ) : (
          <ResourceErrorInline
            variant="block"
            subject="recent pages"
            error={result.error}
            refetch={result.refetch}
          />
        )}
      </Stack>
    );
  }

  // Quick-create already covers first creation; omit the section entirely when
  // there are no pages yet rather than rendering an empty header.
  if (result.data.length === 0) return null;

  const recent = result.data
    .slice()
    // `editedAt`, not `updatedAt`: a content edit moves only the former (the
    // page row's own stamp moves on a rename, a cover or a kind change).
    .sort((a, b) => b.editedAt.getTime() - a.editedAt.getTime())
    .slice(0, RECENT_LIMIT);

  return (
    <Stack gap="md">
      <Text as="span" variant="label" tone="muted">
        Recent pages
      </Text>
      <Card className="rounded-lg p-none">
        <Clip className="rounded-lg">
          <Stack gap="none" className="divide-y">
            {recent.map((page) => {
              const { title, icon } = pageData(page);
              return (
                <Stack
                  key={page.id}
                  as="button"
                  direction="row"
                  gap="md"
                  align="center"
                  className="px-md py-sm text-left transition-colors hover:bg-accent"
                  {...openPane.link(
                    pageDetailPane,
                    { pageId: page.id },
                    { mode: "push" },
                  )}
                >
                  <PageIcon
                    icon={icon}
                    className={cn("size-5 text-muted-foreground", rigidClass())}
                  />
                  <Fill as="span">
                    <Text variant="body">{title || "Untitled"}</Text>
                  </Fill>
                  <RelativeTime
                    date={page.editedAt}
                    className={cn(
                      rigidClass(),
                      "text-caption text-muted-foreground",
                    )}
                  />
                  <Icon
                    icon={arrowForwardIcon}
                    className={cn(
                      "size-4 text-muted-foreground/50",
                      rigidClass(),
                    )}
                  />
                </Stack>
              );
            })}
          </Stack>
        </Clip>
      </Card>
    </Stack>
  );
}
