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
  - Uses:
    - `primitives/css/center.Center`
    - `primitives/css/spacing.Stack`
    - `primitives/css/sticky.Sticky`
    - `primitives/css/sticky.stickyOffsetPx`
    - `primitives/css/sticky/stack.StickyStack`
    - `primitives/css/sticky/stack.StickyStackItem`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.ControlSizeProvider`
    - `primitives/css/ui-kit.SingleLineProvider`
    - `primitives/dom/element-size.useElementSize`
    - `primitives/link-gesture.activationProps`
    - `primitives/row-actions.RowActions`
    - `primitives/row-actions.rowActionsAnchor`
    - `primitives/virtual-rows.useVirtualRows`
    - `ui/icons.Icon`
  - Exports (types):
    - `ColumnDef`
    - `DataTableGroup`
    - `DataTableProps`
    - `DataTableRowDecoration`
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

<!-- AUTOGENERATED:END -->
