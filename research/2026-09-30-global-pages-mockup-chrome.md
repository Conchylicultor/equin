# Pages app: sidebar sections, toolbar and title header from the mockup

## Context

The prototype `proto-1790691924-p8nh` (mocks `/pages/page/<id>`) redesigns the
Pages app. This plan covers its **sidebar, pane toolbar and title header**. The
annotation cards, the theme colours and page properties are out of scope.
Properties (Status / Tags / Parent) get their own plan.

Gap versus today:

- **Sidebar.**
  - Mockup: stacked, collapsible sections (**Favorites**, the page tree, and the temporary agent pages), each with a hover `+`. No view-switcher tabs. The footer has **New page** and **Trash**.
  - Today: `[Pages | Favorites | +]` tabs over one DataView (`pages-sidebar`), with the tree grouped by `origin` into Mine / Agent.
- **Toolbar.**
  - Mockup has an "Edited 2h ago" label and a labelled **Page ▾** kind pill whose options carry visible descriptions.
  - Mockup has a `⋯` menu. Today copy-id is a standalone button.
- **Title header.**
  - Mockup: a hover row (`Add cover`, `Change icon`), and **"Linked from N pages"** under the title, expanding in place. Each backlink row shows the source page's icon, title and parent path, plus a snippet with the link highlighted.
  - Today: backlinks are a "Linked from" card below the editor, with title and icon only.

Decisions taken with the user:

- The sidebar uses a new generic **DataView "sections" chrome** (option B), not hand-composed pinned mounts.
- The temporary agent-origin pages get their own section named **Scratch**, hidden when empty.
- Backlink snippets are in scope, including the server change.
- The kind menu shows visible descriptions.

---

## 1. DataView: `sections` surface chrome (primitive)

Today a surface picks one of two chromes in `DataViewSurfaceChrome`
(`data-view/core/internal/types.ts`, `core/internal/toolbar-arrangement.ts`):

- an **arrangement**: a band with a switcher showing one active instance;
- **hosted**: no band, and a frame places the parts.

Add a third arm:

```ts
toolbar: { kind: "sections"; forms?: { header: "eyebrow" | "group" } }
```

With this chrome the host renders **every authored view-instance**, stacked in
config order. Each one has its own collapsible header. There is no active
instance and no switcher.

### Types
- Add `SectionsToolbar` next to `HostedToolbar`, with an `isSectionsToolbar()` guard.
- As with the hosted arm, `title` / `actions` are `never` beside it.
- `pinnedView` is `never` in this arm, so the pinned prop moves into the chrome union. A pinned host has one instance by definition.
- `MergedDataViewProps` gets a union **without** the sections arm, so using it there is a type error.
  - Per-source mounting per section is a follow-up, only if a merged surface ever needs it.

### Shell
- `DataViewShellFrame` (`web/components/data-view.tsx`) currently hands its render-child one `activeInstance`.
- In sections mode it maps `readyModel.instances` to `<ViewSection instance>`. Each section renders the existing `DataViewBody` with that instance as its "active" one.
- `DataViewBody` and every controller in it (sort, filter, fold, server source, `CollectRowOrder`) are already keyed by view id through the id-parameterised `ReadyViewModel`. The body needs no change beyond receiving the instance.
- The model stays **one hook in the shell**. `useViewEphemeral` holds a single `useState` over the whole map, so a per-section hook would overwrite other sections' state.
- Hoist `CollectFieldExtensions` above the sections in this mode, so contributed fields mount once rather than once per section.

### Section header
- Built from the parts `GroupedSections` already composes: `CollapsibleProvider`, `StickyStack`/`StickyStackItem` and `SectionHeaderRow` (`css/row`). It carries `rowActionsAnchor` so its actions hover-reveal.
- Use the `eyebrow` variant for the sidebar look (small muted label, chevron on hover).
- The header's hover actions reuse existing view-core parts:
  - **`+`**: the surface's `creators`, compact form, filtered by a new `CreateOption.views?: string[]` (the instance ids it appears on; absent means every section). This is data, so the host still builds the part.
  - **`⋯`**: a `ControlPanelPopover` holding the section's controls and instance actions.
    - The controls are the compact fold's `CompactControls` / `HostedOptions`, under a `DataViewControlsProvider` for this instance.
    - The instance actions are `ViewSettingsPopover` (rename, type/options, duplicate, delete) and `AddViewMenuItems` ("Add section"), both exported by `data-view/plugins/view-core/web`. Both already take `instance` / `actions`, not the active id.
