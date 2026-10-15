# data-table

`DataTable` declares compact (`xs`) control density by default, so badges in cells and row-action buttons render at the smallest tier. Overridable via the `controlSize` prop.

## Row inset: the ambient rail

Every subgrid row — the column header, each data row, each `col-span-full` group
header — carries `py-row rail-follow`: block padding from the row density token
(`--pad-row-y`), inline padding from the ambient rail
(`var(--rail-start, var(--chrome-pad-x))`). There is no per-table opt-out, and
column alignment holds for the same reason the old fixed padding worked: every
row reads the *same* value.

The default resolves to `--chrome-pad-x` (0.75rem), so a table
in a plain pane looks unchanged. A table inside a host that opened a rail region
(any `detail-sections` card body, the app-shell sidebar) follows that host's rail
instead — which is the point: the table stops being the one band that ignores it.

`density="compact"` swaps `py-row` for `py-row-compact` (the `padRowCompactY`
density token) on every subgrid row — still one value for all rows, so
alignment holds.

## Column labels: header row or first group

`columnHeader` (default `"row"`) places the column labels. `"row"` is the sticky
header row. `"first-group"` (grouped mode only) renders no header row: the first
group's sticky band becomes a `grid-cols-subgrid` row (`data-slot=
"data-table-first-group-header"`) whose first cell holds the caller's header node
spanning the leading tracks up to the first column with a non-empty `header`,
followed by the remaining columns' label cells (sortable, same text style as the
header row) and the actions track's empty span. Group headers then pin at
`stickyHeaderOffset` rather than below a header row. It falls back to `"row"`
when ungrouped or when the first column is itself labelled. A column whose
`header` is absent or `""` is unlabelled: its header cell is empty.

## Per-row actions

`DataTableProps.rowActions?(row, index)` renders trailing per-row actions. The
grid template gains a trailing `auto` track (with an empty header span) and the
cluster renders into it through **`primitives/row-actions`**, which owns the
reveal, the guards and the sizing — each row carries `rowActionsAnchor`, the
cluster is `<RowActions pin={null} className="justify-end">`. Additive and inert
for consumers that don't pass `rowActions`.

`pin={null}` (in flow, not overlaid) is deliberate: a table column is genuine
flow, an overlaying cluster would cover the last column's data, and a
content-sized track is already a stable menu anchor. `rowActionsAnchor` bundles
`relative` — that is what the decoration overlay pins against, and it is inert on
undecorated rows (`z-index` stays `auto`).

`rowPersistentActions?(row, index)` is the twin cluster that stays painted **at
rest** (`alwaysVisible`), for an affordance important enough to be visible
without hovering. It shares the SAME trailing track, sitting immediately before
the revealed cluster — which is why, when both are present, the two are wrapped
in one flow child: a subgrid row has no implicit tracks, so a second direct child
would be clamped into the last track and paint on top of the first. The track is
reserved when either is present; with only `rowActions` the row is byte-identical
to before.

## Footer rows

`DataTableProps.footer` (ungrouped) and `DataTableGroup.footer` (per group,
hidden with the group's rows when `collapsed`) render one caller-owned
`col-span-full` row after the body — data-view's fold line lives there. A table
or group with a footer is content, so `emptyLabel` is not shown for it even when
it has no rows.

## Windowing

Above `DATA_TABLE_VIRTUALIZE_THRESHOLD` (100) rows the ungrouped body windows
through the shared `useVirtualRows`. Unlike `VirtualRows`, the slice renders in
**normal grid flow** — the outer grid owns the column tracks and every row is a
`grid-cols-subgrid` span, so absolutely positioning rows would break alignment.
Off-screen height is instead reserved by `col-span-full` spacers, **one per gap**
in the rendered index sequence (leading, trailing, and any interior hole). Grouped
mode (`groups`) is never windowed — it targets bounded, sectioned lists.
The windowed body's first commit draws the hook's `probe` row (one real row, measured before
paint) so the window never starts from the `ROW_ESTIMATE` guess: a table that
crosses the threshold while scrolled would otherwise shift its visible rows
by the guess's error.

The threshold is exported because a drag-reordering consumer must know whether the
body windows, to decide whether its `RankReorderProvider` needs `measuringAlways`.

## Fold motion

The body is one flat list of lines (`bodyLines`: each group's header, rows
and footer, or the plain rows), run through `virtual-rows/row-fold`'s
`useRowFold` with the grid as host — plain, grouped and windowed bodies alike.
A group's `collapsed` flip folds its rows in or out (the table tracks it in
its own open set, keyed by the header line); a host disclosure folds through
`openKeys` (the nested table's expanded ids, data-view's open fold lines).
Every line's outermost element carries `rowProps` — rows, full-span lines,
group headers, footers — so the lines below a fold slide with it.

## Presentation: grid or outline

`presentation` (default `"grid"`) is how the table looks. `grid` is the header
row, a hairline under every row (`border-b border-border/30`), a faint hover
tint and an accent fill on the selected row, and the wide-table behaviour
below. `outline` is a sidebar's look: no header row (nor first-group labels;
group headers pin at `stickyHeaderOffset`), no row rules, and each row is the
tree row's rounded pill — `hover:bg-accent` on a row that is not selected, and
the `--selected` tier on the selected one (`text-selected-foreground`,
publishing `--scrim` and `--row-meta` like `Row` / `TreeRowChrome`). Both looks
live in one `ROW_LOOK` table in `data-table.tsx`.

An outline row takes the tree row's geometry, so a nested outline table reads
as a `TreeList`: `min-h-tree-row`, `py-xs`, `text-body`, and the pill sits ON
the rail — the rail is the row's margin, its content padded `--space-xs` inside
the pill (`OUTLINE_INSET`; nested, only its trailing edge — the tree head pays
the lead inset inside its indent, as `TreeRowChrome` does), where a grid row
pays the rail as padding. Its
revealed action cluster overlays the row's trailing edge (`RowActions`' default
pin, masked by the row's `--scrim`) instead of reserving a track, as a tree
row's does — a sidebar's labels keep that width. A persistent cluster still
takes the track. A decoration may state a row's revealed actions itself
(`DataTableRowDecoration.actions`, in place of `rowActions(row)`); `null` mounts
no cluster on that row — a nested row with nothing to offer costs no hover
cluster (and no mount-time swap of one, which on a windowed list that remounts
rows read as a render loop).

**An outline with its labels** (`header: true`): the column-header row a file
listing wants over tree rows. It takes the outline rows' inset and a tree row's
height, in the muted caption the tree's aligned columns wore (an arrow only on
the sorted column), a breath under its rule; every column after the first reads
as meta (`text-caption text-row-meta`). Its columns give way by `dropOrder` in a
narrow box (`useColumnFit`'s `drop` mode) — it never scrolls sideways. Nested,
`tree.headerLeading` puts the first label over the rows' labels (a depth-0
row's lead inset and disclosure slot).

## Nesting rows (`tree`)

`DataTable` never builds a tree. A caller whose rows nest flattens them itself
(the tree primitive's `useTreeModel().flat`) and passes the visible lines as
`data` (or as each group's `rows`), plus `tree: DataTableTree`:

- **`leading(row, cell)`** wraps the first column's cell in the row's tree head
  (indent, guides, disclosure). Its result is the grid item.
- **`fullSpan(row)`** draws a line as ONE `col-span-full` band instead of cells
  (a lazy placeholder child) — no decoration hook, no actions, no checkbox;
  `null` → an ordinary row. Windowed, the band is still measured.
- **`pillIndent(row)`** — in `outline`, how far the row's pill starts past
  the rail (a CSS length: the tree's per-depth `--tree-pill-indent`, which the
  Pages theme sets). The row's own start margin carries it, so the fill steps
  in with the depth as a `TreeRowChrome`'s does; the `leading` head then pays
  only the content's share of its indent.
- **`containerRef` / `onKeyDown`** — the keyboard host (`useTreeKeyboard`), on
  the grid, which takes `role="treegrid"` (its cells `role="gridcell"`).

Under `tree` the table keeps `data` in the order given: `useDataTable`'s
`keepOrder` turns its own sort and filter off (the sort state still paints the
header arrows; sorting is the caller's, within sibling groups). Everything else
about a nested row — its drag source and droppables, its gestures, its
`data-tree-*` / ARIA attributes, its drop zones — arrives through
`useRowDecoration`, the seam a flat table's drag reorder uses; a decoration's
`props` are spread last, so they replace the row's own `onClick` / `tabIndex`
when the caller passes no `rowActivation`. Its `provide` wraps everything inside
the row (cells, action clusters, overlay) in a context of the caller's — the
nested table publishes the tree row's controls there. It must add no DOM.
Absent `tree`, nothing changes.

## Checkbox multi-select (`selection`)

`selection: { actions? }` turns on the `multi-select` primitive over the rows:
the table mounts a `MultiSelectProvider` (the range order is the painted rows'
keys — a collapsed group's and a full-span line's excluded), a `SelectionBar`
above the grid, and a `SelectionCheckbox` ahead of each row's first cell —
inside the tree head when the rows nest, after the disclosure. The checkbox
reveals on the row's `group/row-actions` hover and stops its own press from
reaching the row (no activation, no drag start).

## Wide tables: column fit, sideways scroll, sticky first column

A grid table goes **wide** only where something can scroll it sideways: inside
ui-kit's `SidewaysScroll` region (opened by a vertical `Scroll`, ended by every
`Surface` but `base` — a card, a well, a floating card — and by `OverlayPanel` —
popovers, menus, dialogs), AND with that `Scroll` the nearest ancestor clipping
it horizontally (a DOM walk in `useColumnFit`, for an ad-hoc clipping box).
Anywhere else — and in `outline` presentation (a sidebar) — it squeezes into
its box as it always did: no fit, no pinned column, no overflow. A context, not
the DOM walk alone, because a card draws a box without clipping (a table would
spill past its border), and because it crosses portals the right way.

- **Fit.** `useColumnFit` (`web/internal/use-column-fit.ts`) decides which
  columns show. A column whose `ColumnDef.dropOrder` is set gives way, lowest
  first, until the first column keeps its minimum — `fitAlignedColumns`
  (`core`, the tree's aligned-column fit, moved here unchanged and shared with
  `data-view/tree`). A column without one never drops; the first column never
  does. Minimums come from the track (`trackMin`, `core`): a length is itself,
  `minmax(a, b)` is `a`, a content- or space-sized track is its header label,
  measured once per column id while shown and kept while dropped (so the fit
  knows when it fits again). The room is the table's box, but never past the
  scroller's visible right edge, in the unscrolled frame. Nested (`tree`), the
  first column's floor is 160px, the tree's label floor.
- **Overflow.** The grid is `min-width: min-content`, every header label
  `nowrap` (so an `auto` track floors at its label; body cells are `min-w-0`
  truncation leaves), and a `minmax(0, …)` track is laid out floored at its
  measured label in px (`floorAtLabel` — not `min-content`, which for a
  truncating cell is its whole unwrapped text). So no column collapses below its
  label; past that the grid is wider than its box. Its box then carries `data-scrolls-x`, which turns
  the enclosing `Scroll` into the sideways scroller (and an inline-size
  container), and `Scroll`'s CSS keeps everything but the table in place: the
  boxes on the path to the table grow to it, and everything off that path (the
  DataView's toolbar band, a stats band above) pins `left: 0` at
  `max-width: 100cqi` — see `css/scroll`'s CLAUDE.md.
- **Sticky first column.** Column 0's header label and every row's first cell
  are `<Sticky edge="left" layer="base">` (below the `raised` header and group
  bands, above the other cells). The cell is opaque: `--chrome-mask` under a
  `linear-gradient` of the row's own tint. A grid row paints its tint through
  `--dt-row-tint` (`[background-color:var(--dt-row-tint)]`; hover, selected and
  a decoration's `highlighted` set it), never a `bg-*` class, so the pinned cell
  follows every row state. It reaches over the row's rail inset and the column
  gap (negative margin, paid back as padding) so nothing peeks past it.
- **Full-span bands** — group headers (`left: 0`), group and table footers, a
  tree's placeholder lines — pin their content to the left edge at
  `max-width: 100cqi`, so a label or a fold line stays readable however far the
  table scrolled.

Pinned by `data-view/plugins/table/e2e/sticky-scroll.ts` (Studio explorer
nested + Debug → Claude CLI Calls flat, 390 / 820 / 1440, light and dark).
Verified in Chromium only (the e2e harness drives Chromium).

## Windowing + drag reorder compose

`useRowDecoration` (the per-row hook seam that `data-view/table` uses to mount
`useRankReorderItem`) does **not** disable windowing. Two things make that work:

- **`keepMountedRowKeys`** — pass the active drag id while a drag is in flight.
  It reaches `useVirtualRows`' `keepMounted`, which forces the row's index into
  the rendered range. Without it, scrolling the source out of the window unmounts
  its draggable and dnd-kit cancels the drop. A pinned row is a non-contiguous
  index — hence the one-spacer-per-gap layout above, which renders it at its true
  offset (far off-screen, so it neither paints nor collides).
- **the composed row ref** — a windowed decorated row is simultaneously a drag
  source and a virtualizer measurement target, so `DataTableRow` merges the
  decoration ref and the measure ref into one callback ref.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Sortable/filterable flex-layout data table primitive.
- Web:
  - Uses: 24 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×4
    - `primitives/multi-select` ×3
    - `primitives/css/sticky/stack` ×2
    - `primitives/css/sticky` ×2
    - `primitives/dom/element-size` ×2
    - `primitives/row-actions` ×2
    - `primitives/virtual-rows/row-fold` ×2
    - `primitives/css/center.Center`
    - `primitives/css/scroll.useScrollsSideways`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/link-gesture.activationProps`
    - `primitives/virtual-rows.useVirtualRows`
    - `ui/icons.Icon`
  - Exports (types):
    - `ColumnDef`
    - `DataTableGroup`
    - `DataTablePresentation`
    - `DataTableProps`
    - `DataTableRowDecoration`
    - `DataTableSelection`
    - `DataTableTree`
    - `SortState`
  - Exports (values):
    - `DATA_TABLE_VIRTUALIZE_THRESHOLD`
    - `DataTable`
- Cross-plugin:
  - Imported by:
    - `apps/studio/contributions`
    - `apps/studio/contributions/tables/columns`
    - `apps/studio/contributions/tables/foreign-keys`
    - `apps/studio/contributions/tables/indexes`
    - `apps/studio/contributions/tables/sample-rows`
    - `debug/boot-profile`
    - `debug/heap-snapshot`
    - `debug/profiling/boot`
    - `primitives/data-view/table`
    - `primitives/metrics/chart-kit`
- Core:
  - Exports (types):
    - `FitColumn`
    - `TrackMin`
  - Exports (values):
    - `fitAlignedColumns`
    - `floorAtLabel`
    - `trackMin`

<!-- AUTOGENERATED:END -->
