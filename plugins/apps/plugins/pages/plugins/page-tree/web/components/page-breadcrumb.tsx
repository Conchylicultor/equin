import { type ReactElement } from "react";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  Breadcrumb,
  type BreadcrumbSegment,
} from "@plugins/primitives/plugins/breadcrumb/web";
import {
  pagesTree,
  pageData,
  type Block,
} from "@plugins/page/plugins/editor/core";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { pageAncestors } from "../ancestors";
import { pageDetailPane } from "../panes";

/**
 * One crumb: the page's icon, then its name. The pair sits a control's
 * icon-to-label gap apart (`gap-control-sm`: the trail lives in the `sm` pane
 * bar, and each crumb is a control in it), and the glyph is drawn at 13px — the
 * emoji box is the font size over the 85% an `EmojiGlyph` draws its character
 * at.
 */
function SegmentLabel({ page }: { page: Block }): ReactElement {
  const data = pageData(page);
  return (
    <Inline gap="none" className="gap-control-sm">
      <PageIcon icon={data.icon} className="size-[calc(13px/0.85)]" />
      {data.title || "Untitled"}
    </Inline>
  );
}

/**
 * Notion-style ancestor trail rendered in the page pane's chrome title bar — the
 * single home for the page's title. Ancestors are clickable segments; the
 * current page is the inert trailing leaf, so the big in-body title is the only
 * other place the title appears. A root page with no ancestors still shows its
 * own title as the lone segment; renders nothing only while the pages resource
 * loads (and the failure, with Retry, when it failed). Typography size is owned by PaneChrome's title container — this trail
 * carries only the per-segment weight/color baked into the Breadcrumb primitive,
 * never its own size or inset.
 */
export function PageBreadcrumb({
  pageId,
  leaf,
}: {
  pageId: string;
  /**
   * A trailing crumb past the page — the block a block view is zoomed into. The
   * page then becomes a navigable ancestor and this is the inert leaf.
   */
  leaf?: BreadcrumbSegment;
}): ReactElement | null {
  const openPane = useOpenPane();
  // The whole set: the trail walks the `pageId` chain up through it.
  const result = useLive(pagesTree);
  if (result.status === "loading") return null;
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the page"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }

  const current = result.data.find((p) => p.id === pageId);
  if (!current) return null;
  const ancestors = pageAncestors(result.data, pageId);

  const chain = [...ancestors, current];
  const segments: BreadcrumbSegment[] = chain.map((page) => ({
    key: page.id,
    label: <SegmentLabel page={page} />,
    activation: openPane.to(
      pageDetailPane,
      { pageId: page.id },
      { mode: "swap" },
    ),
  }));
  if (leaf !== undefined) segments.push(leaf);

  return (
    <Breadcrumb
      segments={segments}
      // One weight for the whole trail: the page's own name is singled out by
      // its colour (the strong tier) against the muted ancestors.
      leafWeight="normal"
      leafTone="strong"
      // The trail is the page's address, set in the body role like the
      // sidebar rows that name the same pages.
      text="body"
    />
  );
}
