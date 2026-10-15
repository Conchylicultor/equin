# DataView overlay backdrop + floating view panel (Places Gallery / List over the map)

## Context

In Places (`/places`) the Gallery and List views currently take the whole
surface: switching from the map view unmounts the map, and the gallery/list
fill the screen edge to edge (inset only past the floating toolbar and tag
sidebar). The mockup `proto-1791725279-9yramg` instead floats them as a
**card over a still-live map**: below the toolbar, right of the sidebar, down
to the bottom gutter, its right edge yielding to the place card while one is
open (`.panel` / `.detail-open .panel` in the mockup's CSS).

Why it is a primitive change, not a Places one: a DataView mounts exactly one
view. Under the overlay arrangement (`floatingToolbar`),
`BandSurface` (`plugins/primitives/plugins/data-view/web/components/band-surface.tsx`)
either lets a `fullBleed` view (the map) run under the floating chrome, or
pads any other view to clear it. There is no way to keep a full-bleed view
mounted *behind* another view. The outcome: a generic "backdrop" for overlay
surfaces, with non-full-bleed views riding over it in a floating panel; Places
opts in.

## Design

### 1. `DataViewProps.backdrop` — a view type that stays mounted under the overlay

- New optional prop `backdrop?: string` — a view-type id (`"map"`). Declared in
  `core/internal/types.ts` beside `aside` (and threaded through
  `web/internal/body-types.ts`).
- Validation (throw, like the `aside` guard in `web/components/data-view.tsx`):
  - only with an `overlay` arrangement (not hosted / sections / in-flow band);
  - the type must resolve in `DataViewSlots.View` and declare `fullBleed: true`
    (a backdrop is by definition the surface's canvas).
- Semantics: while `backdrop` is set the surface **always** renders that view
  type at one fixed tree position under everything, so switching views never
  remounts it (the map keeps its camera across Map ↔ Gallery ↔ List — today it
  is lost on every switch).
  - **Active view is the backdrop type** (the "All places" map instance): the
    backdrop node *is* the active view (it gets the active instance's options);
    no panel renders.
  - **Active view is anything else**: the backdrop renders with the active
    view's `renderProps` (same rows, search, filter state, `selectedRowId`,
    `rowActivation`) — so the map shows exactly the places the gallery/list
    shows, and clicking a pin still activates its row. `manualOrder` is
    dropped; options are `viewOptions[backdrop]` (code options; Places'
    `pinType`/`pinData`/`label`/`fitPadding`/`pick` all live there).
  - While the body is not in its `view` state (loading / error) the backdrop
    stays mounted with no rows (the map view already tolerates empty rows
    without moving the camera — `camera-stays.ts`), and the fallback renders in
    the panel.

Where: in `DataViewBodyInner` (`web/components/data-view-body.tsx`), build a
`backdrop` node next to `body` — `renderIsolated(DataViewSlots.View,
backdropViewType, backdropRenderProps)` — and hand it to `BandSurface` as a
new prop. Resolve the view type from the same registry the instances resolve
from (no naming of `map` anywhere in the host).

### 2. `BandSurface`: the floating view panel

When `overlay && backdrop`:

```
<Scroll fill isolate>  backdrop (h-full, stable position)  </Scroll>
{active is not the backdrop type &&
  <Pin top=header-offset left=asideInset+gutter right=gutter+reserveRight bottom=gutter layer=…>
    <Surface level="overlay"> <Scroll fill> {children} </Scroll> </Surface>
  </Pin>}
band, aside (unchanged)
```

- Same material as the aside and toolbar cards (`Surface level="overlay"`),
  opting back into pointer events (`OverlayInteractive`).
- The panel's own `Scroll` becomes the surface's scroller for the active view
  (infinite-scroll footer, `KeepAnchorAcross`, virtualizers all find it as the
  nearest scroller — verify `useScrollHandle`'s lookup).
- Inside the panel `--dv-header-offset` is reset to `0px`, so sticky group /
  column headers pin at the panel's top, not under the toolbar band.
- Without `backdrop` nothing changes (every other overlay surface keeps today's
  layout).

### 3. `DataViewProps.reserve` — the edge the panel yields

- `reserve?: { right?: string }` (CSS length) — space on the surface's right
  edge the consumer covers with its own floating chrome; the panel's right
  edge sits a gutter past it. Only meaningful with `backdrop` (throw
  otherwise, so it cannot silently do nothing).
- Places passes `showCard ? PAST_CARD : undefined` — the same length
  `places-screen.tsx` already feeds the map's fit-padding probe, so the two
  cannot disagree.

### 4. Places opts in

`plugins/apps/plugins/places/plugins/places-map/web/components/places-screen.tsx`:
`<DataView backdrop="map" reserve={…} …>`. Everything else stays:
`onRowActivate` + `selectedRowId` already open the card from a card, a row or
a pin; `useClickAway` already treats the card's region as its own (check that
a click on the panel still counts as a click away, as on the sidebar today —
it should, the panel is inside `containerRef`). Update the screen's doc
comment and `places.map.jsonc`'s comment ("Gallery and List float over the
map").

## Critical files

- `plugins/primitives/plugins/data-view/core/internal/types.ts` — `backdrop`, `reserve` props.
- `plugins/primitives/plugins/data-view/web/internal/body-types.ts`, `web/components/data-view.tsx` — threading + guards.
- `plugins/primitives/plugins/data-view/web/components/data-view-body.tsx` — backdrop node + render props.
- `plugins/primitives/plugins/data-view/web/components/band-surface.tsx` — backdrop layer + floating panel.
- `plugins/primitives/plugins/data-view/core/internal/toolbar-arrangement.ts` — doc on `overlay` mentions the backdrop.
- `plugins/primitives/plugins/data-view/CLAUDE.md` — document the overlay backdrop.
- `plugins/apps/plugins/places/plugins/places-map/web/components/places-screen.tsx` — opt in.

Reuse: `Pin`, `Surface`, `Scroll`, `OverlayInteractive`, `spaceLength`,
`DATA_VIEW_HEADER_OFFSET_VAR`, `renderIsolated` — all already imported in
`band-surface.tsx` / `data-view-body.tsx`.

## Verification

1. `./singularity test plugins/primitives/plugins/data-view` — add a jsdom test
   beside `web/__tests__/toolbar-arrangement.test.tsx`: with `backdrop`, switching
   between a full-bleed and a list instance keeps the backdrop element mounted
   (same DOM node), the list renders inside the panel, `reserve.right` moves the
   panel's right edge, and the guards throw (non-overlay arrangement, non-full-bleed
   backdrop type, `reserve` without `backdrop`).
2. `./singularity build`, then on Places:
   - screenshots of Gallery and List with and without a selected place
     (`screenshot.ts --path /places --click "Gallery"`, then click a card);
   - `compare-diff.ts --name proto-1791725279-9yramg` for a visual check against the mockup;
   - re-run `places-map/e2e/camera-stays.ts`, `open-card.ts`, `click-away.ts`;
   - new `places-map/e2e/backdrop-panel.ts`: zoom the map, go to Gallery and back —
     pins at the same screen positions (camera kept); open a card from Gallery —
     panel's right edge clears the card; click a pin through the visible map gap — card opens.
3. `./singularity check` (boundaries, docs in sync).
