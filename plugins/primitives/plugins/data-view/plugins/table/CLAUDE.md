# table

Table view child for the `data-view` umbrella primitive.

## Purpose

Contributes `DataViewSlots.View("table")` — renders the data source as a sortable
column table by wrapping the `data-table` primitive. Maps each `FieldDef` to a
`ColumnDef` 1:1 (coercing `Date→ms`, `boolean→0/1` for sort) and delegates sort
to the host's per-view `ViewState` via the `data-table` controlled-sort props.

The host (`<DataView>`) already searches + sorts the rows it passes, so the table
runs with `filter={undefined}` and only reflects/forwards sort state.

`ViewState.sort` is a multi-level `SortRule[]`, but the `data-table` primitive is
single-sort. `mapPrimary(rules)` maps the **primary** rule of
`props.sortHeader.active` (the view's ACTIVE sort — `state.sort` is emptied under
a server-ordered source, whose rows arrive sorted) onto data-table's
single-column `SortState` indicator — so the header arrow shows on whichever
column is sorted first; secondary rules paint no header arrow (the sort popover
is the full multi-sort surface). A header click routes through
`props.setSort(columnId)` → the model's primary-rule cycle (asc → desc → drop the
primary, or promote a new column to primary asc), **preserving secondary rules** —
so a header click never wipes a multi-sort.

**A header sorts only on `props.sortHeader.sortable`** — the Sort control's
sortable fields, passed per column as `ColumnDef.sortable` (data-table's
additive flag; it defaults to "has a `value`" for its other consumers). A field
showing a value is not necessarily one its list can order by: under a live
source a derived or unsortable column's header would otherwise persist a rule
the source refuses, replacing the list with its error. The host's `setSort`
throws for a field outside the set. Pinned by `web/__tests__/header-sort.test.tsx`.

Flat, the table has no leading slot: a field declaring `FieldDef.leading` is an
ordinary column here (see `data-view/CLAUDE.md`, "Leading field"). Nested, it
has one (below).

`FieldDef.dropOrder` maps to `ColumnDef.dropOrder`: in a narrow pane the
numbered columns give way (lowest first) before the table scrolls sideways with
its first column pinned — `data-table`'s CLAUDE.md ("Wide tables"). Both the
flat and the nested table do this; `presentation: "outline"` does neither.

Surface options reach `DataTable` straight through: `viewOptions.table`
(`TableViewOptions.columnHeader`), `FieldDef.header` (mapped as
`header: f.header === false ? "" : (f.header ?? f.label)`), the surface's
`density`, and its `groupHeaders` (each group header is data-view's shared
`DataViewGroupHeader`). See `data-view/CLAUDE.md` ("Table view options").

**Paged.** A flat paged read's placeholders are drawn by the body around the
whole table (`data-view/CLAUDE.md`, "Paging"), so the ungrouped table honours
the paged-view contract with nothing of its own — pinned by
`web/__tests__/paged-conformance.test.tsx` (data-view's
`describePagedConformance`). **Grouped, a declared section's `before`
placeholders are not drawn:** its rows live in `DataTable`'s subgrid between
the group's header row and its `footer` row, and `DataTableGroup` has no
full-span row above the rows to hold them, so the table hands `SectionBody` an
empty band (`{null}`), which draws only `after`. A page released above a
grouped section's rows therefore just leaves, and the reader is held by the
body's anchoring (`KeepAnchorAcross`) alone — the `isPaged` behaviour, not the
height-keeping one. Drawing them needs a leading full-span row on
`DataTableGroup` (a `data-table` change).

## Nesting (a hierarchical source)

