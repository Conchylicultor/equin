# places-map

The Places app's index pane (`/places`, `placesMapPane`): every saved place in
one full-bleed `DataView`, with every piece of chrome floating on the map.
Reference UI: prototype `proto-1791725279-9yramg` at its defaults
(`status=pin-style`, `emoji=material`, `drop=bare`).

## The screen (`web/components/places-screen.tsx`)

`PlacesScreen` waits for both live reads (`usePlaces`, `usePlaceTags`,
combined) — the pins, the sidebar's counts and the card all need both, so
nothing renders an empty map or zero counts for a read that has not landed.
Then `PlacesSurface` renders, inside a `relative h-full` box:

- `<DataView storageKey="places.map" views={["map","gallery","list"]}
  toolbar={floatingToolbar} aside={<TagSidebar/>} actions={<AddPlaceButton/>}>`
  — the views are authored in `config/apps/places/places-map/places.map.jsonc`
  (All places = map, Gallery, List). `viewOptions.map` stamps
  `pinType: "saved-place"` and `pinData: placeVisual(place, tags)` on every
  pin; gallery covers and list glyphs paint the same `PlaceVisual`.
- The selected place's `PlaceCard` and the `TagManagerPanel` (from
  `tag-manager`) as `Pin`ned floating cards on the right, below the toolbar's
  tools card (`BELOW_TOOLBAR`); the manager starts past the sidebar
  (`PAST_SIDEBAR`, matching the sidebar's `w-72`). Selection is local state:
  `onRowActivate` (a pin, a card, a row) selects; `selectedRowId` makes the
  pin active and pans to it. A click anywhere else on the screen — the map,
  the sidebar, the toolbar — closes the card (`web/internal/use-click-away.ts`):
  not a drag (a map pan), not a click that selected another row (it `claim()`s),
  and nothing portalled outside the screen (the card's own pickers, the delete
  confirm).

## Fields (`web/internal/fields.tsx`)

name (primary) · address · tags (`type: "tags"`, `values` = every tag id incl.
status, `options` = the tree with `parent`, so the nested operators reach
descendants; the cell draws the non-status tags as colour chips) · status
(derived enum todo / done) · location (`data` = the `Location`, hidden from
bodies — the map's axis) · note · createdAt ("Saved").

## The tag sidebar (`web/components/tag-sidebar.tsx`)

The surface's `aside`: it edits the active view's filter through
`useDataViewControls().filter`. It owns only the TOP-LEVEL rules of an `and`
root on the tags field with `has-nested` (include) / `lacks-nested` (exclude)
— `any` = one include rule with every id, `all` = one include rule per id,
one exclude rule with every excluded id — and keeps every other node as it
was (an `or` root is wrapped, never rewritten). All of it is pure and
unit-tested in `web/internal/sidebar-filter.ts` (`sidebarState`,
`applySidebarState`, `cycleTag`, `applySidebarClick`, `withoutSidebarRules`).

A row click cycles include → exclude → off; including a tag replaces any
included tag it subsumes or narrows. A row's count is `tagPlaceCounts` over the
places the REST of the filter keeps (`withoutSidebarRules` → `useRowFilter`),
nested tags included. The quick-search text is not applied to the counts.

The tree rows are transient filter chrome (the brief's exemption from
DataView): a disclosure button beside a `Row` (never nested in it), the
tri-state box, `TagMark`, name, count. Roots start open.

## Pins (`GeoMap.Pin` / `GeoMap.Cluster` for `saved-place`)

- `SavedPlacePin` — the drop: 30px head (`PlaceDropHead`: a square with three
  round corners turned −45°, 2px white outline, the tag colours as conic slices
  from 45° — one colour solid — and the Material icon, white, 18px, with a soft
  shadow on multi-colour heads; todo = the same slices under a 78% white veil,
  icon 17px in the main colour darkened). Ground shadow under the tip; hover
  lifts, active grows from the tip. The `MapLabel` name shows on hover and
  while active — the pin is never told the zoom.
- `SavedPlaceCluster` — a disc ringed by the colour mix of its places (each
  place one share split over its colours, heaviest first), white face with the
  count and `✓ n` done; 40 / 48 / 56px by count.

Paint strings are pure (`web/internal/pin-paint.ts`, tested). `PlaceVisual`
(`web/internal/place-visual.ts`) resolves colours, status and icon once: the
place's own icon (Haiku), else its first tag's nearest icon, else
`location-on`. A saved-place pin without one throws (a wiring bug).

## The place card (`web/components/place-card.tsx`)

Hero (scaled drop on the pale main colour, name, address, where the icon came
from + Regenerate / Pick one) · Todo / Done (`status` PATCH) · tags (path
tooltip, AUTO for `autoTags`, ×, "+ Tag" picker that replaces the picked
tag's ancestors) · note (saved on blur) · Google type, saved date · Open in
Google Maps (`mapsUrl`, else a search URL) · delete (`confirmDialog`).

## Add place (`web/components/add-place.tsx`)

The toolbar's primary action: a popover searching `placeSearch` (debounced
250ms; one `crypto.randomUUID()` session per opening, passed to the save).
Picking saves (`savePlace`) and selects the place; `maps-not-configured`
(search or save) renders `MapsAccessAction`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The Places app's index pane (/places): every saved place in one full-bleed DataView (Map, Gallery, List) with its chrome floating on the map — the tag sidebar owning the tag half of the view filter (include / exclude, any / all, faceted counts), the Add place search, the selected place's card — plus the saved-place drop pin and its colour-ringed cluster.
- Web:
  - Slots: `places-map.actions`
  - Slot contributors: `places-map.actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "places-map"
    - `GeoMap.Pin` → `SavedPlacePin`
    - `GeoMap.Cluster` → `SavedPlaceCluster`
  - Uses: 56 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/places/places-core` ×8
    - `primitives/css/ui-kit` ×4
    - `primitives/data-view` ×4
    - `map` ×3
    - `primitives/live-state` ×3
    - `primitives/pane` ×3
    - `apps/places/tag-manager` ×2
    - `integrations/google-maps` ×2
    - `primitives/css/control-panel` ×2
    - `primitives/css/text` ×2
    - `primitives/hover-reveal` ×2
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/column.Column`
    - `primitives/css/coords.Placed`
    - `primitives/css/fill.Fill`
    - `primitives/css/layer.Layer`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/row.Row`
    - `primitives/css/spacing.Stack`
    - `primitives/css/surface.Surface`
    - `primitives/css/toggle-chip.SegmentedControl`
    - `primitives/data-view/floating-toolbar.floatingToolbar`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/loading.Loading`
    - `primitives/overlay/imperative-dialog/confirm.confirmDialog`
    - `ui/icons.Icon`

<!-- AUTOGENERATED:END -->
