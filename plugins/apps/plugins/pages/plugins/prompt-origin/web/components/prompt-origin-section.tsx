import { useLiveRow } from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { pageData, pagesTree } from "@plugins/page/plugins/editor/core";
import { usePromptTaskLink } from "@plugins/page/plugins/prompt/plugins/link/web";
import { pageDetailPane } from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const descriptionIcon = symbol("description");

/**
 * The page this task was launched from, or `null`. Three ways it is absent:
 *
 * - the task did not come from a prompt block (the common case — every task
 *   filed from anywhere else), so there is no link row;
 * - either read is still hydrating, so we do not yet know — or failed: the
 *   origin is an optional provenance chip, so its section is not painted
 *   rather than painted as an error;
 * - the page is gone. `pageId`/`blockId` carry **no FK** by design (a task is
 *   real work and must outlive its block), so a dangling id is expected, not an
 *   error — the provenance is simply no longer navigable.
 */
function useOriginPage(
  taskId: string,
): { pageId: string; title: string } | null {
  const origin = usePromptTaskLink(taskId);
  // The page row is looked up only once the link names it.
  const linked =
    origin.status === "ready" && origin.found ? origin.row.pageId : null;
  const page = useLiveRow(pagesTree, linked);

  if (linked === null) return null;
  if (page.status === "loading" || page.status === "error") return null;
  if (!page.found) return null;

  return { pageId: linked, title: pageData(page.row).title || "Untitled" };
}

/**
 * The whole section is conditional — with no live page to link to the host
 * paints nothing at all: no card, no title, no empty state.
 */
export function usePromptOriginAvailable({
  taskId,
}: {
  taskId: string;
}): boolean {
  return useOriginPage(taskId) !== null;
}

/** "Origin" section of the task detail: a chip linking back to the source page. */
export function PromptOriginSection({ taskId }: { taskId: string }) {
  const page = useOriginPage(taskId);
  const openPane = useOpenPane();

  if (!page) return null;

  return (
    <Cluster>
      <LinkChip
        leading={<Icon icon={descriptionIcon} />}
        tooltip={page.title}
        activation={openPane.to(
          pageDetailPane,
          { pageId: page.pageId },
          { mode: "push" },
        )}
      >
        {page.title}
      </LinkChip>
    </Cluster>
  );
}
