# Unified tree-table: one hierarchical `table` view, `tree` view deleted

Prototype: `proto-1791879276-g9ical` (Tree table). Variants: `columns: all | name-only`, `disclosure`, `guides`, `density`.

## Context

In Notion, the tree view is a table whose rows expand. In this repo, tree and table are two separate DataView renderers built on the same `FieldDef` schema:

- **`table`** (`data-view/plugins/table` → `primitives/data-table`) is a CSS grid with subgrid rows, a sticky header, a sort header, group headers, row-action tracks and windowing. It is **flat only**.
- **`tree`** (`data-view/plugins/tree` → `primitives/tree` `TreeList`) has hierarchy, keyboard navigation, drag-to-reparent, multi-select, lazy children and alias rows. Its `columns: "aligned"` mode is half a tree-table. It is a flex row with px-only widths, used only by the file explorer.

Every consequence of this split showed up in the audit:

- Studio's explorer offers both views, and its table silently drops the nesting.
- The hierarchical surfaces with many fields (running agents, tasks) cannot show columns properly.
- Keyboard, drag-and-drop, selection, virtualization and the sort model are each implemented twice and have diverged.

**Decision (user).** There will be one `table` type. It nests whenever the source has a `hierarchy`. A tree is a table with no columns. The `tree` type is deleted, and sidebars keep today's look through `presentation: "outline"`. The only Notion extra in v1 is a **sticky leading column with horizontal scroll**. Parent roll-ups, column resize and flat-table arrow-key navigation are follow-ups.

## Design

### 1. Shared tree logic in `primitives/tree`, renderer-free

`TreeList` is used only by the data-view tree view, so its logic can move out freely.

- **`tree/core` (pure).**
  - `flattenVisible(tree, placeholderOf)` → `{id, depth, node, hasChildren, expanded, kind: "node" | "placeholder"}[]`. Today this is an inline DFS at `tree-list.tsx:287`.
  - `orderedIds`, from the same list.
  - `treeKeyMove`, moved from `use-tree-keyboard.ts`.
- **`tree/web` `useTreeModel(...)` (hook, no DOM, no windowing).** It takes everything from `tree-list.tsx:214-452`:
  - the pipeline: `filterSubtree(rootId)` → `buildTree` → search `filterTree` (keeps ancestors);
  - the expand helpers: `useSubtreeExpandIndex`, `useFlatExpandAll`, `useLazyLoadRequests`;
  - the reveal-on-select effect and the rename `pendingFocus`;
  - `onDragEnd`: the `isDescendant` guard, `resolveDropParent`, auto-expanding the target, then `onMove`.

  It returns `{flat, orderedIds, ctx (TreeListContext value), onDragEnd, dragChip}`.
- **Row pieces, extracted from `tree-row-chrome.tsx:172-357` and `row-chrome.tsx`:**
  - `TreeLeadingCell` holds the indent (`treeContentIndent`), `TreeGuides`, the `Tree.Disclosure` slot dispatch (so every `ui/tree-disclosure` variant works), the checkbox and `children` (the label).
  - `TreeDropZones` holds the before/after `Pin` strips and the child droppable (`row-chrome.tsx:272-297`).
  - `useTreeRowHandlers` holds click, double-click, Enter, link gestures, `expandOnActivate` and `openOnActivate` (`tree-row-chrome.tsx:209-262`).
- `TreeRowChrome` and `RowChrome` stay as thin compositions of these pieces. `list-view.tsx`, `agents-list.tsx` and the pages `add-page-below-action` (`useOptionalRowControls`) keep importing them unchanged.

**Dependency:** `data-table` → `primitives/tree` (barrel). This is acyclic, since `tree` imports nothing that reaches `data-table`. Confirm it with `check plugin-boundaries`.

### 2. `DataTable` renders a flattened tree

`DataTable` never builds a tree. The table view composes the model and passes in the already-flattened visible rows plus a thin prop:

```ts
tree?: {
  depthOf(row): number;
  renderLeading(row, cell: ReactNode): ReactNode;   // wraps column 0 in TreeLeadingCell
  rowProps(row): { "data-tree-row"; "data-tree-id"; "aria-level"; "aria-expanded"? };
}
presentation?: "grid" | "outline";                  // default "grid"
selection?: { ids: ReadonlySet<string>; toggle(id, mode) };  // checkbox multi-select
```

- **Row box.** `DataTableRow` (`data-table.tsx:302`) is already a real `relative` box, so the following mount on it:
  - `TreeDropZones`, through the existing `useRowDecoration` seam, which table-view already uses for `useRankSortableItem`;
  - the pill and `rowAccent` styling, through the row-class seam.
