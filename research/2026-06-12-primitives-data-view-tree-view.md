# data-view: tree as a third view child (unify hierarchy into data-view)

## Context

`data-view` (`plugins/primitives/plugins/data-view`) is the "Notion-like multi-view
data surface": one typed `FieldDef` schema rendered through swappable views
(gallery, table) with per-view search/sort/filter and localStorage persistence.
Today it only handles **flat** collections. Hierarchical surfaces (pages page-tree,
tasks tree tab, studio explorer, file-explorer, agents) instead live on a *separate*
primitive, `plugins/primitives/plugins/tree`, and get none of data-view's
schema/search/view-switching/persistence machinery.

A tree is just another way to view a typed collection. This plan makes **tree a
third view child** alongside gallery and table — selectable in the same switcher,
sharing the same `FieldDef` schema, search input, and ViewState persistence — by
adding a first-class **hierarchy** concept to the data source. The new tree view is
a thin **adapter** over the existing `tree` primitive (`buildTree`, `computeDrop`,
`TreeList`, `RowChrome`, `RenameInput`), not a reimplementation. The `tree` primitive
stays as the lower-level building block.

**Deliverable:** the data-view tree view + clean hierarchy API, proven by migrating
**pages page-tree** onto it. Two follow-ups (multi-select; cross-view per-item action
slot) are filed as separate tasks, not built here.

## Key decision: Option B — row processing is a view concern (no host branch)

Pre-processed flat rows **cannot** feed a tree: flat substring search drops ancestors
(subtrees orphan/flatten mid-search) and flat field-sort fights rank order (DnD
visual/rank mismatch). The host's `useDataViewRows` baked flat semantics into a
supposedly view-agnostic host — that is the leak.

Fix: **the host passes raw rows; each view applies the processing matching its own
semantics.** One source of rows (raw), no `if (hierarchical)` branch in the host, no
second row-shape. This is the genuine "tree is just another view" unification.

- Host (`DataView`) stops calling `useDataViewRows`. It passes **raw `rows` + `state`
  + `hierarchy`** to the active view and keeps owning shared chrome only (search
  *input* → `state.query`, view switcher, ViewState persistence).
- `useDataViewRows` is renamed/extracted to a **core-exported hook `useFlatRows`**.
  Gallery and table each call it in their first line (one-line change). The tree view
  ignores it and hands raw rows to `TreeList` (which already does subtree-preserving
  `filterTree` search + `buildTree` rank ordering internally).

## Hierarchy API (data-source level, not the per-view `options` channel)

Hierarchy accessors + mutations describe the **data source** (they gate which views
are available and carry write capabilities), so they live on `DataViewProps`, *not*
in the opaque per-view `options` (that channel is for presentation like gallery's
`renderCard`).

```ts
// data-view/core/internal/types.ts  (new)
import type { Rank } from "@plugins/primitives/plugins/rank/core";

export interface HierarchyConfig<TRow> {
  getParentId: (row: TRow) => string | null;
  getRank: (row: TRow) => Rank;
  /** Server-persisted expand state. Omit → tree manages expand locally in ViewState. */
  isExpanded?: (row: TRow) => boolean;
  onToggleExpanded?: (id: string, next: boolean) => void | Promise<void>;
  /** DnD reorder/reparent. Omit → read-only nav tree (no drag). */
  onMove?: (id: string, dest: { parentId: string | null; rank: Rank }) => void | Promise<void>;
  /** Inline rename of the primary field. Omit → read-only label. */
  onRename?: (id: string, next: string) => void | Promise<void>;
  /** Create child/sibling. Omit → no add buttons. */
  onCreate?: (args: { parentId: string | null; rank?: Rank }) => Promise<string | null | undefined>;
}
```

- `DataViewProps<TRow>` gains `hierarchy?: HierarchyConfig<TRow>`.
- `DataViewRenderProps<TRow>` gains `hierarchy?: HierarchyConfig<TRow>` (passed through).
- `DataViewContribution` gains `hierarchical?: boolean` — the tree view sets it. The
  host **drops `hierarchical` views when `hierarchy` is absent** (prevents a broken
  `views={["tree"]}` with no hierarchy).
- `FieldDef` gains `primary?: boolean` — the field rendered as the tree row label
  (fallback: first `text` field, else `fields[0]` — same heuristic as gallery's
  `pickTitleField`, extracted to a shared `pickPrimaryField`).

