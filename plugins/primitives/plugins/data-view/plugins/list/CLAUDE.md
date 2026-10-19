# list

The **list** view child of the `data-view` primitive. Contributes one
`DataViewSlots.View("list")` entry: a compact, single-row-per-item dense list
rendered through the shared `FieldDef` schema. Suited to narrow master columns
where the chunky gallery cards and the wide multi-column table don't fit.

## What it renders

Each item is one `Row` (the `row` primitive), so the active-row affordance,
hover-revealed trailing actions, and leading icon slot all come for free:

- **leading slot** — the schema's leading field (`FieldDef.leading`), then
  `options.leading?.(row)` → `Row`'s `icon` slot (icon / avatar / status-dot).
  The leading field is out of the title pick, the subtitle and the trailing
  cell. See the data-view CLAUDE.md ("Leading field").
- **selection** — `selected = rowKey(row) === selectedRowId` → `Row` maps it to
  `bg-accent` (the same highlight a tree row uses). Baked in from the start.
- **click** — `onRowActivate`.
- **item actions** — `<itemActions.Row row hasChildren />` in `Row`'s
  hover-revealed `actions` slot (matches gallery / table).

### Tree row chrome (`rowChrome: "tree"`)

`ListViewOptions.rowChrome: "tree"` draws every row through the tree
primitive's `TreeRowChrome` at depth 0 instead of `Row` — its height
(`treeRowH`), indent, icon box, hover, selected tier and action cluster. It is
for a flat list shown beside a tree of the same records (Pages' Favorites over
its page tree), so the two rows match by construction rather than by two
hand-tuned looks. A row in this chrome is one label line: the title — its
read rendering, never the click-to-edit cell, since the label is the row's
navigation target and the editor's affordance is taller than a tree row —
truncates and every other body field is a rigid inline cell after it (as a nested
table's outline row draws its secondary fields); `lines` does not apply. Manual order, windowing
and item actions work as in the default chrome. `labelClassName` (both
chromes) is the per-row title class, the nested table's option of the same name.

### Field-driven body

The row body maps the `FieldDef` schema (shared `pickPrimaryField` heuristic):

- **primary field** → the title (`Text variant="label"`, truncating).
- fields with **`align: "end"`** → an always-visible trailing region inside the
  row body, right of the title/subtitle and **before** the hover actions
  (`field.cell(row) ?? String(field.value(row))`). This is where a status badge
  lands.
- **remaining non-primary fields** → the muted subtitle (`Text
  variant="caption"`, truncating), joined with `·` — but see "Chips are not
  middot-ed" below: a term that renders as a chip is parted by spacing instead.
- **row tone** — `DataViewRenderProps.rowTone` tones the **title** in both row
  shapes, through the shared `rowToneClass`. The subtitle and the trailing cell
  are already muted, so the title carries the whole difference between an active
  row and an inactive one.

### Chips are not middot-ed

` · ` is punctuation between two pieces of text; two chips already carry their
own boundary. So the run draws ` · ` **only between two adjacent non-chip
terms**, and separates a chip from its neighbour by spacing alone. The title
seam follows the same rule, since on one line the title is just the run's first
term.

Which terms are chips comes from `useIsChipField()` — the same Cell registry
`resolveCell` consults, asked once per render (the schema is per-view, not
per-row). **This view names no field type**; `enum` and `tags` declare
`chip: true` on their own cell contributions. See the data-view CLAUDE.md
("An option carries its own presentation").

The spacing is a literal space **in the inline flow**, not a flex `gap`. The
whole run is inline content inside one truncating `<Text>` leaf — that is what
lets the subtitle ellipsize as a single leaf of the row's line — and a flex
container here would make each chip its own leaf and take the truncation with it.

### One line by default (`options.lines`)

`lines: 1` (the default) puts the title and the subtitle **on the row's own
line**:

```
[icon]  Title · subtitle · fields                      trailing   [actions]
```

`Row` composes `Line`, so the row body is already a `region-line` +
`SingleLineProvider` context — the title and the subtitle are sibling truncating
leaves in it (each `<Text>` ellipsizes without asking), an empty `<Fill>` absorbs
the slack, and the trailing cell is a rigid leaf in its own track. The `·` join
extends to the seam with the title, which on one line is just the run's first
term.

When the line is tight both leaves shrink at CSS's default factor, weighted by
content width, so the longer one yields more — and the `·`-joined metadata run
normally is the longer one. That is the intent (the title identifies the row),
reached without a shrink-priority primitive invented for one call site.

`lines: 2` restores the stacked shape — subtitle under title inside a `Stack`,
which resets the single-line context so each `<Text>` asks for its own
`truncate`, with the trailing cell pushed by `ml-auto`. Reach for it when the
subtitle is **prose**, where the second line is genuinely a second thought,
rather than a run of short values.

Either way this is the list analog of the gallery's "title + muted properties":
primary = title, others = subtitle, `align: "end"` floats to the trailing edge.

**Which fields appear (and their order)** follows the view's per-instance
`properties` (`resolveBodyFields` over the schema; **default `null` = the
schema's own default set** — every field in schema order except those declaring
`FieldDef.visible: false`) — the same Properties dimension every view honors. The
title/subtitle/trailing split is unchanged: the primary (picked via
`pickPrimaryField` over the *visible* subset) is the label, `align: "end"` fields
trail, and the remaining visible fields form the subtitle. Hiding or reordering
fields via the toolbar "Properties" pill reshapes the subtitle/trailing accordingly;
filter and sort still use the full schema. See the data-view CLAUDE.md "Per-view
visible fields (Properties)" section.

When `options.renderRow` is set it owns the whole body instead, but is still
wrapped in the selectable/clickable `Row`.

## Grouping

Under group-by the grouped branch renders through the shared **`<GroupedSections>`**
chrome, which owns the `rail-follow` header inset and the
pinned/stacking group header for every flat view. The policy lives in the data-view
parent, not here; see its CLAUDE.md ("Grouped sections: one pipeline, one chrome").

## Paged

A paged read's placeholders are the body's (`data-view/CLAUDE.md`, "Paging"):
stacked rows need nothing of the view but `data-row-key` on each row. Pinned by
`web/__tests__/paged-conformance.test.tsx` (data-view's
`describePagedConformance`: one placeholder exactly as tall as the released
rows, no scroll written on a release, a landing anchored).

## Windowing + manual order

`estimateSize` tracks both dimensions of the row's height — its `size` and its
`lines` — because a single-line row is roughly a caption-line shorter than the
stacked one; `VirtualRows` measures every mounted row anyway, so the estimate
only has to keep the sizer (and therefore the scrollbar) honest.

A section windows through `VirtualRows` once its entry count exceeds 100; below
that it renders as a plain `.map`. Both sit in the same `SectionBody` band with
the same vertical padding: a band whose padding followed the threshold made
every row on screen jump by it the moment a paged read grew past 100 rows
(`e2e/live-pages-scroll.ts` caught it as an 8 px move). That single
threshold is the *only* windowing decision — manual order does not bypass it.

When the host hands down a `manualOrder`, both branches wrap each row in
`ManualOrderRow` (a `useRankSortableItem` sortable row: the row itself follows the pointer and its section's rows slide), and the whole view
is hosted by one `RankReorderProvider` spanning every section. The provider is
mounted with `measuringAlways` whenever **any** section windows, and its
render-prop `activeId` is threaded into each section's `VirtualRows` as
`keepMounted` (and as `raisedKey`, lifting the dragged row's wrapper above its neighbours) — so the drag source survives scrolling out of its own window.
`VirtualRows` positions rows absolutely at their measured offsets, so a pinned
off-screen source is invisible and harmless.

A row whose `getRank` is `null` is non-orderable and renders plain, so
`useRankSortableItem` is never mounted for it — an element-type choice, not a
conditional hook.

## Options

`options` (= `viewOptions.list`) is a `ListViewOptions<TRow>`:

- `leading?(row)` — leading slot per row (icon / avatar / status-dot),
  rendered after the schema's leading field, if any.
- `renderRow?(row)` — full row-body override (escape hatch); still wrapped in
  the selectable `Row`.
- `lines?` — rows per item, `1 | 2` (default `1`, one line — see above).
- `size?` — row density, `"sm" | "md"`. Default follows the SURFACE's
  `DataViewProps.density`: `"sm"` when it declared itself compact, `"md"`
  otherwise. Setting it here pins a density whatever the surface asked for.

## Exports

- `ListViewOptions` — the typed options interface. Consumers pass a plain
  `viewOptions={{ list: { … } }}` literal (never import this view child),
  mirroring the gallery / table view children, which likewise ship only their
  options type.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: List view child for the data-view primitive: a compact single-row-per-item list (Row primitive) with field-driven label/subtitle/trailing, active-row highlight, and hover item actions.
- Web:
  - Contributes: `DataViewSlots.View` "List" → `ListView`
  - Uses: 52 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×32
    - `primitives/rank-reorder` ×3
    - `primitives/css/spacing` ×2
    - `primitives/collapsible.FoldMotion`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/clip.clipClasses`
    - `primitives/css/fill.Fill`
    - `primitives/css/inline.Inline`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.Row`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/link-gesture.activationProps`
    - `primitives/tree.TreeRowChrome`
    - `primitives/virtual-rows.VirtualRows`
  - Exports (types): `ListViewOptions`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --section-body-pad-top`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xl`
    - `ui/tokens/shape --radius`
- Core:
  - Exports (types): `ListViewOptions`

<!-- AUTOGENERATED:END -->