- **Trailing cluster.** The subtree fold, the `⋯` row menu and the `+` add map onto the existing `rowActions` / `rowPersistentActions` tracks.
- **Keyboard.** In tree mode the grid gets `role="treegrid"`, rows get the `data-tree-*` attributes, and `useTreeKeyboard` runs over `orderedIds`. Flat tables are unchanged in v1.
- **Virtualization.** `flat` goes straight into `VirtualTableBody` (`:498`), which already windows in normal grid flow with spacer rows. Three things stay mounted through `keepMountedRowKeys`: the drag-active id, the focused row and the reveal target.
- **Grouped + hierarchical.** Roots are partitioned per group (`group-rows.ts`, moved over), and each group gets its own flat list as a `DataTableGroup`. Groups are not windowed, which matches today's one-TreeList-per-section. There is still no drag across sections.
- **Lazy placeholder rows.** A lazy placeholder (loading / retry) is a `flat` entry with `kind: "placeholder"`, rendered as a full-span row.
- **Alias rows.** An alias row is an ordinary row flagged read-only, with no rename, actions or drag.

### 3. `presentation: "grid" | "outline"`

| | grid | outline (old tree look, sidebars) |
|---|---|---|
| Header | yes (`columnHeader` as today) | none |
| Row borders | `border-b` (now conditional, currently hardcoded) | none |
| Hover / selected | today's table | rounded pill (`RowChrome` look) |
| Secondary fields | labelled columns | unlabelled trailing cells |

Sidebar density uses the existing `density="compact"` plus the rail inset. No new concept is needed.

### 4. Sticky leading column and dropOrder

- **Sticky column.** Column 0 cells (header, group header, rows) get `position: sticky; left: 0`, an opaque background that follows the row state (hover and selected composed over `bg-background`) and a raised z-index. The grid is `min-w-max w-full`, and the pane is the horizontal scroller. **First step of the phase:** verify that sticky works on subgrid children in Chromium and WebKit with a throwaway e2e screenshot. If it doesn't, the fallback is that only the header is sticky.
- **dropOrder.** Columns still drop by `FieldDef.dropOrder` when the pane narrows, so horizontal scroll is the last resort. The algorithm is reused unchanged (`aligned-fit.ts` `fitAlignedColumns` and its tests). Its inputs change:
  - The budget is the measured container width minus the leading column's minimum width.
  - Each column's minimum is **derived from its grid track**: a length counts as itself, and `minmax(a, b)` counts as `a`.
  - `auto` / `fr` tracks are measured once, while every column is shown, and cached per field. A dropped column has no cell left to measure, so measurement alone can't decide when it fits again.
  - This removes the tree's px/rem-only restriction (`alignedColumnWidth` currently throws on anything else and falls back to 6rem).

### 5. Table-view pipeline when `props.hierarchy` is set

The pipeline runs `projectRows` (moved from the tree plugin, with alias expansion) → `useRowFilter` + `scopeFilterRows` (`filterScope: rows | roots`) → stable global sort → `useTreeModel` → `flat`.

- **Sort.** A stable global sort before `buildTree` is exactly a sort within each sibling group, as in the prototype. This path bypasses the flat sort, fold and paging in `useDataViewSections`, and takes only its search, filter and groupBy outputs. The meta for fold stays unsupported in hierarchy mode.
- **Header-click sort.** This keeps `mapPrimary(rules[0])`, and secondary rules are preserved.
- **Drag-and-drop.**
  - With no sort and manual order, it is rank DnD with before/after/child zones, through `RankReorderDndContext` + `onDragEnd` from the model.
  - Any sort suspends DnD, as the tree does today.
- **View meta.** The unified table does **not** declare `hierarchical: true` (`view-core/web/internal/resolve-instances.ts:48`). It stays available on flat sources and nests only when a hierarchy is present.

### 6. Option parity and migration

- **Options into `TableViewOptions`.** These move over, active only with a hierarchy: `leadingIcon`, `trailing`, `rowAccent`, `rowMenu`, `dragOverlay`, `addLabel`, `rootId`, `expandAll`, `defaultExpanded`, `toolbarStart`, `labelClassName`, `guides`, `expandOnActivate`, `openOnActivate`, plus `presentation`.
- **`columns: "chips" | "aligned"` is deleted.**
  - `aligned` is now `presentation: "grid"`. The file explorer keeps its header.
  - `chips` is now `outline`'s trailing cells.
- **Stored config.** Add `migrations: [...]` to the shared `viewsDescriptor` (`view-core/shared/internal/views-descriptor.ts:~64`). Add one `defineConfigMigration({ id: "tree-view-to-table" })` that rewrites `view.type: "tree"` → `{type: "table", presentation: "outline"}`. It must be idempotent. In the same diff, hand-edit the 9 committed `config/**/*.jsonc` rows.
- **Code.** Each consumer's `viewOptions={{ tree: … }}` key becomes `table`, and `views={[…"tree"…]}` drops `tree`.

## Phases

Each phase builds, passes checks and leaves the app working.

