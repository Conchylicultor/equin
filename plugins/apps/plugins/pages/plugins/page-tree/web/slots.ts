import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import { defineDetailSections } from "@plugins/primitives/plugins/detail-sections/web";
import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type {
  Block,
  PageRow,
  PagesTreeRow,
} from "@plugins/page/plugins/editor/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/**
 * Sections rendered below a page's editor in the page-detail pane. The host
 * paints each contribution as a collapsible `SectionCard`, so a section supplies
 * a `label` and a body and never its own title.
 *
 * A section that does not apply to the open page declares `useAvailable` — it
 * must NOT `return null` from its body, which would leave an empty titled card
 * on every page (that is exactly what "Linked from" and "Story" would do).
 *
 * The factory id is `"pages.detail"` — NOT `"pages"` — because the emitted slot
 * id is `` `${id}.section` `` verbatim and `reorderDirectiveDescriptor` uses a
 * slot id verbatim as its config_v2 config name. `pages.detail.section` is what
 * this pane's persisted section order is already keyed by.
 */
const pageDetailSections = defineDetailSections<{
  pageId: string;
}> // `PageContentColumn` already places sections at the page's block inset — the
(
  // documented invariant that the title, icon, and section list share one
  // content edge with the blocks (see `page/editor/internal/page-column.ts`).
  // The stack must not inset them a second time or the cards would sit visibly
  // narrower than the text above them.
  { inset: "none" },
);

/**
 * A piece of the page's title header — a tool in the hover row above the title,
 * or a row under it. The header paints it bare, at the header's own inset: the
 * contribution owns its content and nothing else.
 *
 * A contribution that has nothing to offer on the open page declares
 * `useAvailable` rather than returning `null` — the same gate `Section` takes,
 * resolved by the header before anything is painted, so a hover row whose tools
 * are all unavailable disappears instead of leaving an empty band.
 */
export interface PageHeaderPart {
  component: ComponentType<PageHeaderPartProps>;
  useAvailable?: Hook<(props: PageHeaderPartProps) => boolean>;
}

/**
 * What the header hands each part: the open page's id and its row, already
 * resolved — a part is painted only once the page is known, so it never reads
 * the pages list itself.
 */
export interface PageHeaderPartProps {
  pageId: string;
  page: Block;
}

export const PageDetail = {
  /**
   * The hover-revealed tool row above the page title (Add icon / Change icon /
   * Add cover): quiet ghost buttons that appear while the pointer is over the
   * header.
   */
  HeaderTool: defineRenderSlot<PageHeaderPart>({ docLabel: (p) => p.id }),
  /**
   * Rows under the page title, in the header's flow: what is ABOUT the page as
   * a whole (the pages linking here; later, its properties) — distinct from
   * `Section`, a card below the whole document.
   */
  UnderTitle: defineRenderSlot<PageHeaderPart>({ docLabel: (p) => p.id }),
  Section: pageDetailSections.Section,
  /** Renders every contributed section. Mounted by `pageDetailPane`. */
  Host: pageDetailSections.Host,
  /**
   * A widget floating OVER the open page — an outline rail, a reading-progress
   * indicator. The host gives it a positioning context and nothing else: a
   * contribution owns its own placement inside that box (typically a `Pin`).
   *
   * Neither of the other two seams has this shape. `Section` is an in-flow card
   * *below* the editor, and a `pageDetailPane.Actions` item is a button *in*
   * the header strip; an overlay is on top of the page and is not part of its flow at all.
   *
   * The host's positioning box wraps the pane, deliberately outside the pane's
   * one scroller — an absolutely-positioned child of a scroller scrolls away
   * with the document, which is the one thing a "where am I" indicator must not
   * do. Mirrors `JsonlViewer.Overlay`, the same seam on the conversation
   * transcript.
   */
  Overlay: defineRenderSlot<{
    component: ComponentType<{ pageId: string }>;
  }>({ docLabel: (p) => p.id }),
};

/**
 * Extension seams the page-tree sidebar DataView exposes:
 *
 *  - `RowActions` — trailing actions on a page-tree row (e.g. delete, star).
 *    Mirrors the task-list `Tasks.TaskActions` pattern so other plugins can add
 *    row actions without editing the row component. Contributors receive the
 *    full page `row` (derive id/title from it) via `ItemActionProps<PagesTreeRow>`.
 *
 * There is no field seam: the sidebar's fields are `pages.tree`'s, derived —
 * a plugin that adds a field to every page (starred, origin, tags) EXPOSES it
 * on its `page_blocks` extension (`defineExtensionShape({ exposes })`), so
 * "Favorites" is just a filtered `list` view over the exposed `starred`.
 */
export const PageTree = {
  RowActions: defineItemActions<PagesTreeRow>(),
  /**
   * A small always-visible mark at a page-tree row's trailing edge — what
   * something says ABOUT the page at a glance (its tags, as colored dots). The
   * sidebar is the app's narrowest surface, so a marker is a glyph or two,
   * never a chip with words: it takes width from the title on every row.
   *
   * Every contribution renders, in this slot's configured order, as one rigid
   * cluster flush with the row's right edge (so the marks of every row form a
   * column). A contribution with nothing to mark on a page renders nothing.
   * The row's hover actions are pinned over the same edge with a scrim, so on
   * hover the actions cover the marker rather than crowding the title.
   */
  RowMarker: defineRenderSlot<{
    component: ComponentType<{ page: PageRow }>;
  }>({ docLabel: (p) => p.id }),
};