- Section reorder is config order. Drag-reordering sections is a follow-up.

### Collapse
- Stored per device in the existing ephemeral map.
- Extend each view's entry from `{expanded, collapsedSections}` to also hold `collapsed: boolean`. This is a view-level key, never mixed with group keys.

### Sticky offsets
- Section headers pin through a `StickyStack` based on `var(--dv-header-offset, 0px)`.
- Each section wrapper re-publishes `--dv-header-offset` as that base plus its own measured header height (`useElementSize`). Group headers inside a grouped section then pin under their section header.
- The shell's single `stickyRef` is unused in this mode.

### Hide when empty
- Add a new host-injected view key, `hideWhenEmpty?: boolean`, read through `viewFor` like `groupBy`.
- The host decides emptiness **before** mounting the body. It uses the same `useRowFilter` predicate the views use, applying the row scope below.
- While the rows' `readiness` is loading, the section is **not** rendered. "Not known yet" must never paint as an empty section; this follows the not-known-yet rule. It appears once the rows are ready and non-empty.

### `selectedRowId`
- Stays surface-level, so a starred page highlights in both Favorites and the tree. Notion behaves the same way.
- Document this in the data-view CLAUDE.md.

## 2. DataView tree: root-scoped filter

The Scratch section must reproduce today's `groupBy: "origin"` partition:

- each **root** belongs to a section;
- every descendant follows its root;
- no ancestors are pulled in.

The tree's filter keeps matches **plus their ancestor chain**
(`tree/web/components/tree-view.tsx` ~L356). So `origin is agent` would drag a
user parent into Scratch, and drop the user children of an agent root.

- Add a view key `filterScope?: "rows" | "roots"` (default `rows`), next to `filter` / `groupBy`.
- In the tree, `roots` evaluates the filter on projected roots only, then keeps every row whose root is kept. This reuses `projectedRoots` and `bucketRowsByRootSection` from `tree/web/internal/group-rows.ts`.
- Flat views ignore the key. Document it as tree-only.
- The emptiness check in §1 applies the same scope: "any root matches" versus "any row matches".
- Drag-and-drop is unaffected. Drops carry an anchor the server resolves against the full sibling set, and a root-scoped subtree is never split. The comment at `tree-view.tsx` ~L606 describes the same reasoning for grouping.

## 3. Pages sidebar

**Surface.** `pages-sidebar.tsx`:

- `toolbar={{ kind: "sections" }}`.
- Drop the `list` view's switcher assumptions.
- The `new-page` creator gets `views: ["pages"]`.

**Config.** `config/apps/pages/page-tree/pages-sidebar.jsonc` and its `.origin` twin:

```jsonc
"views": [
  { "id": "favorites", "name": "Favorites", "view": { "type": "list", "visibleFields": ["title"], "hideWhenEmpty": true, "filter": /* starred is true */ } },
  { "id": "pages",     "name": "Private",   "view": { "type": "tree", "visibleFields": ["title"], "filterScope": "roots", "filter": /* origin is user */ } },
  { "id": "scratch",   "name": "Scratch",   "view": { "type": "tree", "visibleFields": ["title"], "filterScope": "roots", "hideWhenEmpty": true, "filter": /* origin is agent */ } }
]
```

- Keep the id `pages` for the main section, so its saved row order (keyed by view id) survives the rename.
- Rewrite the file's comment block for the new model.

**Origin field.** `agent-origin/web/components/origin-field.tsx`:

- Relabel `Mine` / `Agent` to `Private` / `Scratch`.
- Update its comment: filter scope replaces grouping.
- Also update the plugin descriptions / CLAUDE.md that mention the "`[Agent]` section".

