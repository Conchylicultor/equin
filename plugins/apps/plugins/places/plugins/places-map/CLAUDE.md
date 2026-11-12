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

- `<DataView storageKey="places.presets" views={["map"]}
  viewEdits={{ mode: "draft", home: "all" }} viewShortcuts
  switcherForm="none" toolbar={floatingToolbar} aside={<TagSidebar/>} asideEnd={<PlacesPanel/>}
  search={…}>` — the search is controlled, with the universal search panel as
  its `suggestions` (below). Its views are the **filter presets** (below),
  every one a map: All places is authored in
  `config/apps/places/places-map/places.presets.jsonc`, the rest are the
  user's. `backdrop="map"` keeps the one map mounted whatever preset is
  active, so switching presets never moves the camera; `reserve={{ right }}`
  is what the screen's own right-hand chrome covers (the Sonnet thread, and a
  floating card beside it), which the side panel steps aside for.
  `viewOptions.map` stamps `pinType: "saved-place"` and
  `pinData: placeVisual(place, tags)` on every pin, asks for
  `crowd: { kind: "spots" }` (every place always drawn — no clusters), ranks a
  Want to go place above the rest (`rank`), reports each camera rest
  (`bounds` for the Google search, `visible` for the panel's In view) and
  carries the panel's `fitRequest`. One place hover (`useLinkedHover`,
  `primitives/data-view` — a store, never screen state: a pin, row or card reads its own part,
  so gliding over the pins re-renders what they light, never the screen) is
  shared by the map (the presets DataView's `rowHover`) and the
  panel's list or gallery, so a row and its pin light together — a hovered row
  lifts its pin exactly as the pointer would (drop raised, name shown).
  The former `places.map` id (Map / Gallery / List views) is retired and its
  committed config deleted; its **user layer is orphaned on purpose** — its
  rows (Gallery, List, a filtered All places) would otherwise render as
  presets, and config migrations are shared across view ids.
- The selected place's `PlaceCard` as a `Pin`ned floating card on the right,
  below the toolbar's tools card (`BELOW_TOOLBAR`). The card floats only while the side panel is hidden; while it is shown, the card
  drills into the panel instead (below). Selection is local state:
  `onRowActivate` (a pin, a card, a row) selects; `selectedRowId` makes the
  pin active and pans to it. A click anywhere else on the screen — the map,
  the sidebar, the toolbar — closes the card (`web/internal/use-click-away.ts`):
  not a drag (a map pan), not a click that selected another row (it `claim()`s),
  and nothing portalled outside the screen (the card's own pickers, the delete
  confirm). Esc closes it too (a surface shortcut, priority 1).
- **Pick mode** (`PinPick`, `web/components/pin-pick-bar.tsx`): the search
  panel's *Drop a custom pin* (`drop`, named in the bar first — the typed search text
  seeds the name) or the card's *Move* on a custom place (`move`) hands the
  map primitive's `pick` to the map view: crosshair cursor, and the next click
  on the map (not a pin) creates the custom place (`createCustomPlace`) or
  PATCHes its `location`, then selects it. The bar sits at the bottom with
  Cancel; Esc cancels too (a surface shortcut above the card's). The card is
  hidden while picking, and the answering click `claim()`s, so it is never a
  click away. The map does not re-frame for the new position (the renderer
  holds framing after a pick).

## A page laid over the map (`/places;page=<pageId>`)

A VIEW of the one map pane, not a pane of its own: the index route
(`placesMapRoute`, owned by `places/page-overlay` so the page side can link
to it) declares a keyed param, `;page`. `placesMapPane`'s body reads
`useParams().page` and hands it to `PlacesScreen` — so opening (a page map
block's "Open in Places"), closing and back / forward only change a param of
the mounted pane: the map, the DataView and every piece of screen state stay.
Plan: `research/2026-11-02-apps-places-page-overlay-v2.md` (v1, the second
pane it replaced: `research/2026-10-31-apps-places-page-overlay.md`).
Nothing is written: the page's places are a layer, read live. Reference UI:
prototype `proto-1793376812-x39bpd` (`overlay-tpin=ghost`,
`overlay-others=dim`, `overlay-list=panel`, `overlay-numbers=on`).

- **The read.** `PlacesScreen`'s gate covers places and tags only. The page's
  read (`usePageOverlay`) lives in `PageOverlayReader`, a child of the
  surface mounted only while `;page` is set, which reports it up (a report
  counts only for the page `;page` names now). So the map never re-gates on
  the page: the page's loading and failure are the overlay panel's own states
  (`PageOverlayRead`, drawn inside the panel's frame), and the layer (dims,
  numbers, ghosts) appears once it has landed.
- **Close.** × clears `;page` with the pane's own `useSetParams()` — a
  history push on the same mounted pane (back reopens the layer, forward
  closes it), never `inAppLink`. A page place's detail card closes with the
  layer; the camera stays where it rests.
- **Pins.** A page's place that is one of yours is its own saved pin with its
  number on a badge (`SavedPinVisual.pageNumber`, the head's top-right, in
  `--place-overlay`), drawn above the rest (`rank` 2) and kept on the map
  whatever the preset hides (`keep`); every other saved pin is `dimmed`
  (faded and desaturated, still clickable) — both in the mark key. A place not
  saved yet is a ghost pin (`places.page-item`, `page-item-pin.tsx`): the
  Google result's ghost disc (`ghostDiscMark`) with its ring dashed in the
  overlay accent, its kind's glyph in its family's darkened colour and its
  number on a badge — framed by the camera (no `frame: false`). A search hit
  or a pick of the same place is not drawn twice. Numbers are map text
  (`MapMark.texts` `center` at a `point`), so the DOM pin draws them too
  (`MarkTexts`).
- **Camera.** `focusIds` = the page's places while the layer is on (a saved
  one by its row key, the rest by `pageItemPinId`). Opened cold on a page
  (`;page` at mount), the map opens `cameraOpen: "framed"` — on the page, not
  where the user left it, yet still remembering each rest under `places.map`.
  However `;page` came to be set (cold, an open from Pages, back / forward),
  the screen bumps `fitRequest` once per page id as soon as its places are
  known (not on each live edit of the page); × leaves the camera where it is
  and drops `focusIds`. The panel's Fit bumps `fitRequest` too.
- **The panel** (`page-overlay-panel.tsx`) takes the side panel's spot and
  width (`asideEnd`, always shown while `;page` is set): "From a page" and ×
  (clears `;page`); the
  page's icon and title with "← Page" (`pageDetailRoute` in Pages); "N places ·
  k saved · m not saved" and the places not on the map; the places as a
  DataView list (`places.page-overlay`, its config one unsorted list —
  `renderRow`: Google's photo over the colours' wash with the number, name,
  rating (`usePlaceDetails`) · type, ✓ Saved and two tags, or the address);
  Save is the row's item action (`PageOverlayItemActions`, painted at rest —
  the list's `actionsAtRest`), handed its handler by context. The footer: Fit,
  "m not in your places yet", **Save all m** — every save in turn, then ONE
  toast with ONE Undo deleting them all. Each Save (row, card) is the search's
  own save (`useSavePlace`: auto-tags, Want to go) with its toast and Undo.
- **Hover.** A row and its pin light together. The panel's rows and the
  ghost pins claim the hover by page BLOCK (`useLinkedHover`) — whether or not
  the place is saved, so a row saved while hovered releases what it claimed;
  a saved one lifts its row pin (the map's `rowHover`, derived from both
  with `deriveLinkedHover`), one not saved yet its ghost (the map option's
  `hover`, derived from the Google and page hovers). A saved pin hovered on
  the map lights its row through the overlay panel's derived `rowHover`.
- **Drill.** Selecting a place (row or pin) drills its card into the panel
  under "← <page> · k of N": `PlaceCard` for a saved one, else
  `GooglePlaceCard` with the page's note ("On <page> — not in your places",
  Save to my places in the overlay accent, in place of the footer's Save) —
  saving it opens the new place's own card.
- **Search and Ask** work as on the plain map; their cards drill into the
  overlay panel the same way, and its list returns when they close.
- A page gone since the link was made shows "This page no longer exists" in
  the panel; nothing is dimmed.

## Fields (`web/internal/fields.tsx`)

name (primary — `placeName`: the user's title, else Google's or a custom
place's name; search reads the title AND Google's name) · address · tags (`type: "tags"`, `values` = every tag id incl.
Been / Want to go, `options` = the tree as `tagFieldOptions` (tag-tree
engine: tree order, `parent`, the tag colour as `swatch`), so the nested operators
reach descendants; the cell draws the non-role tags as colour chips) · want /
been (derived bools, `placeFlags`; filterable, groupable) · location (`data` = the `Location`, hidden from
bodies — the map's axis) · note · createdAt ("Saved").

## The tag sidebar (`web/components/tag-sidebar.tsx`)

The surface's `aside`: it edits the active view's filter through
`useDataViewControls().filter`. Its state is an AND of OR-rows
(`{ rows: string[][]; exclude: string[] }`): it owns only the TOP-LEVEL rules
of an `and` root on the tags field — one `has-nested` rule per row (the row's
tags or-ed, the rows and-ed as siblings), one `lacks-nested` rule with every
excluded id — and keeps every other node as it was (an `or` root is wrapped,
never rewritten; rule ids are reused in order). The filters the former any /
all switch wrote read back unchanged (one rule = one row). All of it is pure
and unit-tested in `core/internal/sidebar-filter.ts` (core, so the Places fixture writer builds a preset's filter with it) (`sidebarState`,
`applySidebarState`, `rootOf`, `includeTag`, `toggleTag`, `removeTag`,
`splitRow`, `mergeRows`, `moveTag`, `presetAutoName`, `presetIcon`,
`withoutSidebarRules`).

The tag filter box (`web/components/tag-filter-box.tsx`, under the presets,
once anything is picked or the preset has unsaved edits): "Tagged" rows of `TagChip`s — a
row of several chips drawn as one tinted group — with an `or` between two
chips (a click splits the row there: both required) and an `and` between two
rows (a click merges them: either one); an included chip drags (HTML5 drag)
onto another row, or onto the "and …" zone shown only while dragging, for a
row of its own; × removes. Then "Not tagged" (the excluded chips), then the
`footer` line: the preset's actions (below), while it has unsaved edits.

The header always says how many places show: the total alone, or `shown /
total` while the filter or search narrows the view (`useFlatRows` over the
active view state with the same `placeSearchText` the DataView searches by) —
the one place a view narrowed to nothing is explained; the map stays bare.

A row click toggles a tag off ↔ include — it never excludes: an exclusion is
written in the advanced filter (the box shows it under "Not tagged", and a
click on its row or its chip's × drops it). Including a tag replaces any
included tag it subsumes or narrows, then joins the row whose tags share its
root tag (Museums joins Viewpoints under Culture: or), else starts a row
(Want to go: and). A row's count is `tagPlaceCounts` over the
places the REST of the filter keeps (`withoutSidebarRules` → `useRowFilter`),
nested tags included. The quick-search text is not applied to the counts.
While the rest of the filter names a rule that does not resolve, no counts
are drawn (the DataView shows the rule error).

The tree is the shared tag picker (`TagPickerPanel`, `tag-tree/picker`), so
the one tree both filters and edits — there is no separate tag manager.
Places sets it up as a filter: `indicator="checkbox"` (✓ included, − excluded
and struck through, a primary − on a tag holding either), `selected` /
`negated` from the sidebar state, the faceted `counts`, roots open
(`defaultExpanded="roots"`), no focus steal. Its search finds a tag or creates
the typed path (`Trips/Porto`), left unpicked (`pickCreated={false}`: a new
tag carries no place yet). Editing is the picker's: hover ＋ (sub-tag) and ⋯
(rename, icon, move out, shade children, colour, delete), double-click to
rename, drag to reorder or nest, "New tag" at the foot. Delete is not offered
on the role tags (`canDelete`; the tree's `refuseDelete` refuses it anyway),
and the ⋯ menu ends with the tag's Google types, read-only
(`rowMenuExtra`).

The header folds the sidebar (its chevron, device-local,
`web/internal/layout-stores.ts`) to the header card alone, at the same width:
the app mark, the active preset's name as the title — `DataViewViewChip
appearance="title"`, a dropdown of every preset (draggable) with the dirty dot
— then `shown / total` and the chevron that unfolds it. Unfolded, the title is
"Places" and the presets list below it. No tag chips and no preset actions
while folded — the dirty dot is the only sign of edits. The surface's
`switcherForm` is `"none"`: the band never draws a switcher.

## Presets

The presets DataView's views are saved FILTERS, never layouts
(`viewEdits={{ mode: "draft", home: "all" }}` — data-view's "View edits"):
every tag picked in the sidebar, and every filter edit, goes to the active
preset's per-tab working copy (a dirty dot) until it is kept. The sidebar
lists them at its top (`DataViewViewList`: icon, name, count, dirty dot, ⋯
Rename / Duplicate / Delete, drag to reorder with All places pinned first,
"+ New preset" — a preset from the current filter, named after its tags by
`presetAutoName`, with `presetIcon`, opened for renaming); ⌥1–9 switch
(`viewShortcuts`). The tag box's footer carries the actions while the active
preset is dirty: on All places **Clear** (discard) and **Save as preset**
(`drafts.saveAsNew` — All places goes back to its saved filter); on another
**Reset** (discard) · **Save as new** · **Update** (`drafts.save`). Switching
preset discards the edits with an Undo toast (data-view's own). Nothing is
seeded beyond All places: a preset names tags by id, and tag ids are the
user's. A fixture brings its own (`places/fixtures`' `presets`, by tag path):
written after its tags, its filter built with this plugin's
`applySidebarState` (core) and saved through config-v2's `set-field`, as
"Save as preset" does.

## The side panel (`web/components/places-panel.tsx`)

The surface's `asideEnd` (`PANEL_WIDTH` 372px, `card-frame.tsx`): the active
preset's places — the presets DataView's own rows, `useFlatRows` over its
controls (filter and search) — scoped by `scopePlaces`
(`web/internal/panel-scope.ts`, tested: `boundsContain` over the map's
`CameraRest.visible`, the area the chrome leaves uncovered). Header:
"In view N | All M" (device-local), list | gallery, Hide (the layout,
device-local: `list | gallery | hidden`). Body: a second DataView,
`places.panel` (`config/apps/places/places-map/places.panel.jsonc`: the
fields the old Gallery / List views had, and NO sort — the rows arrive in the
preset's own order, so the toolbar's Sort, which edits the preset, orders the
panel), `pinnedView` = the layout, a body-only hosted frame, its covers
and glyphs painting the same `PlaceVisual`. Footer while in view: "K more
outside the map · Fit map · Show all" (Fit bumps the map's `fitRequest`);
none in view: "None of the N places of <preset> are in view" with the same
two. Hidden, the panel is a pill (the preset's name and count) that shows it
again — gone while a floating card holds that corner.

**Drill.** While the panel is shown, selecting a place (a row, a pin) or a
Google place draws its card IN the panel (`CardFrame` `panel`: the panel's
card is the surface, a Back line "← <preset> · in view" leads it, no Close);
Back, Esc or a click away deselects. A row click pans only when the pin is
covered (the map's focus rule). The map's fit-padding probe covers the
panel's width (and the thread beside it), so In view means what the user
sees; with the sidebar collapsed the probe starts at the left edge.

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
(`web/internal/place-visual.ts`) resolves colours, the `want` / `been` flags and icon once
(the pin's data is a `SavedPinVisual`: plus `pageNumber` / `dimmed` while a
page is laid over the map): the
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
  scaled drop stands on its foot. A click on a photo (or its `1 / n`) opens
  the photos panel.
- **Photos** (`place-photos.tsx`, prototype `proto-1792628021-7wrhf5`):
  `PhotoThumbs` — the next four photos as square thumbnails under the head,
  the last veiled with "+N"; a thumbnail opens that photo in the
  `image-viewer` (← / → through all), "See all" or the veiled one opens
  the photos panel: the SAME card element (local `photosOpen` state, in both
  `PlaceCard` and `GooglePlaceCard`) swaps its header / body / footer for
  `PhotosHeader` / `PhotosGrid` (the photos header replaces the frame's own,
  Back line included — `cardColumnProps(frame, photos)` in `card-frame.tsx`)
  and glides to `PLACE_PHOTOS_WIDTH` (760px, `cardWidthProps` — one
  element, so the width transitions) from its frame's width — 340px floating,
  `PANEL_WIDTH` drilled into the side panel, whose card hugs it and widens
  leftwards with it. `cardColumnProps` derives the width for every frame, so
  no frame can draw a card that jumps. It shows every photo Google shares — at most ten, Google's cap, no
  categories — in two columns at their own shape, each credited on hover
  (the place's own uploads marked Owner: the author is named as the place),
  then a "More on Google Maps" tile to the full album; a photo opens the
  viewer (an `ImageGallery`). Back returns to the card. Both share the
  Column's one scroller, so each resets it on mount (`ScrollTopOnMount`). The screen's reach
  constants (and the map's fit-padding probe) keep the resting width — the
  card's or the panel's — so the wider photos panel overlays the map while it
  is open, and the camera's padding never moves under the user.
- **Head**: the name, edited in place (`PlaceTitleInput`: on a Google place it
  writes `title`, and blank or Google's own name clears it, with "On Google:
  <name>" under a title; on a custom place it renames, blank reverts) —
  "Custom pin — no Google place" + Move for a custom place — the Google type,
  rating · count · price, open now (`OpenNowLine`, re-read each minute), or a
  closure pill.
- **Body**: Google's summary · Want to go / Been (two independent toggles in
  their tag's colour, each a `tags` PATCH) · tags (tinted `TagChip`s, path
  tooltip, ✨ for `autoTags`, ×, and "+ Tag": `tag-picker.tsx`, the shared
  `TagPickerPopover` (`tag-tree/picker`) on `placeTagTree` with counts
  `tagPlaceCounts` over every place, Been / Want to go and the place's own tags
  excluded — a pick adds that tag and drops the ancestors of it the place
  carried; search, create a typed path, rename, recolour, nest and reorder
  edit the tree itself) · the note slip (saved on blur, `aria-label="Note"`) · facts
  (`place-facts.tsx`): the week (folding out), address + copy, phone + copy,
  website, saved date + Google type, the icon's provenance + Regenerate.
- **Footer**: Open in Google Maps (`mapsUrl`, else a search pinned to the
  Google id; a custom place's opens at its coordinates) · Directions · delete
  (`confirmDialog`).

Google's rich facts come from `places/place-details` (`usePlaceDetails`, read
when the card opens, kept a day on the server, never stored); a custom place
has none. The wording (open now, the week, compact counts) is pure, in
`web/internal/place-facts.ts` (tested).

## Universal search ("Search or add places")

One bar, top-right, for both halves of a search (prototype
`proto-1791725279-9yramg` at `gpin=ghost`; plan
`research/2026-10-19-apps-places-universal-search.md`). The DataView's own
search field, controlled (`search={{ query, onQueryChange, suggestions }}`):

- **Your places** — the query is the view's search, so the map's pins (and
  the sidebar's `shown / total`) filter live. The panel's first section lists
  the first 4 matches (`useFlatRows` over `useDataViewControls()`, exactly what
  the map shows), then "+N more on the map"; a row closes the panel and opens
  the place's card.
- **Google** (`web/internal/use-google-search.ts`) — from 2 characters,
  debounced 300 ms, `placeSearch` biased to the map's view (the box from the
  map view's `onCameraRest`, rounded to 3 decimals so a settle is the same
  question) and asked again when the camera rests elsewhere. The previous
  answer stays while the next loads (`refreshing`: the spinner in the section
  label). Hits in view first, then the rest tagged "off the map". Each hit is a
  `GoogleResultCard` (`web/components/google-result-card.tsx`): the would-be
  tags' colour and icon (`googleResultVisual`: what Save auto-tags it with),
  name, `RatingLine`, type · address, `OpenNowLine` (both shared with the
  place card); 5, then "Show N more". **Save** saves it (auto-tagged, Want to
  go) and toasts "Saved X · Tagged …" with Undo (deletes it) — no selection, no
  camera move; a hit already saved shows **✓ Saved**, which opens it. The
  answer names the rung of the downgrade ladder (`places-core`'s
  `searchRung`): `basic` / `names` say so in the section ("Ratings paused until
  Nov 1 …"); a `names` hit has no rating, no position (no pin), and its save
  carries the round's session. `maps-not-configured` (search or save) renders
  `MapsAccessAction`.
- **Saved hits stay on the map.** A hit (or a Sonnet pick) that is already
  one of your places is drawn as its own pin, kept by the map view's `keep`
  even where the view's search or filter hides it — Google matches names the
  substring search misses ("belleviloise" → La Bellevilloise), and a hit the
  panel lists must be on the map. The selected place is always drawn too (the
  map view's rule), so opening it pans to its pin.
- **Ghost pins** (`web/components/google-result-pin.tsx`, `GeoMap.Pin` for
  `places.google-result`) — every hit with a position not saved yet, as the
  map view's extra `overlays` with `frame: false`, so the camera never frames
  them. At rest a 28px white disc with a dashed ring and icon in the would-be
  tag's darkened colour; lifted (hovered on the map, or its card hovered —
  `hoveredId` / `onHoverChange`, linked both ways through `hoveredGoogleId`) it
  grows 1.3×, its ring turns solid and its name shows. A click (or a click on
  its card in the panel) opens its detail card (below).
- The panel's last row, *Drop a custom pin*, starts pick mode for a place
  Google does not know, named with the query.

The panel opens on focus or typing and closes on Esc, an outside press, a
pick, or pick mode; closing keeps the query (the filter and the ghosts stay).

## Ask Sonnet (`web/components/ask-thread.tsx`, `web/internal/use-ask.ts`)

A question (Enter on a question-like query, ⌘Enter on any, or a panel row)
starts a background run (`useStartThread`, the `places.ask` profile — see
`places/ask`). Prototype: `proto-1792595270-10dc3w`.

- **The thread is a docked side card**, not part of the search panel:
  `AskThreadCard`, full height on the right under the toolbar
  (`ASK_THREAD_WIDTH` 380px), an `<AgentThread>` with Hide and Close
  (×, `EndThreadButton`: closes the conversation and drops its task — the card
  goes, the run stays in the history) in its header. The bar's
  `AskPill` stays while a run is in hand (`useAsk`'s `conversationId`) and
  toggles the card (`shown`; filled while shown, its unseen dot only while
  hidden). Typing in the bar only searches — the card is untouched.
- **Results.** The CURRENT result is the newest accepted `places_show_picks`
  call across the whole thread (`useAskResults`; a follow-up turn without
  picks leaves it current): full `GoogleResultCard`s with `pick` — Google's
  thumbnail (`PlacePhotoWash`, the gallery cover's photo-over-wash) with the
  rank, why, about, sources (`PickSources`), Save. Each earlier result is a
  one-line summary ("5 picks · Le Barav, …") unfolding (`FoldMotion`) to its
  cards; the unfolded set is screen state per run, so the map shows the
  current result's pins plus every unfolded one's (`mapPicksOf`, tested: a
  place picked twice is one pin, its newest pick).
- **History.** With nothing typed, the search panel lists "Recent questions"
  (`AskHistory`: `useThreadRuns(PLACES_ASK_PROFILE, { limit: 5 })`, the
  question from the run's title, its state — working / N picks / closed —
  and age). Panel rows, not a DataView: a short picker in a popover, like
  "Your places". Picking one shows it in the card; a closed run can be
  replied to (the composer resumes it).
- **Restore.** Once per load the newest run is taken back, HIDDEN, when it is
  still working or said something unseen — the pill (with its dot) without
  the card covering the map.

## The detail card (`web/components/google-place-card.tsx`)

A Google place not saved yet — a pick (its card in the thread, or its pin) or
a search hit (its ghost pin, or its card in the panel) — opens
`GooglePlaceCard`: the place card's hero (`PlaceHero` over `usePlaceDetails`),
name, type · address, rating, open now, Sonnet's why / about / sources for a
pick, Google's summary and facts (`GoogleFactRows`, `DetailsNotice`,
`GoogleCredit`, shared with `PlaceCard`), and the shared footer
(`MapsActions`: Open in Google Maps, Directions) with Save — which then shows
the saved place's own `PlaceCard`. A place already saved opens its
`PlaceCard` directly. One card at a time, in the place card's spot: beside
(left of) the thread while it is shown, else at the right edge. Esc or a click
away closes it — a click in the thread is not away (`useClickAway`'s
`panels`). The map's fit padding probe covers the card(s) and the thread.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The Places app's index pane (/places): every saved place on one full-bleed map whose views are filter presets (All places, then the user's own — edits are drafts until saved, ⌥1–9 switch), with its chrome floating on the map — the tag sidebar (the presets with their counts and dirty dots, the tag filter as AND-ed rows of OR-ed tags with the preset's Reset / Save as new / Update, the tag tree with faceted counts; folded, the header alone, titled by a dropdown of the presets), the side panel (the preset's places in view or all, as a list or a gallery, hover-linked with their pins, a selected place's card drilled into it), the "Search or add places" bar (your places filtered live, Google's hits around the map's view as cards to save and as ghost pins hover-linked with them, the camera never moving; Ask Sonnet hands a question to a background run shown as a thread in a card docked on the right — the newest picks as Google cards with photos, why they fit, what makes them special and their sources, earlier answers folded, as numbered pins — its progress as a pill in the bar that shows and hides the card, and the recent questions in the panel to reopen), the selected place's card or a Google place's detail card — plus the saved-place pin (a drop near, a round badge far out with each spot's size beside it), the Google result's ghost pin, Sonnet's numbered pick pin, the thread's step labels for the Ask Sonnet tools, and the transcript row of places_show_picks (the numbered picks beside a mini map, hover-linked). Its ;page param, /places;page=<pageId>, lays one page's places over the same map, read live (page-overlay): the page's saved places numbered, the rest dimmed, the page's places not saved yet as numbered ghost pins, the camera framed on the page, the map never remounted — and a panel in the side panel's spot listing them in page order (hover-linked with their pins, each place's card drilled in, Save and Save all with one Undo, × back to the plain map).
- Web:
  - Slots:
    - `places-map.actions`
    - `page-overlay-item-actions`
  - Slot contributors:
    - `places-map.actions` ← `primitives.pane`
    - `page-overlay-item-actions` ← `apps.places.places-map`
  - Contributes:
    - `Pane.Register` "places-map"
    - `FieldPresentation.Register` "entity:places"
    - `GeoMap.Pin` → `SavedPlacePin`
    - `GeoMap.Pin` → `GoogleResultPin`
    - `GeoMap.Pin` → `PageItemPin`
    - `GeoMap.Pin` → `AskPickPin`
    - `page-overlay-item-actions` "save" → `SavePageItemAction`
    - `AgentThreadSlots.StepLabel` "places_search_text" → `SearchStepLabel`
    - `AgentThreadSlots.StepLabel` "places_show_picks" → `PicksStepLabel`
    - `renderer` "mcp__equin__places_show_picks" → `ParsedToolView`
  - Uses: 141 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×15
    - `apps/places/places-core` ×8
    - `conversations/agent-thread` ×8
    - `map` ×8
    - `network/live/live-state` ×7
    - `primitives/collapsible` ×6
    - `network/live` ×5
    - `primitives/css/ui-kit` ×4
    - `primitives/overlay/image-viewer` ×4
    - `infra/endpoints` ×3
    - `primitives/hover-reveal` ×3
    - `primitives/link-gesture/new-tab` ×3
    - `tag-tree/picker` ×3
    - `ui/icons` ×3
    - `apps/places/page-overlay` ×2
    - `conversations/conversation-view/jsonl-viewer/tool-call` ×2
    - `integrations/google-maps` ×2
    - `page/place` ×2
    - `primitives/css/clip` ×2
    - `primitives/css/layer` ×2
    - `primitives/css/rigid` ×2
    - `primitives/css/text` ×2
    - `primitives/persistent-draft` ×2
    - `primitives/relative-time` ×2
    - `apps-core/tabs.useAppLinkProps`
    - `apps/places/place-details.usePlaceDetails`
    - `conversations/conversation-view/jsonl-viewer.useJsonlConversationId`
    - `integrations/google-maps/usage.useMapsBudget`
    - `page/editor.PageIcon`
    - `primitives/app-shell.AppShellBrand`
    - `primitives/copy-to-clipboard.CopyButton`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/column.Column`
    - `primitives/css/control-panel.ControlPanel`
    - `primitives/css/coords.Placed`
    - `primitives/css/fill.Fill`
    - `primitives/css/grid.Grid`
    - `primitives/css/inline.Inline`
    - `primitives/css/line.Line`
    - `primitives/css/motion.Presence`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/surface.Surface`
    - `primitives/css/toggle-chip.SegmentedControl`
    - `primitives/css/yield.yieldClass`
    - `primitives/data-view/floating-toolbar.floatingToolbar`
    - `primitives/dom/auto-scroll.KeepAnchorAcross`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/dom/scroll-reveal.revealElement`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/loading.Loading`
    - `primitives/overlay/imperative-dialog/confirm.useConfirmDialog`
    - `primitives/overlay/tooltip.Kbd`
    - `primitives/pane.Pane`
    - `primitives/shortcuts.useSurfaceShortcuts`
    - `shell/toast.showToast`
    - `tag-tree/engine.useTagTreeActions`
- Core:
  - Uses:
    - `primitives/data-view.FilterGroup`
    - `primitives/data-view.FilterNode`
    - `primitives/data-view.filterNodeIdKind`
    - `primitives/data-view.FilterRule`
    - `tag-tree/engine.isTagUnder`
    - `tag-tree/engine.TagNode`
    - `tag-tree/engine.tagPath`
  - Exports (types): `SidebarState`
  - Exports (values):
    - `applySidebarState`
    - `includedTags`
    - `mergeRows`
    - `moveTag`
    - `presetAutoName`
    - `presetIcon`
    - `removeTag`
    - `sidebarState`
    - `splitRow`
    - `toggleTag`
    - `withoutSidebarRules`
- Cross-plugin:
  - Uses tokens: 31 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×12
    - `ui/tokens/type-scale` ×7
    - `ui/tokens/density` ×6
    - `ui/tokens/shape` ×3
    - `ui/tokens/categorical --categorical-foreground`
    - `ui/tokens/place-palette --place-overlay`
    - `ui/tokens/shadow --shadow`
  - Imported by: `apps/places/fixtures`

<!-- AUTOGENERATED:END -->
