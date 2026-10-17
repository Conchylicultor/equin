import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import {
  pageData,
  pageKindOf,
  pagesTree,
  type PageRow,
} from "@plugins/page/plugins/editor/core";
import type { PageReferenceChipProps } from "@plugins/page/plugins/page-reference/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const publicIcon = symbol("public");

/**
 * The chip at the right edge of an instructions page's row: `Global` when the
 * page is handed to every conversation at its start, nothing otherwise — the row's
 * tint already says "instructions", and the reach is the one fact it cannot.
 *
 * The chip is handed only the page's id, so it reads the page's kind off the
 * page's live row (the set the sidebar renders from). While that row is still
 * loading it waits as a chip-sized shimmer rather than claiming "not global"; a
 * failed read answers from the row it last saw, else is a chip-sized failure
 * with its retry.
 */
export function InstructionsPageChip({ pageId }: PageReferenceChipProps) {
  const result = useLiveRow(pagesTree, pageId);
  let page: PageRow | undefined;
  switch (result.status) {
    case "loading":
      return <Loading variant="block" className="h-5 w-16" />;
    case "error":
      if (result.stale === undefined) {
        return (
          <ResourceErrorInline
            error={result.error}
            refetch={result.refetch}
            variant="icon"
            subject="the page's reach"
          />
        );
      }
      page = result.stale;
      break;
    case "ready":
      page = result.found ? result.row : undefined;
  }
  if (!page) return null;
  const kind = pageKindOf(pageData(page));
  if (kind.kind !== "instructions" || !kind.global) return null;
  return (
    <Badge
      variant="primary"
      icon={<Icon icon={publicIcon} />}
      tooltip="Handed to every agent conversation at its start"
    >
      Global
    </Badge>
  );
}