### Per-field cell rendering is shared, not reinvented

The tree row label renders the **primary field through the same `data-view.cell`
resolution** the table uses (`useResolveCell()` from the data-view web barrel), so a
field-type plugin's cell renderer renders identically as a table column and a tree
row label. The only tree-specific swap: when `hierarchy.onRename` is set and the
primary field is text, render `RenameInput` (bound to the field value) instead of the
read-only resolved cell. No bespoke tree renderer, no parallel slot.

### Expand state

- If `hierarchy.isExpanded`/`onToggleExpanded` are provided → server-persisted (pages,
  tasks, agents path; status quo).
- If omitted → the tree view synthesizes `expanded` from a local map persisted in
  **ViewState** (read-only nav trees get expand "for free"). Requires extending
  `ViewState` with `expanded?: Record<string, boolean>` and the handle with
  `setExpanded(viewId, id, next)` (`use-view-state.ts`).

### Per-item hover actions — deferred (stopgap maps to existing primitive surface)

Arbitrary contributed row actions (delete/host-added) are **out of scope** (follow-up
task 2). For the pages proof, the tree view exposes `renderItemActions?(row)` on its
typed `TreeViewOptions`, which maps **1:1 to `RowChrome`'s existing `actions` prop** —
not a new system, just surfacing a capability the tree primitive already has. Pages
passes its current `PageTree.RowActions.Render` node through unchanged → zero
regression. Task 2 later replaces this with a cross-view contribution slot that
resolves into the same `renderItemActions` path.

## The tree view child (the adapter)

New plugin `plugins/primitives/plugins/data-view/plugins/tree/`:

- `web/index.ts` — contributes `DataViewSlots.View({ id: "tree", title: "Tree",
  icon: MdAccountTree, order: 2, hierarchical: true, component: TreeView })`.
- `core/internal/types.ts` — `TreeViewOptions<TRow>` (`renderRow?`, `renderItemActions?`,
  `rowMenu?`, `dragOverlay?`) + a `treeOptions<TRow>(o)` helper returning `["tree", o]`
  (mirrors `galleryOptions`).
- `web/components/tree-view.tsx` — `TreeView(props: DataViewRenderProps<unknown>)`:
  1. Cast `rows`/`fields`/`options`/`hierarchy` at the boundary (documented cast site).
  2. **Project** each `TRow` → a `TreeItem`-satisfying row: `{ ...row, id: rowKey(row),
     parentId: getParentId(row), rank: getRank(row), expanded: isExpanded?.(row) ??
     localExpanded.get(id) ?? false }`. This projection is the adapter's core job.
  3. Render `<TreeList>` from `@plugins/primitives/plugins/tree/web` with:
     - `rows` = projected rows; `selectedId` derived from `onRowActivate`/host (see note);
     - `onSelect` → `onRowActivate(originalRow)`;
     - `onToggleExpanded` → `hierarchy.onToggleExpanded ?? setExpanded(local)`;
     - `onMove` → `hierarchy.onMove` (drag disabled when no `onMove`, or when a field
       sort is active — rank order only);
     - `onCreate` → `hierarchy.onCreate`;
     - `Row` = a default row that renders `<RowChrome>` with the primary field's
       resolved cell (or `RenameInput` when `onRename`), `actions={renderItemActions?.(row)}`,
       `menu={rowMenu?.(...)}` — or fully replaced by `options.renderRow`;
     - `toolbar={{ search: { accessor: primaryAccessor, query: state.query, hideInput: true } }}`
       (see tree-primitive change below) so the host search box drives the tree's
       existing tree-aware `filterTree`;
     - `addLabel` from options (null hides root add).

**Imports:** `@plugins/primitives/plugins/tree/{web,core}`,
`@plugins/primitives/plugins/rank/core`, and the data-view web barrel
(`DataViewSlots`, `useResolveCell`, types). No cycle: `tree` does not import
`data-view`. Legal cross-plugin barrels only.

## Small change to the `tree` primitive (backward-compatible)

`TreeList.toolbar.search` currently owns its *own* `SearchInput` + internal
`searchQuery` state. To let the data-view host toolbar drive it, extend the option:

```ts
search?: {
  accessor: (row: T) => string;
  query?: string;       // controlled value; when set, use it instead of internal state
  hideInput?: boolean;  // hide TreeList's own SearchInput (host renders one)
};
```

