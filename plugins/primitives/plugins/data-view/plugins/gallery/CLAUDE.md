# gallery

The **gallery** view child of the `data-view` primitive. Contributes one
`DataViewSlots.View("gallery")` entry: a responsive card grid rendered through
the shared `FieldDef` schema.

## What it renders

One card shape, everywhere — `DataCard`, built at ONE site in `GalleryView`:

- **The cover is the card.** A `<CoverFrame size="card">` (data-view: one fixed
  16/10 frame, `rounded-cover`, `shadow-cover`) with nothing padded around it.
  Its content is `resolveCover(visibleFields, DataViewProps.cover)` — the
  surface's accessor, else the `FieldDef.cover` field, else the first `media`
  field. A row with no cover of its own shows the schema's leading field
  (`FieldDef.leading`, the avatar) centred in the frame, else the blank tint —
  so every card of a view is the same size. Hovering anywhere on the card lifts
  the cover (`coverHoverGroup` on the card root).
- **Its text is `<CardMeta>`**: `partitionCardFields(resolveBodyFields(…))`,
  computed once per view — title (+ indicators), the subtitle (text fields
  joined with ·), one line of icon + value tokens. Fixed line heights; an empty
  value is omitted, never "Empty". The fields follow the view's Properties.
- **Actions sit on the cover** (`useItemActionZones(desc, { hasPersistentSlot:
  true, hasPrimarySlot: true })`):
  - top-right, ONE pin holding `[revealed][at rest]`, each arm its own float
    chip (`RowActions chrome="float"`): at rest only the resting actions show
    (a persistent one, or one whose `useActive` says it is on — pinned, done);
    hover adds the others to their LEFT, so a resting icon never moves;
  - bottom-right, the **primary** action (`zone: "primary"`, drawn by the
    action itself as a round button for `placement: "primary"`): on hover, or
    at rest while active (playing).
- **Badge**: an aggregate representative's `×N`, pinned top-left of the cover.
- **Selected** is a ring around the cover; **row tone** `"muted"` tones the
  title (`rowToneClass`) and veils the cover at rest (`DataCard dimmed`).
- **Grid**: `<Grid minCellWidth="var(--gallery-card-min)">` (`density:
  "compact"` → `var(--gallery-card-min-compact)`), gaps `gap-x-gallery` /
  `gap-y-gallery` — every size is a theme token, never an option.

There are no gallery options. A surface changes what a card shows through its
schema (fields, `FieldDef.cover` / `leading` / `indicator` / `icon`), the
cover accessor, its item actions and the theme's tokens — never by replacing
the card or its body, so a card can never drop an affordance the surface
declared.

## Grouping + windowing

Under group-by the grouped branch renders through the shared **`<GroupedSections>`**
chrome, which owns the `rail-follow` header inset (the grid body uses the
same `rail-follow` with a `py-sm` vertical rhythm), so its
group headers pin and stack exactly like the list's — the header is the same
navigational aid whether a group holds rows or cards. The policy lives in the
data-view parent, not here; see its CLAUDE.md ("Grouped sections: one pipeline, one
chrome").

Windowing is per-section and orthogonal: above **60 cards** a section swaps its
auto-fill `<Grid>` for a lane-aware `<VirtualRows>` (each windowed row is one
measured row of `columns` cards, the count read off an `aria-hidden h-0` probe
grid's resolved `grid-template-columns` tracks, so a themed card minimum or gap
is measured, never re-derived). A windowed line is its own one-row grid, its row
gap the line's `pb-gallery` padding.
`VirtualRows` self-discovers the pane's scroll parent and folds the sticky chrome
into its measured `scrollMargin`, so the two compose with no wiring.

Each section's grid is its own component (`GalleryGrid`), so it measures its own
column count and records its own layout.

## Paged: a release never moves a card to another column

A paged read releases far pages into placeholders above the grid
(`DataViewRenderProps.placeholders` for the flat read, `section.paging` for a
declared section). A page boundary rarely falls on a line boundary, so without
help the first surviving card would restart in column 0 and every card below it
would reflow. The band keeps its phase instead (data-view's `useGridPhase`): it
records the absolute cell index each card was drawn at, and while pages stand
above it starts with `index mod columns` empty spacer cells
(`aria-hidden data-grid-pad`, no `data-row-key` — the viewport, anchoring and
selection never see them). The placeholder is as tall as the lines the page
took, so every card stays exactly where it was. With nothing released above,
the band starts at column 0 (in memory, a client search narrowing the cards
never pads). A paged band mounts the probe in both branches, so the column count
is known in the render a release happens in.

Windowed lines are keyed by ABSOLUTE line, `line:<n>@<columns>`, so a release or
a landing keeps every mounted line's DOM; a live insert at the read's head still
reflows the cards after it (a true reflow). Pinned by
`web/__tests__/paged-phase.test.tsx` (the view alone) and
`web/__tests__/paged-conformance.test.tsx` (through the real body: data-view's
`describePagedConformance`, plain and windowed); deployed, by `data-view/e2e/live-pages-scroll.ts
--view gallery` (no row changes its x).

## No lint rule guards the card — the structure does

One `DataCard` construction site and no body hatch makes "a card without its
declared affordances" unrepresentable, so there is nothing left to detect. What a
rule would NOT have caught, recorded so nobody re-derives it: a shape rule
("no `render<Container>` option") is defeated by renaming the key; "`Pin` + a
hover-reveal class is a row cluster" flags ~12 legitimate media overlays
(rejected in `research/2026-08-06-global-row-action-cluster-convergence.md`); and
`row-actions/no-raw-actions-slot` is name-based on props, so a bespoke card
taking `{song, onOpen}` never trips it.

## Exports

- `DataCard` — the card: `{ rowKey?, onActivate?, selected?, dimmed?, cover:
  CoverContent | null, badge?, actions?: DataCardActions, children }`, where
  `DataCardActions` is `{ atRest?, revealed?, primaryAtRest?, primaryRevealed? }`
  (the zone arms already applied to the row) and `children` is the text under
  the cover (`CardMeta`). Every reveal goes through `primitives/row-actions`; the
  card owns placement only. `data-row-key` rides the card root.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Gallery view child for the data-view primitive: a responsive grid of cover cards — the cover is the card, its fields three fixed lines under it, its actions on the cover.
- Web:
  - Contributes: `DataViewSlots.View` "Gallery" → `GalleryView`
  - Uses: 38 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×24
    - `primitives/css/ui-kit` ×2
    - `primitives/row-actions` ×2
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/grid.Grid`
    - `primitives/css/layer.Layer`
    - `primitives/css/pin.Pin`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/link-gesture.activationProps`
    - `primitives/virtual-rows.VirtualRows`
  - Exports (types):
    - `DataCardActions`
    - `DataCardProps`
  - Exports (values): `DataCard`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --ring`
    - `ui/tokens/density --chrome-pad-x`
    - `ui/tokens/density --gallery-card-min`
    - `ui/tokens/density --gallery-card-min-compact`
    - `ui/tokens/density --gallery-gap-x`
    - `ui/tokens/density --gallery-gap-y`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xl`
    - `ui/tokens/shape --radius-cover`

<!-- AUTOGENERATED:END -->