- **P0 (extract the model).** Add `flattenVisible` / `orderedIds` / `treeKeyMove` to `tree/core` and `useTreeModel` to `tree/web`. `TreeList` becomes model plus markup. Port `use-flat-expand-all`, `use-subtree-expand-index` and `use-tree-keyboard` tests. No visible change.
- **P1 (extract the row pieces).** Add `TreeLeadingCell`, `TreeDropZones` and `useTreeRowHandlers`, and recompose `TreeRowChrome` / `RowChrome` from them. No visible change.
- **P2 (hierarchical table).**
  - Add the `tree`, `presentation` and `selection` props to `DataTable`, and the hierarchy pipeline to table-view (§5).
  - The `tree` type still exists. Studio explorer's table view becomes nested immediately, which is the first live consumer.
  - Port `data-view/plugins/tree/web/__tests__/*` (filter-scope, guides-selection, lazy-open, leading-field, row-key) to table-view. Keep the table's existing tests (header-sort, inline-edit, leading-field, table-options) green.
- **P3 (sticky column and fit).** Add the sticky leading column, horizontal scroll and the track-derived dropOrder fit (§4). Run screenshots in light and dark mode at 390 / 820 / 1440 widths.
- **P4 (migrate consumers, lowest risk first).** Order:
  1. running-agents band
  2. task-deps-tree
  3. config_v2 config-nav
  4. agents-list
  5. file-explorer file-tree
  6. tasks task-list
  7. Studio explorer (drop `tree` from `views`)
  8. pages sidebar (DnD + grouped)

  The config migration and the jsonc edits land with the first consumer whose config row says `tree`.
- **P5 (delete).**
  - Delete the `data-view/plugins/tree` plugin (`tree-view.tsx`, `aligned-columns.tsx`, the label editor moves to the table if it's still needed, plus its tests, e2e and docs).
  - Delete `tree-list.tsx` and its windowing branch.
  - Delete the `columns` option.
  - Keep `TreeRowChrome`, `RowChrome`, the disclosure variants and `useOptionalRowControls`.
  - Update `view-core` `resolve-instances.test.ts` (a `type: "tree"` fixture) and `view-core/e2e/view-type-gate.ts`, since the hierarchical gate no longer has a tree type to hide.

## Critical files

- `plugins/primitives/plugins/tree/web/internal/tree-list.tsx`, `tree-row-chrome.tsx`, `row-chrome.tsx`, `use-tree-row.tsx`, `use-tree-keyboard.ts`
- `plugins/primitives/plugins/data-table/web/internal/data-table.tsx`, `types.ts`
- `plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx`, `table/core/internal/types.ts`
- `plugins/primitives/plugins/data-view/plugins/tree/web/components/tree-view.tsx`, `aligned-columns.tsx`, `internal/{project-rows,group-rows,aligned-fit}.ts` (sources to move, then delete)
- `plugins/primitives/plugins/data-view/plugins/view-core/shared/internal/views-descriptor.ts` (migrations)
- Consumers: `tasks/plugins/task-list/web/internal/tasks-data-view.tsx`, `apps/plugins/studio/plugins/explorer/web/components/plugin-tree.tsx`, `apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx`, `apps/plugins/file-explorer/plugins/browser/web/components/file-tree.tsx`, `config_v2/plugins/settings/web/components/config-nav.tsx`, `conversations/plugins/agents/web/components/agents-list.tsx`, `conversations/plugins/conversation-view/plugins/running-agents/web/components/running-agents-band.tsx`, `tasks/plugins/task-deps-tree/web/*`

## Verification

- **Each phase:** `./singularity build` (checks include `type-check`, `plugin-boundaries`, `boundary-rules`, `plugins-doc-in-sync`) and `./singularity test plugins/primitives/plugins/{tree,data-table,data-view}`.
- **Behavior e2e** (port, then run against the build):
  - `tree/e2e/subtree-fold.ts`
  - `data-view/plugins/tree/e2e/group-fold.ts` → table
  - `apps/plugins/pages/plugins/page-tree/e2e/grouped-reorder.ts` (drag-reparent in the sidebar)
  - a new table e2e covering expand/collapse, ←/→ keys, search-keeps-ancestors and sort-within-siblings
- **Visual:** `screenshot.ts` on Studio explorer, tasks, the pages sidebar (outline must look unchanged) and the file explorer, in light and dark mode at 390 / 1440 widths. Use `compare-diff.ts` against the prototype for the grid look.
- **Migration:** run `./singularity build` on a worktree whose config has `type: "tree"` rows, and check that the rows are rewritten once and that re-running is a no-op.

## Follow-ups (not v1)

- Parent roll-ups (a `FieldDef` aggregate over descendants, like the prototype's Progress column)
- Column resize, persisted per view
- Arrow-key navigation on flat tables
- Windowing inside groups
