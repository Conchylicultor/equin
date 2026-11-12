# list

The **list** view child of the `data-view` primitive. Contributes one
`DataViewSlots.View("list")` entry: a compact, single-row-per-item dense list
rendered through the shared `FieldDef` schema. Suited to narrow master columns
where the chunky gallery cards and the wide multi-column table don't fit.

## What it renders

Each item is one `Row` (the `row` primitive), so the active-row affordance,
hover-revealed trailing actions, and leading icon slot all come for free:

- **leading slot** — the field placed in `lead` (data-view CLAUDE.md,
  "Placement"), drawn as a glyph → `Row`'s `icon` slot (a state's option
  glyph, an avatar, a log's time). None → the row's **cover thumbnail**
  (below).
- **selection** — `selected = rowKey(row) === selectedRowId` → `Row` maps it to
  `bg-accent` (the same highlight a tree row uses). Baked in from the start.
- **click** — `onRowActivate`.
- **hover** — pointer enter/leave reports the row to `rowHover`, and the row
  it holds (read per row, `useIsHovered` in `ListEntry`, so a hover
  re-renders two rows, never the list) keeps `Row`'s own hover paint
  (`bg-hover-fill`) while another surface hovers it (its map pin). The default row chrome only.
- **item actions** — `useItemActionZones(itemActions, { hasPersistentSlot:
  false, hasPrimarySlot: <has thumbnail> })`: every cluster action (persistent
  zone included) in `Row`'s hover-revealed `actions` slot — list actions are
  **hover-only**, a reserved trailing region would take width from the title in
  the narrowest surfaces. The primary action sits over the thumbnail (below);
  without one it joins the hover cluster.

### Cover thumbnail

When the surface is covered (`resolveCover(visibleFields, props.cover)`: the
`DataViewProps.cover` accessor → `FieldDef.cover` → the first `media` field)
and **no explicit leading visual** claims the slot, each row's leading slot is
`<CoverFrame size="thumb">` of its cover — a coverless row a blank frame, so
every row keeps one height (`--cover-thumb-h` + the row padding; the row grows
past a plain text row). The cover field is then the picture, never also a body
term. The precedence is per surface, decided once (`resolveListLeading`):

1. a field placed in `lead` — it always wins, and the cover field stays an
   ordinary body term;
2. else the cover thumbnail;
3. the tree chrome (`rowChrome: "tree"`) never draws one — its icon box is a
   tree row's glyph.

**The primary action** (zone `"primary"`, e.g. Play) is centred over the
thumbnail, revealed by the row's hover and painted at rest while active
(`primary.atRest` / `primary.revealed`). It cannot live inside the thumbnail:
the icon slot is inside an activating row's own `<button>`. So
`PrimaryOverThumbnail` (data-view web, shared with the soft table's
`PrimaryActionSlot`) draws it as the row's SIBLING, on a click-through ghost
of the row's line (`Layer as={Line}` with the row's `p-row`, one
`size-cover-thumb` cell first) — the cell lands on the thumbnail by
construction, not by measured offsets. The wrapper is the `row-actions` hover
group; `RowActions` keeps a press on the action from activating or dragging
the row. A row without a primary action gets no wrapper (markup unchanged).

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

### Placement-driven body

The row draws the view's placement (`usePlacement(…, LIST_SLOTS)`; data-view
CLAUDE.md, "Placement"):

- **`title`** → the title (`Text variant="label"`, truncating), then the
  **`afterTitle`** marks as rigid cells right after it.
- **`line2`** → the muted subtitle run (`Text variant="caption"`, truncating),
  joined with `·` — but see "Chips are not middot-ed" below. A term whose value
  is empty (`isFieldValueEmpty`) is **left out of the run**, separator and all.
  The row is two lines when `line2` holds anything (`lines`, below).