`TableView` is two components chosen by `props.hierarchy`: `FlatTableView`
(everything above, unchanged) and `NestedTableView`. The view is offered on every
source and nests only when the source has a `hierarchy`; it declares `nestsHierarchy: true`, which
tells the host to apply no fold and no flat manual order to it there (see
data-view's CLAUDE.md, "Hierarchy"). A tree is a table with no columns. Old saved
`type: "tree"` rows upgrade through the `tree-view-to-table` config migration
(data-view `shared/view-migrations.ts`).

**The pipeline** (`components/nested-table-view.tsx`): data-view's
`useHierarchyTree` (projection with aliases → the filter under its
`filterScope` → a stable global sort → group-by over the roots, every callback
alias-aware) feeds the tree primitive's
`useTreeModel`, whose `flat` — the visible lines in paint order — becomes
`DataTable`'s rows. `DataTable` never builds a tree; it draws the lines it is
given, in that order (its own sort and filter are off under `tree`). The table
bypasses `useDataViewSections`: no flat sort, no fold, no aggregate, no paging
(a hierarchy is never paged) and no flat `manualOrder` (the host withholds both,
`nestsHierarchy`) — a nested row's order is its rank, moved by the tree's own
drag.

- **Sort** applies within siblings (the stable global sort `buildTree`
  re-groups per parent). A header click is the flat table's
  (`mapPrimary` + `setSort`, secondary rules kept). Any sort suspends the drag.
- **Search** is the tree's subtree-preserving `filterTree` over the host's
  `searchAccessor` (else the primary field's text): every match keeps its
  ancestor chain, forced open.
- **Rows** are tree rows through `DataTable`'s seams, built from the tree
  primitive's pieces: `useRowDecoration` calls `useTreeRow` (drag source, the
  before / after / into droppables, reveal-on-select) and spreads
  `treeRowGestures` (select — a link click for a link row — open, click-opens),
  `data-tree-row` / `data-tree-id` / `aria-level` / `aria-expanded`, and draws
  `TreeDropZones` as the row overlay; `DataTable.tree.leading` wraps the first
  cell in the tree head (`treeRowIndentStyle` + `TreeLeading`: guides, the
  `Tree.Disclosure` slot when the row has an icon, else a chevron);
  `tree.fullSpan` draws a lazy listing's placeholder (`TreeChildPlaceholder`) as
  one full-span line; `useTreeKeyboard` runs on the grid (`role="treegrid"`),
  rows focusable exactly when the view has an open gesture.
- **The leading field** (`FieldDef.leading`) renders in the tree head's icon
  slot, ahead of `options.leadingIcon`, and is no column.
- **Row controls**: the decoration's `provide` wraps the whole row in the tree
  primitive's `RowControlsProvider`, so a cell or an item action reads
  `useOptionalRowControls()` inside a table row.
- **Trailing cluster**: the item actions (persistent zone in the reserved track,
  as flat), then the tree's own chrome through the tree primitive's
  `TreeRowActions`: fold / unfold
  the subtree, the `rowMenu` `⋯`, add a child (`hierarchy.onCreate`). An alias
  (reference) row has none, no drag, read-only cells and a link glyph; its
  `data-row-key` is left off (the real row marks it).
- **Around the rows**: the tree primitive's `TreeToolbar` above them
  (`expandAll`, `toolbarStart`) and `TreeRootAdd` below (`addLabel`; `null`
  hides it, absent → "Add" when the hierarchy can create; never under
  `rootId`); grouped, each group header carries `groupFoldAction` (fold /
  unfold that group's subtrees).
- **Group-by**: the roots partition, every descendant follows its root; each
  section's slice of the ONE flattened tree is a `DataTableGroup` (not
  windowed). One `RankReorderDndContext` spans every section, so a drop into
  another section is refused in `onDragEnd`.
- **Windowing**: ungrouped, above `DATA_TABLE_VIRTUALIZE_THRESHOLD` visible
  lines; the drag source and the selected row stay mounted
  (`keepMountedRowKeys`), the droppables re-measured every frame.
- **Options** (`TableViewOptions`, read only when nested): `defaultExpanded`,
  `guides`, `rootId`, `expandOnActivate`, `openOnActivate`, `leadingIcon`,
  `dragOverlay`, `trailing` (at rest, at the row's end),
  `rowAccent` (a wash in the row's overlay layer), `rowMenu`, `labelClassName`
  (on the first column's cell, after the host's `rowTone`), `addLabel`,
  `expandAll`, `toolbarStart`; `presentation` and `header` apply to both modes.
  Column labels over tree rows are an outline table with `header: true`
  (columns dropping by `dropOrder` — the file explorer).

**`presentation: "grid" | "outline"`** is `DataTable.presentation`: `grid` is
the header row and ruled rows; `outline` (a sidebar's look) drops the header and
the rules and draws each row as the tree row's pill (`bg-selected` /
`--selected-foreground` / `--row-meta`), at the tree row's geometry (see
`data-table`'s CLAUDE.md).

**The label** (the primary field) is the tree row's: data-view's
`EditableTreeLabel` (select-then-edit, a created row opening straight into its
editor, reading the row's published controls) when
the field writes back, else its read cell — classed by `rowTone` then
`labelClassName`. Every other column edits through `FieldCell`'s pencil.
`trailing` sits at rest at the row's end, after every column (where a tree
row puts it, after its chips), in the persistent track, clipped past 12rem so
one row's wide trailing cannot squeeze every row's label. The first column takes the slack
(`minmax(10rem, 1fr)` unless the field sets a width) and clips a deep row's
indent at its edge. Pinned by
`web/__tests__/nested-*.test.tsx` (filter scope, row keys, guides and
presentation, lazy children / open / keys / link rows, leading field, sort
within siblings and search keeping ancestors).

The view passes nothing for the row inset: `DataTable` rows follow the ambient
rail unconditionally, which is the same rail the rest of a DataView's bands read —
see `data-view/CLAUDE.md` ("The rail") and `data-table/CLAUDE.md`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Table view for data-view: maps the typed field schema to data-table columns with host-controlled sort, and nests its rows (a tree is a table with no columns) when the source has a hierarchy.
- Web:
  - Contributes: `DataViewSlots.View` "Table" → `TableView`
  - Uses: 58 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×26
    - `primitives/tree` ×17
    - `primitives/data-table` ×6
    - `primitives/rank-reorder` ×3
    - `primitives/css/badge.Badge`
    - `primitives/css/clip.Clip`
    - `primitives/css/inline.Inline`
    - `primitives/css/spacing.Stack`
    - `primitives/css/ui-kit.cn`
    - `ui/icons.Icon`
  - Exports (types): `TableViewOptions`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --ring`
    - `ui/tokens/density --chrome-pad-x`
    - `ui/tokens/density --tree-pill-indent`
    - `ui/tokens/density --tree-root-gap`
    - `ui/tokens/density --tree-row-gap`
    - `ui/tokens/shape --spacing`
- Core:
  - Exports (types): `TableViewOptions`

<!-- AUTOGENERATED:END -->
