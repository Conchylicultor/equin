import {
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import {
  pageData,
  pagesTree,
  type PageRow,
} from "@plugins/page/plugins/editor/core";
import { pageDetailPane } from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const descriptionIcon = symbol("description");

/** `block-7f1a2d3d-a3cd-…` → `7f1a2d3d…` — enough to recognize, short enough to sit in a header. */
function shortenBlockId(id: string): string {
  const body = id.startsWith("block-") ? id.slice("block-".length) : id;
  return body.length > 8 ? `${body.slice(0, 8)}…` : body;
}

/**
 * The page row as far as it is known: the found row, or — on a failed re-read —
 * the row as last seen. `undefined` while loading, when absent, or when it
 * failed before it was ever seen.
 */
function seenPage(result: LiveRowResult<PageRow>): PageRow | undefined {
  switch (result.status) {
    case "loading":
      return undefined;
    case "error":
      return result.stale;
    case "ready":
      return result.found ? result.row : undefined;
  }
}

/** The row's target as the only thing known about it: its id. */
function BlockIdBadge({ id }: { id: string }) {
  return (
    <Badge variant="muted" mono tooltip={id}>
      {shortenBlockId(id)}
    </Badge>
  );
}

/**
 * Which page a page-tool call acted on — the identity affordance these rows
 * carry, as `FilePath` is for the file tools.
 *
 * Two arms, and the second is NOT an error path. The page tools write to the
 * shared instance while the viewer reads whichever instance it is served from,
 * so a worktree's stale DB fork routinely has no row for a page that exists;
 * and `blockId` may name a block *inside* a page rather than the page itself,
 * which the pages set (pages only) will never carry. Either way the row
 * still has to name its target, so it falls back to the raw id.
 *
 * The same id is what it shows while the page row is still loading (or
 * failed with nothing seen before): the
 * id is known from the call itself and is never revised, so it is the honest
 * partial answer rather than a placeholder standing in for one.
 */
export function PageRefChip({
  pageId,
  blockId,
}: {
  pageId?: string;
  blockId?: string;
}) {
  // The page by `pageId`, else the block itself when it is a page. A missing
  // (or empty) id reads nothing.
  const byPage = useLiveRow(pagesTree, pageId || null);
  const byBlock = useLiveRow(pagesTree, blockId || null);
  const openPane = useOpenPane();

  const id = pageId || blockId;
  // No id at all means the call carried no target — an empty chip would be
  // chrome standing in for information the row does not have.
  if (!id) return null;
  // A failed read keeps the page as last seen, else falls back to the same
  // raw id — the honest partial answer, as while loading.
  const page = seenPage(byPage) ?? seenPage(byBlock);
  if (!page) return <BlockIdBadge id={id} />;

  const title = pageData(page).title || "Untitled";
  return (
    <LinkChip
      leading={<Icon icon={descriptionIcon} />}
      tooltip={title}
      activation={openPane.to(
        pageDetailPane,
        { pageId: page.id },
        { mode: "push" },
      )}
    >
      {title}
    </LinkChip>
  );
}