- **`trail`** then **`edge`** → an always-visible trailing region, right of the
  title/subtitle and **before** the hover actions. Each field sits in an
  **aligned slot** (`use-slot-widths.ts`: the widest that slot has been on any
  row, as a CSS variable on the list root, grow-only, reset when the trailing
  field set changes), spaced by `listSlotGap`; the edge field is last, in
  `listTimeInk`. The trailing cell never shrinks, so its fields **give way
  whole** instead: measured on a row (the room from the title's start to the
  line's end, the same whatever shows), they drop in the table's column drop
  order (`dropOrderOf` → data-table's `fitAlignedColumns`, `stacked` for a
  two-line row's column) until the title keeps 6rem. A dropped field's width
  stays measured, so it comes back once the row is wide enough again.
- **quiet terms, elided common values** — the body is wrapped in data-view's
  `FieldPresentationProvider` over the subtitle + trailing fields: chip-typed
  values draw `● label`, and a value ≥ 60% of the rows hold is left out (a
  subtitle term dropped with its separator, a slot left empty at its width).
  See the data-view CLAUDE.md ("Quiet rows and common-value elision").
- **row tone** — `DataViewRenderProps.rowTone` tones the **title** in both row
  shapes, through the shared `rowToneClass`.

### Chips are not middot-ed

` · ` is punctuation between two pieces of text; two chips already carry their
own boundary. So the run draws ` · ` **only between two adjacent non-chip
terms**, and separates a chip from its neighbour by spacing alone. The title
seam follows the same rule, since on one line the title is just the run's first
term.

The run is data-view's shared `SubtitleRun` (+ `drawnSubtitleTerms`), which
the soft table's stacked title cell draws too; `subtitle-extraction.test.tsx`
pins the list's markup against the pre-extraction code.

Which terms are chips comes from `useIsChipField()` — the same Cell registry
`resolveCell` consults, asked once per render (the schema is per-view, not
per-row). **This view names no field type**; `enum` and `tags` declare
`chip: true` on their own cell contributions. See the data-view CLAUDE.md
("An option carries its own presentation").

The spacing is a literal space **in the inline flow**, not a flex `gap`. The
whole run is inline content inside one truncating `<Text>` leaf — that is what
lets the subtitle ellipsize as a single leaf of the row's line — and a flex
container here would make each chip its own leaf and take the truncation with it.

### One or two lines (`options.lines`)

`lines` defaults to **2 when the placement puts a field on `line2`**, else 1;
a surface may pin either.

`lines: 1` puts the title, its marks and any `line2` run on the row's own line
(`Row` composes `Line`: each `<Text>` ellipsizes on its own, an empty `<Fill>`
absorbs the slack, the trailing cell is a rigid leaf). `lines: 2` stacks the
`line2` run under the title inside a `Stack` (each `<Text>` asks for its own
`truncate`), the trailing cell pushed by `ml-auto`.

**Which fields appear (and their order)** follows the view's per-instance
`properties` — the placement hides what the list hides, and the user's order
is the drawing order inside each slot; filter and sort still use the full
schema. See the data-view CLAUDE.md "Per-view visible fields (Properties)".

When `options.renderRow` is set it owns the whole body instead, but is still
wrapped in the selectable/clickable `Row`.

## Attached rows

Over a source with `attach` (data-view CLAUDE.md, "Attached rows") the list
declares `nestsAttach`: each entry's `children` are drawn indented under it
(`Inset l="lg"`, folding with `FoldMotion`), as siblings OUTSIDE the parent's
`ManualOrderRow` — a child has no rank, no drop row, and is never a drag
source. The parent's disclosure writes `attachExpandKey(key)`; open state comes
from `attachedChildrenOpen`.

**The disclosure is the tree's, in the glyph's place — never in the action
cluster.** A list holding attached rows (else one with `detail`) draws every
row's leading glyph
through the tree primitive's `TreeLeading` in `Row`'s `lead` slot, so the
theme's `Tree.Disclosure` variant decides the look (merged: the chevron
replaces the glyph on hover; column: a faint chevron box ahead of it), and the
row carries `TREE_ROW_GROUP`, the named hover group the variants read.
`ListViewOptions.disclosureVariant` pins the look for one list (the Queue pins
`"merged"`) without changing the app's other trees: it reaches the region host
as `TreeDisclosureProps.variant` (variant-region's `VariantRegionPin`), which
wins over the configured variant and throws on an id no variant matches. The
`lead` is outside the row's own `<button>` (no nested control) and
click-through (a press on the glyph at rest opens the row). The action cluster
keeps its hover reveal: it used to hold the disclosure and was therefore
painted at rest on every parent row, pin and `⋯` included. Under
`rowChrome: "tree"` the attached rows fold through `TreeRowChrome`'s own
disclosure.

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
`keepMounted` (and as `raisedKey`, lifting the dragged row's wrapper to the `drag` layer) — so the drag source survives scrolling out of its own window.
`VirtualRows` positions rows absolutely at their measured offsets, so a pinned
off-screen source is invisible and harmless.

Across sections (`onReseat`) the provider runs with `slideAcrossGroups`: its
render-prop `preview` is applied to the sections (`applySectionMove`) before
they are drawn, so a row dragged into another section is laid out there and
that section's rows slide. The section the dragged row is laid out in is
handed to `GroupedSections` as `draggedSection`, so its body is lifted over
the pinned headers for the drag; the `onReseatNew` card floats on `float`,
under the dragged row. Held cross-section drops (`heldReseats`) are applied
the same way. An empty section draws an "Empty" band (its drop target), the
`onReseatNew` card floats at the end of the list root, and `groupEdit` makes
the provider sort whole sections (`groups`) — see the data-view CLAUDE.md,
"Manual order" and "Editable headers". The provider mounts for `groupEdit`
alone too (no manual order: no row drags).

A row whose `getRank` is `null` is non-orderable and renders plain, so
`useRankSortableItem` is never mounted for it — an element-type choice, not a
conditional hook.

## Options

`options` (= `viewOptions.list`) is a `ListViewOptions<TRow>`:

- `renderRow?(row)` — full row-body override (escape hatch); still wrapped in
  the selectable `Row`.
- `renderLeading?(row)` — the leading glyph of a `renderRow` row, drawn by the
  list ahead of the body: the glyph the row's disclosure wraps (a merged
  disclosure swaps it for the chevron on hover). A glyph drawn inside
  `renderRow` sits in the row's own button, where no disclosure can reach it
  (the Queue: the status dot is `renderLeading`, the item drawn `dot={false}`).
- `disclosureVariant?` — the disclosure look this list pins (see "Attached
  rows").
- `detail?(row)` — the row's detail, drawn under it while open (the view's
  expand map); every row then leads with the tree's disclosure.
- `detailOnActivate?` — the whole row is its detail's disclosure: a click
  toggles it, the row carries `aria-expanded`, no disclosure glyph is drawn.
  Needs `detail`; beside a surface's own row activation it throws (one click,
  one answer). The Sessions tab: a visit opens onto its timeline.
- `frame?: "card"` — each entry (the row and its open detail) is one raised
  card, primary-tinted border while open, the detail on the page ground under
  a hairline, cards a `sm` step apart (padding inside the entry, so windowed
  rows space the same). `CardFrame` in `list-view.tsx`. Default row chrome only.
- `lines?` — rows per item, `1 | 2` (default: 2 when `line2` holds a field — see above).
- `columnCaptions?` — a caption row over the list (title label, each trailing
  label over its slot). Default off; also the view type's `configSchema`
  option (a switch in the view's settings).
- `actionsAtRest?` — the row's action cluster stays painted at rest, not
  only on hover: a short list whose item action is the point of each row
  (Places' page overlay: Save on a place not saved yet). An action with
  nothing to offer for a row draws nothing. Default off.
- `size?` — row density, `"sm" | "md"`. Default follows the SURFACE's
  `DataViewProps.density`: `"sm"` when it declared itself compact, `"md"`
  otherwise. Setting it here pins a density whatever the surface asked for.

## Exports

- `ListViewOptions` — the typed options interface. Consumers pass a plain
  `viewOptions={{ list: { … } }}` literal (never import this view child),
  mirroring the gallery / table view children, which likewise ship only their
  options type.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: List view child for the data-view primitive: a compact single-row-per-item list (Row primitive) with field-driven label/subtitle/trailing, active-row highlight, and hover item actions.
- Web:
  - Contributes: `DataViewSlots.View` "List" → `ListView`
  - Uses: 85 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×50
    - `primitives/rank-reorder` ×9
    - `primitives/tree` ×3
    - `primitives/css/spacing` ×2
    - `primitives/latest-ref` ×2
    - `primitives/collapsible.FoldMotion`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/clip.clipClasses`
    - `primitives/css/fill.Fill`
    - `primitives/css/inline.Inline`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.Row`
    - `primitives/css/sticky.Sticky`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/dom/element-size.useResizeObserverSet`
    - `primitives/icon-button.IconButton`
    - `primitives/link-gesture.activationProps`
    - `primitives/virtual-rows.VirtualRows`
    - `ui/icons.Icon`
  - Exports (types): `ListViewOptions`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --card`
    - `ui/tokens/color-palette --faint-foreground`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --input`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/data-view --list-slot-gap`
    - `ui/tokens/data-view --list-time-ink`
    - `ui/tokens/density --chrome-pad-x`
    - `ui/tokens/density --section-body-pad-top`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xl`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shadow --shadow-md`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
- Core:
  - Exports (types): `ListViewOptions`

<!-- AUTOGENERATED:END -->
