import {
  cn,
  Separator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import {
  Pane,
  PaneChrome,
  useOpenPane,
  resolveRow,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import {
  pageBlocks,
  pagesTree,
  pageData,
  textOf,
} from "@plugins/page/plugins/editor/core";
import {
  blockDetailRoute,
  pageDetailRoute,
  pagesTreeRoute,
} from "@plugins/apps/plugins/pages/plugins/page-tree/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import type { BreadcrumbSegment } from "@plugins/primitives/plugins/breadcrumb/web";
import { Pages } from "@plugins/apps/plugins/pages/plugins/shell/web";
import { SidebarItem } from "@plugins/primitives/plugins/app-shell/web";
import { pagesApp } from "@plugins/apps/plugins/pages/plugins/shell/core";
import {
  blockContentScope,
  BlockEditor,
  PageContentColumn,
  type BlockEditorHandle,
  type CaretSurface,
} from "@plugins/page/plugins/editor/web";
import {
  PageNavigationProvider,
  type PageNavigation,
} from "@plugins/page/plugins/page-reference/web";
import { PageHeader } from "./components/page-header";
import { PageBreadcrumb } from "./components/page-breadcrumb";
import { BackToTreeButton } from "./components/back-to-tree-button";
import { PageCover } from "./components/page-cover";
import { PageDetail } from "./slots";
import {
  useBlockTarget,
  useBlockTargetTitle,
  useBlockTypeLabel,
} from "./internal/block-target";

// The centered reading measure shared by the page header, the block editor's
// content, and the section list. It supplies width + centering ONLY — no
// horizontal padding. The column's horizontal geometry (the hover rail and the
// decoration→content inset) is owned by the editor and applied through
// `PageContentColumn`; a measure that also padded its sides would shift the
// header's rail origin away from the editor's, which is exactly how the title
// and the block text came to sit on different left edges. The block editor's
// pointer/marquee surface spans the full pane width (it receives this only as
// its content wrapper), so drag-to-select works from the whitespace beside the
// column — the header and sections, which carry no such surface, apply the
// measure to themselves directly.
//
// The width is the type-scale group's reading measure (`max-w-reading`, the
// `measureReading` token), so the app's theme sets the column: Ink sizes it so
// the header's content box — inside the editor's rail and inset — is 648px.
const READING_MEASURE = cn("mx-auto w-full max-w-reading");

/** The space above the header's closing rule (see `PageBody`). */
const RULE_STYLE = { paddingTop: "calc(var(--space-xl) + var(--space-xs))" };

// Panes are declared first so their types are known before the component
// bodies reference them. The component identifiers below are hoisted function
// declarations, so the forward reference is safe at runtime.

function useResolvePage({ pageId }: { pageId: string }): ResolveResult {
  return resolveRow(useLiveRow(pagesTree, pageId));
}

export const pageDetailPane = Pane.define({
  // `pageDetailRoute` has no parent (hence no default ancestors): the page tree
  // lives in the sidebar slot, so the welcome plugin's `pages-root` empty-state
  // pane should only appear as the index for bare `/pages` — never stacked as an
  // extra Miller column to the left of an open page. Opening a page therefore
  // yields a single-entry chain that replaces the empty state rather than
  // sitting beside it.
  route: pageDetailRoute,
  app: pagesApp,
  component: PageDetailBody,
  width: 720,
  useResolve: useResolvePage,
  // Tab/document title: the page's title from its row in the pages set (same
  // source PageDetailBody renders), falling back to the pageId. The header
  // paints the breadcrumb trail instead.
  title: {
    useText: usePageTitle,
    fallback: (params) => params.pageId,
    component: PageDetailTitle,
  },
  // Main surface: aux panes opened to the right never steal the tab title.
  titleOwner: true,
});

export const pagesTreePane = Pane.define({
  title: "Pages",
  // The page tree as a Miller column, so pages can be browsed from anywhere
  // (a conversation, another app) without switching to the Pages app. The body
  // is the `Pages.Sidebar` slot itself — the very render slot the Pages app's
  // shell paints — so search, tree, trash and every future contribution appear
  // here for free and this pane never names a contributor.
  route: pagesTreeRoute,
  app: pagesApp,
  component: PagesTreeBody,
  // Nav-column width (the repo's list-column convention); detail panes run wider.
  width: 320,
  // NO `titleOwner`: this is a nav column. `pageDetailPane` owns the tab title,
  // so opening a page from here titles the tab with the page.
});

function useResolveBlock({ blockId }: { blockId: string }): ResolveResult {
  const target = useBlockTarget(blockId);
  switch (target.kind) {
    case "pending":
      return { status: "pending" };
    case "error":
      return { status: "error", error: target.error };
    case "missing":
      return { status: "missing" };
    case "page":
    case "block":
      return { status: "found" };
  }
}

export const blockDetailPane = Pane.define({
  // One block of a page — a card, a heading with its nested lines, a toggle —
  // opened as a page of its own: the editor zoomed onto that block's subtree,
  // editable, saving to the page that holds it. No parent, for the same reason
  // as `pageDetailPane`: it opens beside whatever surface named the block.
  route: blockDetailRoute,
  app: pagesApp,
  component: BlockDetailBody,
  width: 720,
  useResolve: useResolveBlock,
  title: {
    useText: useBlockPaneTitle,
    fallback: (params) => params.blockId,
    component: BlockDetailTitle,
  },
  titleOwner: true,
});

function PagesTreeBody(): ReactElement {
  return (
    <PaneChrome pane={pagesTreePane}>
      <Pages.Sidebar.Render>
        {(item) => <SidebarItem {...item} />}
      </Pages.Sidebar.Render>
    </PaneChrome>
  );
}

/**
 * The page's title from its row in the pages set, or undefined while loading
 * or failed (the tab then shows the chrome's pageId fallback).
 */
function usePageTitle({ pageId }: { pageId: string }): string | undefined {
  const result = useLiveRow(pagesTree, pageId);
  if (result.status === "loading" || result.status === "error") {
    return undefined;
  }
  return result.found ? pageData(result.row).title : undefined;
}

/** The block pane's tab title: "<page> › <block>", as its Artifacts row reads. */
function useBlockPaneTitle({
  blockId,
}: {
  blockId: string;
}): string | undefined {
  return useBlockTargetTitle(useBlockTarget(blockId));
}

/**
 * What "open that page" — and "open that block" — means on the Pages panes,
 * declared once for every page reference below them: the sub-page rows and link
 * blocks inside the editor, the backlinks list beside it, and the block menu's
 * Open as page. `swap` replaces this column (clicking a reference has always
 * navigated in place); `push` appends one to the right of this pane, which is
 * the Miller spelling of a side pane.
 *
 * One hook for both panes, so a page opened from a block view behaves exactly
 * as one opened from a page.
 */
function usePagesNavigation(): PageNavigation {
  const openPane = useOpenPane();
  return useMemo<PageNavigation>(
    () => ({
      open: (id) =>
        openPane.to(pageDetailPane, { pageId: id }, { mode: "swap" }),
      openAside: (id) =>
        openPane.to(pageDetailPane, { pageId: id }, { mode: "push" }),
      openBlock: (id) =>
        openPane.to(blockDetailPane, { blockId: id }, { mode: "push" }),
    }),
    [openPane],
  );
}

/**
 * The wiring every Pages editor pane shares: the content scope, the pane
 * chrome, and the navigation provider — so the page pane and the block pane
 * cannot drift apart in how a reference inside them opens.
 */
function PageSurface({
  pane,
  overlay,
  children,
}: {
  pane: typeof pageDetailPane | typeof blockDetailPane;
  overlay?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const nav = usePagesNavigation();
  return (
    // The scope wraps `PaneChrome` because the outline rail is a
    // `PageDetail.Overlay`, which PaneChrome renders as a SIBLING of the
    // scroller — outside the editor's subtree. This is the common ancestor of
    // the editor that publishes the block grid and the rail that reads it.
    <blockContentScope.Provider>
      <PaneChrome pane={pane} overlay={overlay}>
        <PageNavigationProvider value={nav}>{children}</PageNavigationProvider>
      </PaneChrome>
    </blockContentScope.Provider>
  );
}

/** The page pane's header title: the trail of the page its route names. */
function PageDetailTitle(): ReactElement {
  const { pageId } = pageDetailPane.useParams();
  return <PageTitleTrail pageId={pageId} />;
}

/**
 * The block pane's header title: the page's trail ending in the block's crumb —
 * or just the page's trail when the id names a page. While the block is not
 * resolved (or no longer exists) it shows the id, as the tab does.
 */
function BlockDetailTitle(): ReactElement {
  const { blockId } = blockDetailPane.useParams();
  const target = useBlockTarget(blockId);
  switch (target.kind) {
    case "block":
      return (
        <BlockTitleTrail
          pageId={target.pageId}
          blockId={target.blockId}
          type={target.type}
        />
      );
    case "page":
      return <PageTitleTrail pageId={target.pageId} />;
    case "pending":
    case "missing":
    case "error":
      return <>{blockId}</>;
  }
}

function BlockTitleTrail({
  pageId,
  blockId,
  type,
}: {
  pageId: string;
  blockId: string;
  type: string;
}): ReactElement {
  const crumb = useBlockCrumb(blockId, type);
  return (
    <PageTitleTrail pageId={pageId} leaf={{ key: blockId, label: crumb }} />
  );
}

/**
 * The breadcrumb trail is a page's single home for its title — it lives in the
 * pane-chrome bar, so the big in-body title appears exactly once. The way back
 * to the tree sits ahead of it — leading, like a browser's back button, and only
 * on the surfaces that have lost the tree (the button decides that itself,
 * painting nothing otherwise).
 */
function PageTitleTrail({
  pageId,
  leaf,
}: {
  pageId: string;
  leaf?: BreadcrumbSegment;
}): ReactElement {
  return (
    <Stack
      direction="row"
      align="center"
      gap="2xs"
      // The row yields: the button keeps its width and the trail beside it
      // is what shortens when the column is narrow.
      className={yieldClass("x")}
    >
      <BackToTreeButton />
      <PageBreadcrumb pageId={pageId} leaf={leaf} />
    </Stack>
  );
}

function PageDetailBody(): ReactElement {
  const { pageId } = pageDetailPane.useParams();
  return <PageBody pane={pageDetailPane} pageId={pageId} />;
}

function PageBody({
  pane,
  pageId,
}: {
  pane: typeof pageDetailPane | typeof blockDetailPane;
  pageId: string;
}): ReactElement {
  // The title renders above (outside) the editor's provider, so the two exchange
  // the caret through refs rather than a shared context: each is a `CaretSurface`
  // holding a ref to the other. Arrow keys — and Backspace at the top of the body
  // — then cross the boundary in both directions, as they do between two blocks.
  const bodyRef = useRef<BlockEditorHandle>(null);
  const titleRef = useRef<CaretSurface>(null);

  return (
    <PageSurface
      pane={pane}
      // `PageDetail.Overlay` — the widgets that float over the page (the
      // outline rail) — goes through PaneChrome's own overlay layer, beside
      // the scroller and BELOW the header. A host wrapped around `PaneChrome`
      // instead would make the header's own right-hand actions (star, version
      // history) the top-right corner the rail pins itself onto.
      overlay={
        <PageDetail.Overlay.Render>
          {(item) => <item.component pageId={pageId} />}
        </PageDetail.Overlay.Render>
      }
    >
      {/* Full-bleed cover scrolls away with the page (Notion-style). Below it,
        the header and section list are centered on the shared reading measure,
        while the block editor spans the full pane width (centering only its
        own content via the same measure) so a marquee drag can begin from the
        whitespace beside the column. Neither the header nor the section list is
        a block, so each wraps itself in `PageContentColumn` — the editor's own
        declaration of where a block's *content* starts. That is the single
        owner of the column geometry: the icon, title, sections, and every block
        land on one left edge, and this file never names the rail width. */}
      <Stack gap="none" className="min-h-full">
        <PageCover pageId={pageId} />
        <Stack gap="lg">
          {/* Title + body form one tight unit (no flex gap between them): the
            only space under the title is the editor's own top padding, which
            is click-to-edit — so there's no dead strip between title and
            content. */}
          <Stack gap="none">
            <div className={READING_MEASURE}>
              <PageContentColumn>
                <PageHeader
                  pageId={pageId}
                  body={bodyRef}
                  titleRef={titleRef}
                />
                {/* The hairline closing the header off from the page's
                  content, 28px under the header's under-title band (the
                  `xl` + `xs` steps). The space under it is the editor's own
                  (click-to-edit) top padding. */}
                <div style={RULE_STYLE}>
                  <Separator />
                </div>
              </PageContentColumn>
            </div>
            <BlockEditor
              ref={bodyRef}
              caretBefore={titleRef}
              pageId={pageId}
              contentClassName={READING_MEASURE}
            />
          </Stack>
          <div className={READING_MEASURE}>
            <PageContentColumn>
              <PageDetail.Host pageId={pageId} />
            </PageContentColumn>
          </div>
        </Stack>
        <TrailingClickZone body={bodyRef} />
      </Stack>
    </PageSurface>
  );
}

function BlockDetailBody(): ReactElement {
  const { blockId } = blockDetailPane.useParams();
  const target = useBlockTarget(blockId);
  switch (target.kind) {
    case "block":
      return <BlockBody pageId={target.pageId} blockId={target.blockId} />;
    // A page id opened here is simply that page.
    case "page":
      return <PageBody pane={blockDetailPane} pageId={target.pageId} />;
    // The resolve guard keeps the body mounted through a transient re-lookup
    // and a later deletion, so both states can still arrive here.
    case "pending":
      return (
        <PaneChrome pane={blockDetailPane}>
          <Loading variant="text" />
        </PaneChrome>
      );
    case "missing":
      return (
        <PaneChrome pane={blockDetailPane}>
          <Placeholder>This block no longer exists</Placeholder>
        </PaneChrome>
      );
    case "error":
      return (
        <PaneChrome pane={blockDetailPane}>
          <Placeholder tone="error">{target.error.message}</Placeholder>
        </PaneChrome>
      );
  }
}

/**
 * One block and its nested lines, editable, on the page's own reading measure.
 * No cover and no title header — those are the page's, and this is a part of
 * it; the breadcrumb names the page and then the block.
 */
function BlockBody({
  pageId,
  blockId,
}: {
  pageId: string;
  blockId: string;
}): ReactElement {
  const bodyRef = useRef<BlockEditorHandle>(null);
  return (
    <PageSurface pane={blockDetailPane}>
      <Stack gap="none" className="min-h-full">
        <BlockEditor
          ref={bodyRef}
          pageId={pageId}
          rootId={blockId}
          contentClassName={READING_MEASURE}
        />
        <TrailingClickZone body={bodyRef} />
      </Stack>
    </PageSurface>
  );
}

/**
 * The empty space below the document, to the bottom of the pane: Notion's
 * click-below-the-page — the caret goes to the last block when it is an empty
 * text block, else a fresh one is appended. It grows to fill the scroller (its
 * parent is `min-h-full`), so a short page is click-to-edit all the way down
 * rather than only in the editor's own thin trailing padding. The rule itself
 * is the editor's (`focusEnd`), shared with its in-list trailing zone.
 */
function TrailingClickZone({
  body,
}: {
  body: RefObject<BlockEditorHandle | null>;
}): ReactElement {
  return (
    // A pointer-only affordance with no keyboard twin to offer: the keyboard
    // reaches the page's end through the blocks themselves.
    <div
      aria-hidden
      className={cn(growClass(), "cursor-text pb-2xl")}
      onClick={() => body.current?.focusEnd()}
    />
  );
}

/**
 * The block's own name in the trail: its text when it has any (a heading, a
 * toggle's summary), else its type's label ("TODO") — a void card has no words
 * of its own. One row of the page's forest, read by id (`pageBlocks`' `:rows`
 * sibling): the typing projection of any OTHER block of the page refills
 * nothing here.
 */
function useBlockCrumb(blockId: string, type: string): string {
  const label = useBlockTypeLabel(type);
  const row = useLiveRow(pageBlocks, blockId);
  // Not known yet, failed, or gone: the type's label — the editor below reads
  // the page's forest and renders the failure.
  const block = row.status === "ready" && row.found ? row.row : undefined;
  const text = block === undefined ? "" : textOf(block).trim();
  return text === "" ? label : text;
}
