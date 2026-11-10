import { useMemo } from "react";
import {
  useEndpointMutation,
  useFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  useCurrentPane,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
  treeAliases,
  type CreateOption,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type { SectionsToolbar } from "@plugins/primitives/plugins/data-view/core";
import {
  pagesTree,
  updateBlock,
  moveBlock,
  pageData,
  type PageData,
  type PageRow,
  type PagesTreeRow,
} from "@plugins/page/plugins/editor/core";
import { pageLinkTargets } from "@plugins/page/plugins/links/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import { usePageReferenceTint } from "@plugins/page/plugins/page-reference/web";
import { pageDetailPane, pagesTreePane } from "../panes";
import { createPageWithSeed } from "../internal/create-page-with-seed";
import { PageTree } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

const PAGES_SIDEBAR_VIEW = defineDataView("pages-sidebar");

/**
 * Every authored view instance at once — Favorites, Private, Scratch — each
 * under its own collapsible header, instead of a switcher showing one. Module
 * scope: a toolbar spec is data the host reads, one value for the surface.
 *
 * Headers in the `group` form: sentence case in the `group` type role and
 * `groupForeground`, the mockup's quiet "Favorites" / "Private" heads rather
 * than the small-caps eyebrow.
 */
const SECTIONS: SectionsToolbar = {
  kind: "sections",
  forms: { header: "group" },
};

/** The open page's row reads in the title tier: strong text, medium weight. */
const ACTIVE_LABEL = cn("font-medium text-strong-foreground");

/**
 * Pages a page links to (page-link blocks, inline [[links]]) appear as
 * read-only reference children of the linking page — a link-to-page block AT
 * its place among the sub-pages (its `docRank`, minted in the same group),
 * an inline link after them. The tree reads each held
 * row's link targets by id (`pageLinkTargets`, one read per loaded level), so
 * the sidebar holds the links of the rows its windows hold, never every link;
 * a target no window holds is read by id while its linking page is open.
 * While a level's targets load the tree renders without them (they pop in —
 * never a wrong hierarchy; the aliases are an enrichment).
 */
const LINK_ALIASES = treeAliases({
  collection: pageLinkTargets,
  targets: (row) => row.linksTo,
  rank: (row, target) => {
    const at = row.linkRanks[target];
    return at === undefined ? null : Rank.from(at);
  },
});

/**
 * The pages as a live TREE source (`pagesTree` declares `tree: { parent:
 * "pageId", rank: "docRank" }`): every section reads bounded windows — the
 * Private / Scratch outlines their root level plus one window per open page,
 * each level in `docRank` order; Favorites and Recent (flat `list` views)
 * their own filtered / sorted window. Search ("Search pages…") matches the
 * `title` column server-side, its hits drawn with their ancestors.
 *
 * The hierarchy is `pageId` (the denormalized nearest PAGE ancestor), NOT the
 * raw block-forest `parentId`: a sub-page's direct parent may be a content
 * block (nested under a text line, a toggle, …), which would orphan it to the
 * root. `pageId` is also invariant under intra-page block moves. Siblings
 * order by `docRank`, NOT the storage `rank` (comparable only within one
 * `(parent_id, rank)` space, which a sibling group can span several of).
 */
const pagesSource = liveDataSource(pagesTree, {
  surface: PAGES_SIDEBAR_VIEW,
  searchable: ["title"],
});

/** The page's icon: the row's lead (the tree's icon box, the list's glyph). */
const ICON_FIELD: FieldDef<PagesTreeRow> = {
  id: "icon",
  label: "Icon",
  type: "icon",
  header: false,
  filterable: false,
  sortable: false,
  groupable: false,
  value: (b) => b.id,
  cell: (b) => <PageIcon icon={pageData(b).icon} className="size-4" />,
};
const EXTRA_FIELDS: FieldDef<PagesTreeRow>[] = [ICON_FIELD];

/**
 * Every field but the icon is `pagesTree`'s, derived — its `title`,
 * `editedAt` and every field an extension of a block exposes (`starred`,
 * `origin`, `tags`), each presented by its owner; the sidebar names none of
 * them. What it changes: the title is the row's label, renamed in place (the
 * tree's inline editor) by `updateBlock` on the page payload; the parent
 * column is the tree's structure, never printed.
 */
function useSidebarOverrides() {
  const updateBlockData = useEndpointMutation(updateBlock);
  return useMemo(
    () =>
      fieldOverrides(pagesTree, {
        title: {
          primary: true,
          onEdit: (b, next) => {
            const data: PageData = {
              ...pageData(b),
              title: String(next ?? "").trim() || "Untitled",
            };
            updateBlockData.mutate({ params: { id: b.id }, body: { data } });
          },
        },
        pageId: { visible: false },
      }),
    [updateBlockData],
  );
}

export function PagesSidebar() {
  const fetchEndpoint = useFetchEndpoint();
  const overrides = useSidebarOverrides();
  const openPane = useOpenPane();
  const tintOf = usePageReferenceTint();
  const selectedId = pageDetailPane.useRouteEntry()?.params.pageId;
  const hasMarkers = PageTree.RowMarker.useContributions().length > 0;
  // Where a page opens depends on WHICH host is showing this tree, and the tree
  // can read that off its own position instead of being told:
  //
  //  - The Pages app's sidebar — persistent chrome that stays put whatever is
  //    open — so the page opens as a column BESIDE it ("push").
  //  - The `pagesTreePane` column, opened next to a conversation in another
  //    app — a navigable surface, so activating a row navigates that column to
  //    the page ("swap"), the way a file list moves its own column rather than
  //    growing a third one. `PageBackToTreeAction` in the page's header puts
  //    the tree back.
  const inOwnColumn = useCurrentPane()?.id === pagesTreePane.id;
  const openMode = inOwnColumn ? ("swap" as const) : ("push" as const);

  // Plain literals (not the view children's options helpers) to respect
  // data-view's collection-consumer separation — consumers never import a view
  // child.
  const viewOptions = useMemo(() => {
    const activeLabel = (b: PagesTreeRow) =>
      b.id === selectedId ? ACTIVE_LABEL : undefined;
    return {
      table: {
        labelClassName: activeLabel,
        // No `rowMenu`: "Add page below" is an ordinary item action
        // (`AddPageBelowAction`) contributed to `PageTree.RowActions`, so the row
        // carries ONE action registry with one authored overflow bucket instead
        // of the tree's "⋯" growing a second, parallel menu beside it.
        //
        // Root creation lives on the Private section header's "+" (the DataView
        // `creators`, narrowed to that section) and the sidebar's own "New page"
        // row, and per-row sub-page creation on each row's hover "+", so the
        // tree's own footer "Add" line is dropped for a more compact tree.
        addLabel: null,
        dragOverlay: (b: PageRow) => pageData(b).title || "Untitled",
        // A decorated KIND of page (an agent-authored one, …) keeps its wash
        // here too, painted as the tree's full-row accent layer — which sits
        // over the row, so it composes with hover and selection instead of
        // replacing them. Tint only: the sidebar has no room for a chip, and
        // a row of no decorated kind paints no layer at all.
        // What other plugins mark a page with (its tags' dots, …), flush with
        // the row's right edge. Only while something contributes: with no
        // marker at all, the rows keep their whole width for the title.
        trailing: hasMarkers
          ? (b: PagesTreeRow) => <RowMarkers page={b} />
          : undefined,
        rowAccent: (b: PageRow) => {
          const tint = tintOf(pageData(b));
          return tint === undefined ? null : (
            <div aria-hidden className={cn("size-full rounded-md", tint)} />
          );
        },
      },
      // Favorites (a filtered `list` view) draws its rows through the tree's
      // own row chrome, so a favourite and the same page in the tree below are
      // one row by construction — height, indent, icon box, hover, selection.
      list: {
        rowChrome: "tree" as const,
        labelClassName: activeLabel,
      },
    };
  }, [tintOf, selectedId, hasMarkers]);

  const creators = useMemo<CreateOption[]>(() => {
    const createRootPage = async () => {
      const id = await createPageWithSeed(fetchEndpoint, { parentId: null });
      openPane(pageDetailPane, { pageId: id }, { mode: openMode });
    };
    return [
      {
        id: "new-page",
        label: "New page",
        icon: <Icon icon={addIcon} />,
        onSelect: createRootPage,
        // Only the Private section's header offers it: a new page is a user
        // root page, which lands there — never in Favorites or Scratch.
        views: ["pages"],
      },
    ];
  }, [fetchEndpoint, openPane, openMode]);

  // The DataView's section headers ARE the sidebar chrome (no
  // SidebarPaneSection): every view instance stacks in config order under its
  // own collapsible header. This `Scroll` is the direct flex child of the
  // app-shell sidebar `Stack` — and its only growing item, so the `New page` /
  // `Trash` rows after it sit at the bottom; the DataView never owns a scroll —
  // each section's `Sticky` header pins against it.
  return (
    // `pt-2xs`: with the section heads' own top padding (the theme's
    // `sectionHeadPadTop`), the first head sits where the mockup's does under
    // the search field. The padding sits on an inner box, never on the
    // `Scroll`: a sticky header pins at its scroller's PADDING edge, so padding
    // on the scroller leaves a see-through strip above the pinned head where
    // the scrolled rows show.
    <Scroll fill>
      <div className="pt-2xs pb-xs">
        <DataView<PagesTreeRow>
          source={pagesSource}
          overrides={overrides}
          extraFields={EXTRA_FIELDS}
          views={["table", "list"]}
          toolbar={SECTIONS}
          searchPlaceholder="Search pages…"
          creators={creators}
          selectedRowId={selectedId}
          rowActivation={(b) =>
            openPane.to(pageDetailPane, { pageId: b.id }, { mode: openMode })
          }
          hierarchy={{
            aliases: LINK_ALIASES,
            // No expand hooks — the sidebar chevron and the in-document sub-page
            // arrow are deliberately decoupled. This chevron is device-local view
            // state owned by the data-view primitive (per surface + view
            // instance); `page_blocks.expanded` stays genuine DOCUMENT content,
            // written only by the in-document arrow, which mounts the child
            // page's full content inline in its parent's body. Coupling them
            // meant a nav gesture embedded a child page in its parent's
            // document, stamped `updatedAt`, and fanned out `blocksChanged` (a
            // search reindex plus a history snapshot). Matches Notion, whose
            // sidebar arrow only reveals nav children.
            //
            // A sibling drop names only the TARGET: the server lands the page
            // among the target's PHYSICAL siblings (`moveBlock` reads the
            // target's raw `parentId`, which may be a content block inside the
            // display parent page) — the sidebar never holds, nor needs, the
            // physical forest. A child drop (`targetId: null`) parents directly
            // under the destination page block.
            onMove: (id, dest) => {
              void fetchEndpoint(
                moveBlock,
                { id },
                {
                  body:
                    dest.targetId === null
                      ? {
                          parentId: dest.parentId,
                          targetId: null,
                          zone: dest.zone,
                        }
                      : { targetId: dest.targetId, zone: dest.zone },
                },
              );
            },
            // Same for "Add page below": `afterId` places the new page right
            // after that page's BLOCK, wherever it physically sits (the server
            // reads its parent); without one, it is the display parent's child.
            onCreate: (args) =>
              createPageWithSeed(fetchEndpoint, {
                parentId: args.parentId,
                afterId: args.afterId,
              }),
          }}
          viewOptions={viewOptions}
          itemActions={PageTree.RowActions}
        />
      </div>
    </Scroll>
  );
}

/** Every `PageTree.RowMarker` contribution for one row, in one rigid cluster. */
function RowMarkers({ page }: { page: PagesTreeRow }) {
  return (
    <Inline gap="2xs" className={rigidClass()}>
      <PageTree.RowMarker.Render>
        {(item) => <item.component page={page} />}
      </PageTree.RowMarker.Render>
    </Inline>
  );
}