**Scratch hint.** The section's `⋯` panel shows "Pages created by agent runs — moved to trash after 24h".

- Needs a small `description` on the view row, rendered by the header as a tooltip. The data belongs to the config row, not code.

**Footer.**

- New `Pages.Sidebar` contribution `new-page`, in page-tree beside `trash`. It is a `component` item, because it needs `useOpenPane`. It calls `createPageWithSeed({ parentId: null })` and opens the page.
- `config/apps/pages/shell/sidebar.jsonc` order: `search`, `pages`, `new-page`, `trash`.
- The tree `Scroll fill` is the only growing item, so the last two sit at the bottom.

**Search.**

- Restyle only.
- No ⌘K: it belongs to the global command palette (`command-palette-root.tsx`). A Pages-scoped binding would conflict with it.

**Not code.** The chevron-over-icon disclosure (`ui/tree-disclosure`, default `merged`) and the `/` breadcrumb separator (`ui/breadcrumb-separator`, `slash`) are **global** user preferences. Both are set in the theme customizer, so nothing changes here.

## 4. Pane toolbar

**Edited label.**

- New `pageDetailPane.Actions` contribution `edited` in page-tree.
- It reads the page row from `pagesResource` (`updatedAt` is already on `PageRowSchema`) and renders `Edited <RelativeTime format="ago">` (`primitives/relative-time`) as muted text. It shows a loading state while pending, never a stand-in value.
- Check during implementation that a child-block edit bumps the page row's `updatedAt`. If it doesn't, read the latest `updatedAt` from the page's blocks instead.

**Kind pill.** `page-author/.../page-kind-control.tsx`:

- The trigger becomes a labelled ghost `Button`: kind icon, `look.label`, chevron. It keeps the per-kind tint.
- The loading placeholder is resized to match.

**Visible descriptions.** Add a `description` prop to `ControlPanel.Row` (`css/plugins/control-panel`): a muted second line that reserves its height.

- This is a separate prop from `hint`, which stays tooltip-only by contract (`control-panel.test.tsx` ~L710).
- The kind rows pass `KIND_LOOK[k].hint` as `description`.
- Add a test beside the existing `hint` tests.

**Overflow (config only).** `config/apps/pages/page-tree/page-detail.actions.jsonc`:

- items: `title`, spacer, `edited`, `page-author`, `star`, `history`, `{type:"overflow", id:"more", items:["apps.pages.copy-id:copy-id"]}`.

## 5. Title header

**New slots** in `page-tree/web/slots.ts`, so the header stops hardcoding its tools:

- **`PageDetail.HeaderTool`**: the hover row above the title. `render: ComponentType<{pageId}>`, and a contribution `useAvailable` gate, the same shape as `Section`.
  - Move `Add cover` and `Add icon` into contributions.
  - Add **`Change icon`**, shown when the page has an icon. It opens `PageIconPicker` with the same footer as today (`RegenerateIconAction`).
- **`PageDetail.UnderTitle`**: rows under the title.
  - Backlinks move here.
  - Properties will slot in later.

**Header layout.** `page-header.tsx`:

- icon
- `HeaderTool.Render` in the hover-reveal row
- title
- `UnderTitle.Render`

**Backlinks, inline.**

- Remove the `PageDetail.Section({id:"backlinks"})` card.
- Add an `UnderTitle` contribution, gated by the existing `useHasBacklinks`. It renders a ghost toggle, "Linked from N pages", with stacked icons (the first 3 backlink icons) and a chevron.
  - Expanded state is local to the component, per page.
- Clicking the toggle expands the existing `Backlinks` DataView (`page/links/web/components/backlinks.tsx`) in place. It stays a DataView `list`, with a custom row layout:
  - **Title line:** icon, title, parent path. The path is derived client-side with `pageAncestors` over `pagesResource`, so it needs no server change.
  - **Snippet line:** muted, with the linked text in `<mark>`.
  - Row activation keeps using `PageNavigationProvider`.

## 6. Backlink snippets (server, `page/links`)

`page_links` stores only `(source_page_id, target_page_id)`.

