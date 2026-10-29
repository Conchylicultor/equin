# icons

The **icons** view child of the `data-view` primitive: a launcher grid, like a
phone home screen. Contributes one `DataViewSlots.View("icons")` entry.

## What it renders

- **A centred grid of fixed-width cells** — `Grid cellWidth`, never stretched.
  116px cells with 72px tiles, `lg` column / `2xl` row gaps; under 760px of *view* width (a container query
  on the view root, not the viewport) 92px cells with 60px tiles. The geometry
  classes sit on each grid, not the root, because a container query styles the
  container's descendants only. The grid starts flush: space above the first
  row is the toolbar arrangement's `spaceBelow`, never the view's own padding.
- **The tile** is the placement's `lead` (`ICONS_SLOTS`: the lead takes only a
  `visual` kind — data-view CLAUDE.md, "Placement") rendered through
  `leadingSlot` inside `<AvatarPresentationProvider value="tile">`, so an
  avatar cell fills the tile box with a flat colour. A schema with **no**
  visual gets a derived-colour squircle letter tile (the name's first
  character), so switching any DataView to icons still draws something.
- **The name** is the placement's `title`, one truncating caption line, muted
  until the tile is hovered or keyboard-focused. A tile draws no other slot.
- **Density**: `density="compact"` (a popover — the app launcher) swaps in a
  fixed small geometry at any width: 72px cells, 36px tiles, `2xs` column / `xs`
  row gaps, tighter tile padding. Both geometries live in one `GEOMETRY` record
  that every grid and the column probe read.
- **Menu layout**: `viewOptions.icons.menu = { columns }` (`IconsViewOptions`)
  lays the grid out as a menu's instead (the menu-bar panel): exactly
  `columns` cells sharing the view's width (`Grid cols`, the count declared
  rather than probed), 40px tiles, `2xs` gaps, each cell a rounded `py-sm`
  target that highlights on hover (`bg-accent`) instead of lifting, its name
  in the text colour at the caption's compact rung, and its item actions on
  the ICON's bottom-right corner (outset `sm`), chipless — each action draws
  its own round button. Density is ignored. A
  third entry beside `GEOMETRY` (`MENU_GEOMETRY`).
- **Selected row**: the `selectedRowId` tile is `aria-current="true"`, its name
  in the foreground colour with a dot under it (a launcher's current app).
- **Activation**: `props.rowActivation?.(row)` passed straight through. A tile
  with an activation is `role="button"` + Enter/Space; one without is a plain
  container and not focusable.
- **`viewOptions.icons.useTileRef`** (`IconsViewOptions`, `core/`): a hook run
  once per rendered tile, returning the ref attached to the WHOLE tile (square
  and name) — e.g. Home's gallery registers each tile as a hint anchor, so the
  tour's card sits beside the app rather than over its name.
- **`viewOptions.icons.addTile`** (`{ label, icon, activation }`): a tile
  after the last one that makes one more (Home's "New app") — an empty dashed
  squircle around `icon`, the label under it, faint until hovered. It is no
  row: search, sort, drag and the arrow keys never see it, and it is hidden
  while nothing matches (the empty state speaks then). Drawn in the last
  section's plain grid only (not in a windowed one).
- **Roving focus**: the activating tiles are ONE tab stop — the last-focused
  tile, else the selected one, else the first. The view root owns the keys:
  ArrowLeft/Right step in render order, ArrowUp/Down go to the nearest tile
  (by centre x) in the previous/next visual row, read from the laid-out boxes
  so it holds for any column count and across group sections; Home/End go to
  the ends. In a windowed section only mounted lanes are reachable by
  ArrowUp/Down.
- Hover / keyboard focus lifts the tile 2px; press sinks it to 96%.
- **Item actions** sit on the tile's top-right corner (`useItemActionZones(desc,
  { hasPersistentSlot: true, hasPrimarySlot: false })`), the gallery card's
  shape: ONE `Pin to="top-right"` holding `[revealed][at rest]`, each arm its own
  float chip (`RowActions chrome="float"`). The whole tile (square and name) is
  the `rowActionsAnchor` hover group; resting actions (persistent, or active per
  `useActive` — an install in flight) stay painted. No primary slot: the tile's
  click is the row's main verb, so a `primary` action joins the cluster. A
  surface with no `itemActions` draws no corner and no hover group. The
  menu-bar app grid's **+** (install) is the first consumer.
- **Not rendered**: selection, aggregation — a launcher has none.

## Manual order

Same wiring as the list view: `RankReorderProvider` over every section's
orderable entries, each tile wrapped in `useRankReorderItem(id, rank, group)`.
`rank-reorder` is flat before/after and its collision detection is
`pointerWithin`, which only asks which droppable rect holds the pointer — so
side-by-side zones work as well as stacked ones. A tile's **left half** is its
`before` zone and its **right half** its `after` zone, painted as a vertical
insertion bar on that edge.

## Grouping + windowing

Grouped sections render through the shared `GroupedSections` chrome, one grid
per section. Above 120 tiles a section windows through `VirtualRows`, one lane
per windowed row; the lane count is read off a zero-height probe grid carrying
the same classes (its resolved `grid-template-columns` track count). While a
drag is in flight the lane holding the drag source is kept mounted.

Each section's grid is its own component (`IconsGrid`), measuring its own
column count. A paged band keeps its tiles' columns across a release or a
landing above it exactly like the gallery (data-view's `useGridPhase`: empty
`data-grid-pad` spacer cells, no role, no `data-row-key`, so the arrow keys,
drag and the viewport skip them; the probe mounted in both branches), and its
lanes are keyed by absolute line (`line:<n>@<columns>`) — the key
`keepMounted` / `raisedKey` pin the drag source's lane by too. See the gallery's
CLAUDE.md ("Paged"); pinned by `web/__tests__/paged-phase.test.tsx` and,
through the real body, `web/__tests__/paged-conformance.test.tsx` (data-view's
`describePagedConformance`, plain and windowed).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Icons view child for the data-view primitive: a centred launcher grid of fixed-size tiles (the row's leading avatar filling a squircle) with the name underneath, drag-to-reorder in manual order.
- Web:
  - Contributes: `DataViewSlots.View` "Icons" → `IconsView`
  - Uses: 37 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×20
    - `primitives/avatar` ×2
    - `primitives/css/ui-kit` ×2
    - `primitives/rank-reorder` ×2
    - `primitives/row-actions` ×2
    - `primitives/css/center.Center`
    - `primitives/css/grid.Grid`
    - `primitives/css/pin.Pin`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/link-gesture.activationProps`
    - `primitives/virtual-rows.VirtualRows`
    - `ui/icons.Icon`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --accent`
    - `ui/tokens/color-palette --faint-foreground`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --input`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --ring`
    - `ui/tokens/density --space-2xl`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xl`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
- Core:
  - Exports (types): `IconsViewOptions`

<!-- AUTOGENERATED:END -->