`tree-list.tsx`: when `query` is provided, use it for `afterSearch` and skip the
internal `useState`/`SearchInput` render. Existing consumers (pages today, agents,
tasks) pass only `accessor` → unchanged behavior.

## Files

**Edit (data-view core/host/views):**
- `data-view/core/internal/types.ts` — add `HierarchyConfig`, `hierarchy` on
  `DataViewProps`/`DataViewRenderProps`, `hierarchical` on `DataViewContribution`,
  `primary` on `FieldDef`, `expanded` on `ViewState`.
- `data-view/web/index.ts` + `core/index.ts` — export `HierarchyConfig`,
  `useFlatRows`, `pickPrimaryField`.
- `data-view/web/internal/use-data-view-rows.ts` → export as `useFlatRows` (logic
  unchanged).
- `data-view/web/internal/use-view-state.ts` — add `expanded` map + `setExpanded`.
- `data-view/web/components/data-view.tsx` — stop pre-processing; pass raw `rows` +
  `hierarchy` in `renderProps`; drop `hierarchical` views when `!hierarchy`.
- `data-view/plugins/gallery/web/components/gallery-view.tsx` — first line:
  `const rows = useFlatRows(props.rows, props.fields, props.state, useResolveFilter(), searchAccessor?)`.
  (searchAccessor must also be threaded through renderProps.)
- `data-view/plugins/table/web/components/table-view.tsx` — same one-line `useFlatRows`.

**New (tree view child):**
- `data-view/plugins/tree/{web/index.ts, web/components/tree-view.tsx, core/index.ts,
  core/internal/types.ts, package.json, CLAUDE.md}`.

**Edit (tree primitive):**
- `tree/web/internal/tree-list.tsx` — controlled `query` + `hideInput` on
  `toolbar.search`.

**Edit (pages migration — the proof):**
- `apps/pages/plugins/page-tree/web/components/pages-sidebar.tsx` — replace the direct
  `<TreeList>` with `<DataView views={["tree"]} hierarchy={{…}} …>`; pass the existing
  `PageTree.RowActions.Render` node via `treeOptions({ renderItemActions, rowMenu })`.
  `Block` already satisfies the accessors natively (`parentId`/`rank`/`expanded`).

**Threading note:** `searchAccessor` currently only reaches `useDataViewRows` inside
the host. Under Option B it must be added to `DataViewRenderProps` so gallery/table can
pass it into their own `useFlatRows` call.

## Follow-up tasks (filed via `add_task`, not built here)

1. **Restore multi-select** in the data-view tree (checkbox selection + `SelectionBar`
   + ordered-id derivation via `buildTree`) and migrate **tasks** + **agents** off
   their bespoke `TreeList` usage onto the unified tree view (tasks needs `folderId↔parentId`
   mapping, `hideTerminal`, `rootId` subtree scope).
2. **Cross-view per-item action contribution slot** at the `DataView` level: plugins
   contribute item actions once; every view renders them in its natural affordance
   (tree-row hover, table-row trailing hover, gallery-card hover). Subsumes pages'
   `PageTree.RowActions`, tasks/agents row actions, and host-added extras; replaces the
   v1 `renderItemActions` stopgap.

(Studio explorer, file-explorer, config-settings nav are read-only pre-built nested
trees — not flat `parentId`/`rank` rows — so they migrate only opportunistically and
are not part of these tasks.)

## Verification

1. `./equin build` from the worktree; confirm clean start and
   `./equin check` passes (boundaries, migrations, eslint, plugins-doc-in-sync).
2. Open `http://att-1781116467-1uup.localhost:9000/pages` and exercise the migrated
   sidebar with `e2e/screenshot.mjs` (scripted, before/after):
   - tree renders nested pages; chevron expand/collapse persists (server round-trip);
   - drag a page onto/before/after another → reparent/reorder lands (`moveBlock`);
   - inline rename commits (`updateBlock`);
   - the host search box filters tree-aware (ancestors of matches retained);
   - "New Page" / "Add sub-page" create + open + focus the new row;
   - the per-row **delete** action still appears on hover and works
     (`PageTree.RowActions` via `renderItemActions`);
   - clicking a row opens the page-detail pane.
3. Confirm gallery + table still work unchanged on an existing consumer
   (e.g. `apps/home/app-cards` or `apps/story/shell`) — search/sort/switch intact
   after the `useFlatRows` extraction.
4. Verify the switcher only shows "Tree" when `hierarchy` is supplied.
