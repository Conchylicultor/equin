import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { pagesTree, pageData } from "@plugins/page/plugins/editor/core";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import {
  blockDetailPane,
  pageDetailPane,
  useBlockTarget,
  useBlockTargetLink,
  useBlockTargetTitle,
} from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import type { IdReferentState } from "@plugins/ids/web";

/**
 * A raw `block-…` id rendered as a chip that opens what it names: a page id
 * opens the page, a content-block id opens that block as a page of its own (the
 * block view), both as a column beside the surface holding the text.
 *
 * Resolution is page-tree's `useBlockTarget` — a page id answered from its live
 * page row, a content block by one reverse lookup fired only on a miss, so a
 * transcript full of page links costs no lookup.
 *
 * Unresolvable ids render as the plain raw string: the pattern is a guess about
 * prose, and a chip that opens nothing is worse than the text the model wrote.
 */
export function PageLinkChip({
  content,
}: {
  content: string;
  attrs: Record<string, string>;
}) {
  const blockId = content.trim();
  const target = useBlockTarget(blockId);
  const title = useBlockTargetTitle(target);
  const opens = target.kind === "page" || target.kind === "block";
  const page = useLiveRow(pagesTree, opens ? target.pageId : null);
  const link = useBlockTargetLink();

  // Nothing to open, or not resolved yet: the raw string exactly as written,
  // unstyled — a font change would advertise an affordance that isn't there.
  // Until it resolves that is also all we honestly know.
  if (!opens) return <>{blockId}</>;
  // A failed page read is the same: the id is a guess about prose, so the
  // text as written beats an error inside a sentence.
  if (page.status === "loading" || page.status === "error") {
    return <>{blockId}</>;
  }
  if (title === undefined || !page.found) return <>{blockId}</>;

  return (
    <LinkChip
      activation={link(target)}
      title={
        target.kind === "page"
          ? `${title} · ${blockId}`
          : `${title} · block ${blockId}`
      }
      // `icon-auto`: the chip's slot owns the glyph size (PageIcon otherwise
      // defaults to a fixed size-4, which would override it).
      leading={
        <PageIcon icon={pageData(page.row).icon} className="icon-auto" />
      }
    >
      {title}
    </LinkChip>
  );
}

/**
 * The block presenter's referent read — what the chip shows: the page's title,
 * or "<page title> › <block type>" for a content block. Pages and content
 * blocks share one id space; the target says which one this is.
 */
export function useBlockReferent(blockId: string): IdReferentState {
  const target = useBlockTarget(blockId);
  const title = useBlockTargetTitle(target);
  if (target.kind === "pending") return { status: "loading" };
  if (target.kind === "missing") return { status: "missing" };
  if (target.kind === "error") return { status: "failed", error: target.error };
  return title === undefined
    ? { status: "loading" }
    : { status: "found", title };
}

/**
 * The link to what a block id names: a page id its page, a content-block id
 * the block view (that block as a page of its own), as a column beside the
 * surface holding the id. Which one is decided from the live pages list; an id
 * the list does not hold is a content block, whose view resolves its own page.
 */
export function useBlockTargetById(): (blockId: string) => LinkTarget {
  const pages = useLive(pagesTree);
  const openPane = useOpenPane();
  return (blockId) => {
    const isPage = foldResource(pages, {
      loading: () => false,
      error: () => false,
      ready: (list) => list.some((p) => p.id === blockId),
    });
    return isPage
      ? openPane.to(pageDetailPane, { pageId: blockId }, { mode: "push" })
      : openPane.to(blockDetailPane, { blockId }, { mode: "push" });
  };
}
