# page-tree

## Two arrows, deliberately decoupled

A sub-page has an expand arrow in two places, and they are **not** the same
switch:

- the **sidebar tree** chevron is device-local view state owned by the
  `data-view` primitive, keyed per `(surface, view-instance, row)`. It reveals
  nav children and writes nothing to the document;
- the **in-document** arrow on the sub-page row inside its parent's body writes
  `page_blocks.expanded`, which is genuine document content: expanding it mounts
  the child page's full content inline, live and editable, via the editor's
  composite block store.

Coupling them — which is what passing the sidebar's chevron through the page's
`expanded` column used to do — meant a nav gesture embedded a child page in its
parent's body, stamped the page's `updatedAt`, and fanned out `blocksChanged`
(a search reindex plus a debounced history snapshot). It also could not differ
between the sidebar's own view instances or across devices. Notion draws the
same line: its sidebar arrow reveals nav children, it does not embed the page.

Consequently the sidebar `hierarchy` supplies no expand hooks at all, and there
is no channel through which it could. See
`research/2026-07-29-global-delete-hierarchy-expand-hooks.md`.

The sidebar's one document write is the drag (`hierarchy.onMove` → `moveBlock`),
and the same rule binds it: a nav gesture may not embed a page in a body. Hence
`handle-move-block` folds a page arriving under a new parent and never opens a
page destination — stated there, since in-document cross-page drags share it.

## The page icon picker is an emoji picker

A page icon is an emoji (`PageDataSchema.icon`, see `page/editor`). The header's
`PageIconPicker` / `PageIconButton` (`web/components/page-icon-button.tsx`) wrap
`ui/icons/emoji`'s `<EmojiPicker>` in a `ControlPanelPopover`; picking commits
through the header's `PATCH` and closes. The footer holds **Remove** (when an
icon is set) and, above it, whatever `footerActions` renders — typed
`PageIconFooterActions = (ctx: { close }) => ReactNode`, each row a
`ControlPanel.Row`. That prop is the extension point for an action beside Remove
(the auto-icon plugin's Regenerate); the header passes it through.

## The title header is slots, not a hardcoded row

`PageHeader` paints the icon, then two contributed parts around the title:

- `PageDetail.HeaderTool` — the hover-revealed tool row above the title (Add
  cover, Add icon, Change icon);
- `PageDetail.UnderTitle` — rows under the title ("Linked from N pages", which
  expands in place into the backlinks list; properties later).

Both take `{ component, useAvailable? }`, the same gate `Section` takes: a tool
that would change nothing on this page (Add icon on a page that has one)
declares it unavailable rather than rendering `null`, so the header resolves
it before painting. Each part is handed `{ pageId, page }` — the header paints
parts only once the page row is known, so no part reads the pages list itself.
Writes go through `useSavePageData(page)` (`web/internal/use-save-page-data.ts`),
which spreads over the page's CURRENT data so two parts never clobber each
other's keys.

"Edited 2h ago" in the title bar is contributed by `apps/pages/history`, not
here: the label is the page's version-history entry point (click → the history
dialog), so it lives with the history UI. It reads the page row's `editedAt`
(`useLiveRow(pagesTree, pageId)`) — the newest `updatedAt` over the page row and
its content, served off the editor's `page_content_edited_at` rollup.

## One row-action registry, no `rowMenu`

Every trailing affordance on a sidebar row is a `PageTree.RowActions`
contribution — including "Add page below", which reaches the tree's positional
create through `useOptionalRowControls()` rather than the tree primitive's own
`viewOptions.tree.rowMenu`. Do not re-add `rowMenu` here: a second menu would
split the row's actions across two mechanisms, each growing its own `⋯`, and the
authored overflow bucket in `pages.tree.row-actions` could only ever govern one
of them.

`AddPageBelowAction` returns `null` when there are no row controls — Favorites is
a flat `list` view, so that is the normal non-tree case, not a failure.

## The sidebar is a sections DataView

`PagesSidebar` renders the `pages-sidebar` DataView with the `sections` chrome
(`toolbar={{ kind: "sections" }}`): every view instance authored in
`config/apps/pages/page-tree/pages-sidebar.jsonc` is on screen at once, stacked
under its own collapsible header — **Favorites** (a `list` of starred pages),
**Private** (the tree, `origin is user`), **Recent** (a `list` of the user's
pages edited in the past week, sorted on the `editedAt` field the sidebar
declares — the page's edit time over its row AND its content, the same field
the Welcome page's Recent pages and the header's "Edited" label read)
and **Scratch** (the tree, `origin is agent`). Private and Scratch split the
tree with `filterScope: "roots"`, so a subtree stays whole in one of them;
Favorites, Recent and Scratch are `hideWhenEmpty`.

