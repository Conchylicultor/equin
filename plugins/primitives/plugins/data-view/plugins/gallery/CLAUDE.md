# gallery

The **gallery** view child of the `data-view` primitive. Contributes one
`DataViewSlots.View("gallery")` entry: a responsive card grid rendered through
the shared `FieldDef` schema.

## What it renders

- **Default card** (free): a field-driven `<DataCard>` — title from the first
  `text` field (or `fields[0]`), a cover region, and the remaining fields as
  muted property rows. Wired to `onRowActivate`. The cover supports three kinds
  (see `cover` below) so an icon- or preview-covered card needs **no** custom
  component — just a schema plus a one-line cover accessor.
- **Row tone**: `DataViewRenderProps.rowTone` tones the card **title** (the
  property rows below it are already muted, so the title carries the whole
  difference), through the shared `rowToneClass` — see the data-view CLAUDE.md
  ("Row tone"). A custom body owns its own text and is not toned.
- **Custom body** (`options.renderBody`): replaces the title + property rows and
  **nothing else**. There is exactly ONE `DataCard` construction site, so
  `media` / `leading` / `selected` / `onRowActivate` / both action zones / the
  aggregate `×N` badge are wired whether the body is field-driven or custom —
  a custom body cannot drop an affordance the surface already declared.

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
measured row of `columns` cards, the count read off an `aria-hidden h-0` probe grid).
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

## Options

`options` (= `viewOptions.gallery`) is a `GalleryViewOptions<TRow>`:

- `renderBody?(row)` — replace the card's BODY (title + property rows) only.
- `leading?(row)` — block rendered *beside* the body (icon / avatar / status
  dot), the twin of `ListViewOptions.leading` → `Row`'s `icon`. Distinct from
  `cover`, which is full-width and sits ABOVE the body. Rendered after the
  schema's leading field (`FieldDef.leading`), if any — that field is out of the
  title pick and the property rows, but never the cover. See the data-view
  CLAUDE.md ("Leading field").
- `size?` — card density, `"sm" | "md"` (default `"md"`).
- `cover?(row)` — produce the default card's cover region as a `CoverContent`:
  `{ kind: "image", src }` | `{ kind: "icon", icon }` | `{ kind: "node", node }`,
  or `null` for none. Each kind renders in a uniform `aspect-video` frame.
  Takes precedence over `coverField`; the body still comes from the schema.
- `coverField?` — override which field id is the image cover (else the
  `FieldDef` with `cover: true`, else the first `media` field).
- `minCardWidth?` — grid min card width in px (default 200).
- `showCreateCard?` — when `true` **and** exactly ONE creator is present on
  `DataViewProps.creators`, render a trailing dashed "+" card (after the row map)
  firing that creator's `onSelect`. With zero or multiple creators the card is
  omitted — a single dashed card can't express an N-way choice, so multi-creator
  surfaces rely on the toolbar `+` menu. The gallery also renders a minimal
  creators CTA (one `Button` per creator) below `emptyState` when the data source
  is confirmed-empty (after the loading guard).

## No lint rule guards the card — the structure does, and only that far

One `DataCard` construction site + a body-only hatch makes "a card without its
declared affordances" unrepresentable, so there is nothing left to detect. What a
rule would NOT have caught, recorded so nobody re-derives it: a shape rule
("no `render<Container>` option") is defeated by renaming the key; "`Pin` + a
hover-reveal class is a row cluster" flags ~12 legitimate media overlays
(rejected in `research/2026-08-06-global-row-action-cluster-convergence.md`); and
`row-actions/no-raw-actions-slot` is name-based on props, so a bespoke card
taking `{song, onOpen}` never trips it. The limit is real: `renderBody` can still
hand-roll a *button* inside the body. It just has no card to own.

## Exports

- `DataCard` — composable card chrome with `media` / `leading` / body /
  `actions` / `footer` regions, focus, and click→`onActivate`. `actions` renders
  through the shared `primitives/row-actions` cluster (reveal, pin + scrim, press
  guards); `footer` is where the gallery puts the persistent-zone cluster.
- `GalleryViewOptions` — the typed options interface. Consumers pass a plain
  `viewOptions={{ gallery: { … } }}` literal (never import this view child),
  mirroring the list and table view children, which likewise ship only their options type.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Gallery view child for the data-view primitive: a responsive card grid with a field-driven default card plus a composable DataCard chrome.
- Web:
  - Contributes: `DataViewSlots.View` "Gallery" → `GalleryView`
  - Uses: 38 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×22
    - `primitives/css/ui-kit` ×2
    - `primitives/row-actions` ×2
    - `primitives/css/badge.Badge`
    - `primitives/css/card.Card`
    - `primitives/css/center.Center`
    - `primitives/css/clip.Clip`
    - `primitives/css/grid.Grid`
    - `primitives/css/pin.Pin`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/link-gesture.activationProps`
    - `primitives/virtual-rows.VirtualRows`
    - `ui/icons.Icon`
  - Exports (types):
    - `CoverContent`
    - `DataCardProps`
    - `GalleryViewOptions`
  - Exports (values): `DataCard`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/color-palette --ring`
    - `ui/tokens/density --chrome-pad-x`
    - `ui/tokens/density --pad-card`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xl`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-semibold`
- Core:
  - Exports (types):
    - `CoverContent`
    - `GalleryViewOptions`

<!-- AUTOGENERATED:END -->