- **Table.** Add `source_block_id` to it (`server/internal/tables.ts`). The PK becomes `(source_page_id, target_page_id, source_block_id)`, with the target index kept. Migration through `./equin build` only.
- **Reindex.** `reindexPage` (`server/internal/reindex.ts`) already walks the source page's live blocks with the `PageLinks.Extractor` contributions. Record the block id of each extraction.
- **Backfill.** Existing rows have no block id. Add a one-shot boot backfill that reindexes every page, the same pattern as content-search's backfill, so the table is rebuilt.
- **Loader.** The `pageBacklinks` loader returns one row per **source page**: the first linking block in document order.
- **Schema.** `BacklinkRowSchema` gains `snippet: { before: string; match: string; after: string } | null`.
  - Built from the linking block's plain text, via the editor's text projection with inline tokens expanded to their referent titles (`expandInlineTokenReferents`, `text-editor/plugins/inline-chip`).
  - `match` is the target's title as it appears there, trimmed to about 80 characters around the match.
  - `null` when the whole block *is* the link (a page-link / sub-page block). Such a row shows only the title line.
- **Extractors.** The generic extractor API gains no knowledge of snippets. The snippet is derived from the block's text, whatever extractor matched it.

## Order of work

1. §2 tree root-scoped filter, with tests.
2. §1 sections chrome, with jsdom tests beside `pinned-view.test.tsx` / `grouped-sections.test.tsx`.
3. §3 sidebar.
4. §4 toolbar.
5. §5 header.
6. §6 snippets.

Each step leaves the app working.

## Critical files

- `plugins/primitives/plugins/data-view/core/internal/{types,toolbar-arrangement}.ts`
- `plugins/primitives/plugins/data-view/web/components/{data-view,data-view-body}.tsx`
- new `web/components/view-section.tsx`
- `web/internal/use-view-ephemeral.ts`
- `plugins/primitives/plugins/data-view/plugins/tree/web/components/tree-view.tsx`, `internal/group-rows.ts`
- `plugins/apps/plugins/pages/plugins/page-tree/web/{slots.ts,index.ts,components/pages-sidebar.tsx,components/page-header.tsx,components/backlinks-section.tsx}`
- `plugins/apps/plugins/pages/plugins/agent-origin/web/components/origin-field.tsx`
- `plugins/apps/plugins/pages/plugins/page-author/web/components/page-kind-control.tsx`
- `plugins/primitives/plugins/css/plugins/control-panel/` (Row `description`)
- `plugins/page/plugins/links/{core/schemas.ts,server/internal/{tables,reindex,resources}.ts,web/components/backlinks.tsx}`
- `config/apps/pages/page-tree/{pages-sidebar,page-detail.actions}.jsonc`, `config/apps/pages/shell/sidebar.jsonc`
- The data-view, tree and pages CLAUDE.md prose (sections chrome, `filterScope`, `hideWhenEmpty`)

## Verification

**Tests.**

- `./equin test plugins/primitives/plugins/data-view` covers:
  - sections render every instance;
  - collapse persists per view;
  - `hideWhenEmpty` hides a section and never paints it while loading;
  - `filterScope: "roots"` keeps whole subtrees and pulls in no ancestors;
  - a creator's `views` filter.
- `./equin test plugins/primitives/plugins/css/plugins/control-panel` covers the Row `description` line.
- `./equin test plugins/page/plugins/links` covers the snippet derivation (inline link, page-link block giving `null`, truncation).

**Build and inspect.**

- `./equin build`, then screenshot `/pages/page/block-acef974d-…` with `screenshot.ts --path … --color-scheme dark`.
- Compare against the mockup with `compare-diff.ts --name proto-1790691924-p8nh`, sidebar and header regions only.

**E2E.**

- Extend `page-tree/e2e/grouped-reorder.ts`, or add `sections-verify.ts`.
- An agent-origin page created by the e2e itself (it carries the agent header) must appear under **Scratch** and not under Private.
- Starring a page must make Favorites appear.
- The Scratch section must be absent once its pages are gone.

**Checks.** `./equin check` passes: `migrations-in-sync`, `plugins-doc-in-sync`, `config:overrides-authored` and `config-stable-list-ids`.
