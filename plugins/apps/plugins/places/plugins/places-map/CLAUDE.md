# places-map

The Places app's index pane (`/places`, `placesMapPane`): every saved place in
one full-bleed `DataView`, with every piece of chrome floating on the map.
Reference UI: prototype `proto-1791725279-9yramg` at its defaults
(`status=been-want`, `emoji=material`, `drop=bare`, `crowd=google`,
`size=small`, `far-count=label`). Plan: `research/2026-10-15-apps-places-map-spots.md`.

## The screen (`web/components/places-screen.tsx`)

`PlacesScreen` waits for both live reads (`usePlaces`, `usePlaceTags`,
combined) — each the WHOLE set (an `all` collection: every place, every tag,
never a window's newest slice) — the pins, the sidebar's counts and the card
all need both, so nothing renders an empty map or zero counts for a read that
has not landed.
Then `PlacesSurface` renders, inside a `relative h-full` box:

- `<DataView storageKey="places.map" views={["map","gallery","list"]}
  toolbar={floatingToolbar} aside={<TagSidebar/>} actions={<AddPlaceButton/>}>`
  — the views are authored in `config/apps/places/places-map/places.map.jsonc`
  (All places = map, Gallery, List). `backdrop="map"`: the map stays mounted
  under every view — Gallery and List float over it as a card showing the
  same places, its right edge stepping aside for the place card
  (`reserve={{ right: CARD_REACH }}` while it shows) — so switching views
  never moves the user's camera. `viewOptions.map` stamps
  `pinType: "saved-place"` and `pinData: placeVisual(place, tags)` on every
  pin, asks for `crowd: { kind: "spots" }` (every place always drawn — no
  clusters) and ranks a Want to go place above the rest (`rank`); gallery
  covers and list glyphs paint the same `PlaceVisual`.
- The selected place's `PlaceCard` and the `TagManagerPanel` (from
  `tag-manager`) as `Pin`ned floating cards on the right, below the toolbar's
  tools card (`BELOW_TOOLBAR`); the manager starts past the sidebar
  (`PAST_SIDEBAR`, matching the sidebar's `w-72`). Selection is local state:
  `onRowActivate` (a pin, a card, a row) selects; `selectedRowId` makes the
  pin active and pans to it. A click anywhere else on the screen — the map,
  the sidebar, the toolbar — closes the card (`web/internal/use-click-away.ts`):
  not a drag (a map pan), not a click that selected another row (it `claim()`s),
  and nothing portalled outside the screen (the card's own pickers, the delete
  confirm). Esc closes it too (a surface shortcut above the solo surface's
  exit-fullscreen Esc).
- **Pick mode** (`PinPick`, `web/components/pin-pick-bar.tsx`): Add place ›
  *Drop a custom pin* (`drop`, named in the bar first — the typed search text
  seeds the name) or the card's *Move* on a custom place (`move`) hands the
  map primitive's `pick` to the map view: crosshair cursor, and the next click
  on the map (not a pin) creates the custom place (`createCustomPlace`) or
  PATCHes its `location`, then selects it. The bar sits at the bottom with
  Cancel; Esc cancels too (a surface shortcut above the card's). The card is
  hidden while picking, and the answering click `claim()`s, so it is never a
  click away. The map does not re-frame for the new position (the renderer
  holds framing after a pick).

## Fields (`web/internal/fields.tsx`)

name (primary — `placeName`: the user's title, else Google's or a custom
place's name; search reads the title AND Google's name) · address · tags (`type: "tags"`, `values` = every tag id incl.
Been / Want to go, `options` = the tree with `parent`, so the nested operators
reach descendants; the cell draws the non-role tags as colour chips) · want /
been (derived bools, `placeFlags`; filterable, groupable) · location (`data` = the `Location`, hidden from
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

The header always says how many places show: the total alone, or `shown /
total` while the filter or search narrows the view (`useFlatRows` over the
active view state with the same `placeSearchText` the DataView searches by) —
the one place a view narrowed to nothing is explained; the map stays bare.

A row click cycles include → exclude → off; including a tag replaces any
included tag it subsumes or narrows. A row's count is `tagPlaceCounts` over the
places the REST of the filter keeps (`withoutSidebarRules` → `useRowFilter`),
nested tags included. The quick-search text is not applied to the counts.

The tree rows are transient filter chrome (the brief's exemption from
DataView): a disclosure button beside a `Row` (never nested in it), the
tri-state box, `TagMark`, name, count. Roots start open.

Clicking the header's title line ("Places", the total, a chevron) folds the
sidebar to its header — tree and footer gone, the tag-filter summary kept —
remembered per device (`useDraft("places.tag-sidebar.open")`). The aside card
hugs the sidebar's height (it is a `<Column fill>`), so the folded card is
just the header and the map below it is reachable.

## Pins (`GeoMap.Pin` for `saved-place`)

No cluster: the map draws spots (`map` primitive), so every place is always on
the map — at rest as a sprite on the map's pin canvas (`map/pin-layer`), drawn
from `savedPlaceMark`; hovered or selected as `SavedPlacePin` in the DOM,
which draws the SAME mark (`MapMarkImage`) and adds what only the DOM does.
Both scales:

- **near** (zoom ≥ 13) — the drop at 0.8× (`PIN_HEAD_PX` 24 on the 30px
  design head; icon and ground shadow scale with it), its tip on the point,
  standing on a soft ground ellipse (faded on a pale place).
- **far** — a round badge (`shape: "disc"`, 0.78× the head) centred on the
  place; badges overlap, the better-ranked on top. The map draws a spot's size
  beside its lead as map-label text; the lifted pin fades it while a pin of its
  spot is hovered (`spot.hushed`) or the lead itself is.

The head is `placeDropSvg` (`web/components/place-drop.tsx`) over the map
primitive's `dropHeadSvg` — the ONE drawing of it, for the mark, the lifted
pin, the legend and the card's hero (`PlaceDropHead`, inline): design size
30px, `sizePx` scales it; a square with three round corners turned −45°, 2px
white outline, the tag colours as equal slices from the top — one colour
solid — and the Material icon, white, 18px, with a soft shadow on multi-colour
heads. SOLID iff the place carries Want to go; otherwise (Been only, or
neither) PALE — the same slices under a 78% white veil, icon 17px in the main
colour darkened. No Been mark on the pin. Hover lifts the drop (2px, 1.05×),
active grows it from its tip (1.18×; far 1.25× / 1.3× from the centre). The
`MapLabel` name shows on hover and while active — never always-on, at any
zoom. The mark resolves every colour through the map (`env.color`), so its
key changes with the theme's outline colour and the tag colours.

Paint strings are pure (`web/internal/pin-paint.ts`, tested). `PlaceVisual`
(`web/internal/place-visual.ts`) resolves colours, the `want` / `been` flags and icon once: the
place's own icon (Haiku), else its first tag's nearest icon, else
`location-on`. A saved-place pin without one throws (a wiring bug).

## The place card (`web/components/place-card.tsx`)

The Poster card (prototype `proto-1791725279-9yramg` at `card=poster`), as tall
as its content (the `Pin` column is `pointer-events-none`; the card's body
scrolls, its footer stays):

- **Hero** (`place-hero.tsx`): Google's photos as a scroll-snap strip (1 / n,
  previous / next on hover, the author credited — Google's terms), else the
  tag colours' wash with the place's icon as a watermark, or a placeholder
  while a Google place's details load (never the wash, then a photo). The
  scaled drop stands on its foot.
- **Head**: the name, edited in place (`PlaceTitleInput`: on a Google place it
  writes `title`, and blank or Google's own name clears it, with "On Google:
  <name>" under a title; on a custom place it renames, blank reverts) —
  "Custom pin — no Google place" + Move for a custom place — the Google type,
  rating · count · price, open now (`OpenNowLine`, re-read each minute), or a
  closure pill.
- **Body**: Google's summary · Want to go / Been (two independent toggles in
  their tag's colour, each a `tags` PATCH) · tags (tinted `TagChip`s, path
  tooltip, ✨ for `autoTags`, ×, "+ Tag" picker that replaces the picked tag's
  ancestors) · the note slip (saved on blur, `aria-label="Note"`) · facts
  (`place-facts.tsx`): the week (folding out), address + copy, phone + copy,
  website, saved date + Google type, the icon's provenance + Regenerate.
- **Footer**: Open in Google Maps (`mapsUrl`, else a search pinned to the
  Google id; a custom place's opens at its coordinates) · Directions · delete
  (`confirmDialog`).

Google's rich facts come from `places/place-details` (`usePlaceDetails`, read
when the card opens, kept a day on the server, never stored); a custom place
has none. The wording (open now, the week, compact counts) is pure, in
`web/internal/place-facts.ts` (tested).

## Add place (`web/components/add-place.tsx`)

The toolbar's primary action: a popover searching `placeSearch` (debounced
250ms; one `crypto.randomUUID()` session per opening, passed to the save).
Picking saves (`savePlace`) and selects the place; `maps-not-configured`
(search or save) renders `MapsAccessAction`. Its last row, *Drop a custom
pin*, starts pick mode for a place Google does not know.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The Places app's index pane (/places): every saved place in one full-bleed DataView (Map, Gallery, List) with its chrome floating on the map — the tag sidebar owning the tag half of the view filter (include / exclude, any / all, faceted counts), the Add place search, the selected place's card — plus the saved-place pin: a drop near, a round badge far out with each spot's size beside it.
- Web:
  - Slots: `places-map.actions`
  - Slot contributors: `places-map.actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "places-map"
    - `GeoMap.Pin` → `SavedPlacePin`
  - Uses: 79 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/places/places-core` ×9
    - `map` ×6
    - `primitives/data-view` ×6
    - `primitives/collapsible` ×5
    - `primitives/css/ui-kit` ×4
    - `primitives/live-state` ×3
    - `ui/icons` ×3
    - `apps/places/tag-manager` ×2
    - `integrations/google-maps` ×2
    - `primitives/css/control-panel` ×2
    - `primitives/css/text` ×2
    - `primitives/hover-reveal` ×2
    - `primitives/pane` ×2
    - `apps/places/place-details.usePlaceDetails`
    - `primitives/app-shell.AppShellBrand`
    - `primitives/copy-to-clipboard.CopyButton`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/clip.clipClasses`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/column.Column`
    - `primitives/css/coords.Placed`
    - `primitives/css/fill.Fill`
    - `primitives/css/layer.Layer`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.Row`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/surface.Surface`
    - `primitives/css/toggle-chip.SegmentedControl`
    - `primitives/data-view/floating-toolbar.floatingToolbar`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/dom/scroll-reveal.revealElement`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/loading.Loading`
    - `primitives/overlay/imperative-dialog/confirm.confirmDialog`
    - `primitives/persistent-draft.useDraft`
    - `primitives/relative-time.useNow`
    - `primitives/search.SearchInput`
    - `primitives/shortcuts.useSurfaceShortcuts`
- Cross-plugin:
  - Uses tokens: 27 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×11
    - `ui/tokens/type-scale` ×7
    - `ui/tokens/density` ×5
    - `ui/tokens/shape` ×2
    - `ui/tokens/categorical --categorical-foreground`
    - `ui/tokens/shadow --shadow`

<!-- AUTOGENERATED:END -->