The sidebar's fields are `pagesTree`'s, DERIVED (`collection={pagesTree}`):
its own `editedAt`, and every field an extension of a block exposes —
`starred` (starred's presence), `origin` (agent-origin's presence, `agent` |
`user`) and `tags` (page tags, its options the live vocabulary) — each served
by its plugin's `LiveColumns.Expose` and presented by its plugin's
`FieldPresentation`. The sidebar names none of them: its code is `overrides`
(starred and origin out of the full-text search) and `extraFields` (the title,
the one field it computes itself from the page payload, renamed in place).
There is no field-extension seam; a new per-page dimension is an exposure on a
`page_blocks` extension.
The main tree keeps the view id `pages` (its saved row order is keyed by it).
The one `new-page` creator names `views: ["pages"]`, so only Private's header
offers `+`. The sidebar's footer rows are separate `Pages.Sidebar` items —
**New page** (`NewPageItem`, here) and **Trash** — placed after the tree's
growing `Scroll` by `config/apps/pages/shell/sidebar.jsonc`.

## The tree has two hosts, and reads which one it is in

`PagesSidebar` is one component mounted in two kinds of place, and clicking a
page means something different in each:

- the **Pages app sidebar** is persistent chrome — it stays put whatever is
  open — so a page opens as a column BESIDE it (`push`);
- the **`pagesTreePane` column** (the tree opened next to a conversation in
  another app) is a navigable surface, so activating a row navigates THAT
  column to the page (`swap`), the way a file list moves its own column instead
  of growing a third one.

The tree derives which host it is in from its own position — `useCurrentPane()
=== pagesTreePane` — rather than being told through a context or a prop, so a
new host cannot forget to declare it and the two hosts cannot disagree.

The column that the page took over is put back by `BackToTreeButton`, at the
head of the page's title bar. It paints only where this surface shows no tree
of its own (not the Pages app, no tree column in the chain), asked of the live
route each render rather than remembered from how the page was opened.

## A block opened as a page

`blockDetailPane` (`block/:blockId`) shows ONE block of a page — a TODO card, a
heading with its nested lines, a toggle — as a page of its own:
`<BlockEditor pageId rootId={blockId}>`, editable, saving to the page that
holds it. No cover and no title header; the title bar is the page's breadcrumb
plus a trailing crumb for the block (its text, else its type's label from the
`Editor.Block` registry). An id that turns out to be a page renders the
ordinary page body.

Both panes go through one `PageSurface` (content scope + pane chrome +
`PageNavigationProvider` from one `usePagesNavigation`), so a reference clicked
inside a block view opens exactly as one clicked inside a page. Both declare
`openBlock`, which is what the block menu's **Open as page**
(`page/open-as-page`) calls.

**One resolver for a bare block id.** `useBlockTarget(id)` answers `pending` /
`missing` / `error` / `page` / `block` from one live row of `page/editor`'s
`blockLocations` (lookup-only, `page.block-locations:rows`: the block's type and
nearest page ancestor, for a page and a content block alike) — and
`useBlockTargetLink()` is the link to the matching pane (a
`LinkTarget`, so ⌘/middle-click opens it in a browser tab).
The transcript's `block-…` chip and the conversation Artifacts panel both use
it, so an id means the same thing wherever it is clicked.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Sidebar page-tree plus the page-detail pane (header, editor, sections slot) and the block-detail pane (one block of a page, opened as a page of its own) for the Pages app, with useBlockTarget — the one resolver of a bare block id to the pane that shows it.
- Web:
  - Slots:
    - `PageDetail.HeaderTool`
    - `PageDetail.UnderTitle`
    - `PageDetail.Section`
    - `PageDetail.Overlay`
    - `PageTree.RowActions`
    - `PageTree.RowMarker`
    - `pageDetailPane.Actions`
    - `blockDetailPane.Actions`
    - `pagesTreePane.Actions`
  - Slot contributors:
    - `PageDetail.HeaderTool` ← `apps.pages.page-tags`
    - `PageDetail.HeaderTool` ← `apps.pages.page-tree`
    - `PageDetail.UnderTitle` ← `apps.pages.page-tags`
    - `PageDetail.UnderTitle` ← `apps.pages.page-tree`
    - `PageDetail.Overlay` ← `apps.pages.page-outline`
    - `PageTree.RowActions` ← `apps.pages.page-tree`
    - `PageTree.RowActions` ← `apps.pages.starred`
    - `PageTree.RowMarker` ← `apps.pages.page-tags`
    - `pageDetailPane.Actions` ← `apps.pages.copy-id`
    - `pageDetailPane.Actions` ← `apps.pages.history`
    - `pageDetailPane.Actions` ← `apps.pages.page-author`
    - `pageDetailPane.Actions` ← `apps.pages.starred`
    - `pageDetailPane.Actions` ← `primitives.pane`
    - `blockDetailPane.Actions` ← `primitives.pane`
    - `pagesTreePane.Actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "block-detail"
    - `Pane.Register` "page-detail"
    - `Pane.Register` "pages-tree"
    - `Pages.Sidebar` "Pages" → `PagesSidebar`
    - `Pages.Sidebar` "New page" → `NewPageItem`
    - `PageDetail.HeaderTool` "add-icon" → `AddIconTool`
    - `PageDetail.HeaderTool` "change-icon" → `ChangeIconTool`
    - `PageDetail.HeaderTool` "add-cover" → `AddCoverTool`
    - `PageDetail.UnderTitle` "backlinks" → `BacklinksUnderTitle`
    - `PageTree.RowActions` "delete" → `DeletePageAction`
    - `PageTree.RowActions` "add-below" → `AddPageBelowAction`
  - Uses: 80 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/pane` ×9
    - `page/editor` ×7
    - `primitives/data-view` ×5
    - `primitives/css/ui-kit` ×4
    - `network/live` ×3
    - `page/page-reference` ×3
    - `primitives/live-state` ×3
    - `primitives/overlay/image-viewer` ×3
    - `apps/pages/shell` ×2
    - `infra/endpoints` ×2
    - `primitives/breadcrumb` ×2
    - `primitives/collapsible` ×2
    - `primitives/css/control-panel` ×2
    - `primitives/hover-reveal` ×2
    - `primitives/usage-rank` ×2
    - `apps/pages/auto-icon.RegenerateIconAction`
    - `infra/attachments.uploadAttachment`
    - `infra/trash.useUndoableTrash`
    - `page/links.Backlinks`
    - `primitives/app-shell.SidebarItem`
    - `primitives/css/center.Center`
    - `primitives/css/clip.Clip`
    - `primitives/css/grid.Grid`
    - `primitives/css/grow.growClass`
    - `primitives/css/inline.Inline`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/text.Text`
    - `primitives/css/yield.yieldClass`
    - `primitives/detail-sections.defineDetailSections`
    - `primitives/editable-field.useEditableField`
    - `primitives/icon-button.IconButton`
    - `primitives/loading.Loading`
    - `primitives/slot-render.defineRenderSlot`
    - `primitives/text-editor/paste-images.attachmentUrl`
    - `primitives/tree.useOptionalRowControls`
    - `primitives/undo-redo.useUndoRedo`
    - `shell/toast.showToast`
    - `ui/icons/emoji.EmojiPicker`
    - `ui/icons.Icon`
  - Exports (types):
    - `BlockTarget`
    - `PageHeaderPartProps`
    - `PageSeedBlock`
  - Exports (values):
    - `blockDetailPane`
    - `createPageWithSeed`
    - `PageDetail`
    - `pageDetailPane`
    - `pagesTreePane`
    - `PageTree`
    - `useBlockTarget`
    - `useBlockTargetLink`
    - `useBlockTargetTitle`
    - `useBlockTypeLabel`
- Core:
  - Uses: `primitives/pane.defineRoute`
  - Exports (values):
    - `blockDetailRoute`
    - `pageDetailRoute`
    - `pagesTreeRoute`
- Cross-plugin:
  - Uses tokens: 31 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/type-scale` ×12
    - `ui/tokens/density` ×9
    - `ui/tokens/color-palette` ×7
    - `ui/tokens/shape` ×3
  - Imported by:
    - `active-data/page-link`
    - `apps/agent-manager/pages-nav`
    - `apps/pages/content-search`
    - `apps/pages/copy-id`
    - `apps/pages/history`
    - `apps/pages/page-author`
    - `apps/pages/page-outline`
    - `apps/pages/page-tags`
    - `apps/pages/prompt-origin`
    - `apps/pages/starred`
    - `apps/pages/welcome/quick-create`
    - `apps/pages/welcome/recent-pages`
    - `conversations/conversation-view/artifacts/page`
    - `conversations/conversation-view/jsonl-viewer/tool-call/page-tools`
- Exemptions:
  - Exempts itself from: `endpoints/no-void-fetch-endpoint` — `web/components/pages-sidebar.tsx` (sanctioned)

<!-- AUTOGENERATED:END -->
