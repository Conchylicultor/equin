# Places — page overlay ("Open in Places" from a page's map block)

> **Superseded routing — see [v2](./2026-11-02-apps-places-page-overlay-v2.md).**
> The overlay is no longer a second pane (`placesPageOverlayPane`,
> `/places/from-page/<pageId>`): it is the `;page` keyed param of the one map
> pane (`/places;page=<pageId>`), so opening and closing it never remounts the
> map. Everything else below stays as built.

## Context

A page's `/map` block (`plugins/page/plugins/map`) draws the page's place blocks on
their own map. The user wants to see how those places fit among their saved
places in the Places app. A temporary tag was rejected: it only works for
places already saved, it writes to the user's data, and it needs cleaning up
later. Instead, the Places app opens with the page's places as a **temporary
layer, read live by page id**. Nothing is written until the user clicks Save.

Reference UI: prototype `proto-1793376812-x39bpd` at `overlay-tpin=ghost`,
`overlay-others=dim`, `overlay-list=panel`, `overlay-numbers=on`. Implement it
pixel-close to that prototype, using the real app's primitives (the Google map,
`CardFrame`, `GooglePlaceCard`, `PlaceCard`).

## Behaviour

- **Page side.** The map block shows an **Open in Places** button in its top-right
  corner. It is contributed through a new `PageMap.Action` slot, so `page/map`
  never names Places. The button links to `/places/from-page/<pageId>` through the
  normal cross-app navigation (`inAppLink(route.link(placesApp, { pageId }))`).
- **Places, overlay route.** The map is the same `PlacesScreen`, plus the layer:
  - **Page items.** These are the page's own place blocks (`b.pageId === pageId`)
    with `providerId === "google"`, a `placeId` and coordinates, in page order,
    numbered 1…N. The list updates live as the page is edited, because it is a
    `useLive(pageBlocks, { where: { pageId } })` read.
  - **Saved item.** A page item whose `placeId` equals a saved place's
    `googlePlaceId`. Its own saved pin gets a teal number badge.
  - **Unsaved item.** Drawn as a **ghost pin**: a dashed teal disc showing the
    place's kind icon, with the number badge. Clicking it opens
    `GooglePlaceCard`, which already reads Google rich details (photos, hours,
    rating) via `usePlaceDetails(googlePlaceId)`. A "From *page* — not in your
    places" note and **Save** sit on the card. Save uses the existing `useSavePlace`
    (auto-tags plus Want to go), shows the existing toast with Undo, and selects
    the new place.
  - **Other saved places.** They are drawn dimmed: the pin is faded and
    desaturated, and still clickable.
  - **Floating panel** (right, where the side panel sits; the side panel is
    hidden while the layer is on). It contains:
    - a "From a page" chip and ×;
    - the page icon and title, with a "← Page" link that opens the page at
      `pageDetailRoute`;
    - a summary: N places · k saved · m not saved;
    - the items as a **DataView list** (the project rule for domain records):
      a photo thumbnail (the first `usePlaceDetails` photo, else the kind wash),
      the number, the name, rating · type, and either a "✓ Saved" line with tag
      chips or the address with a **Save** item action;
    - a footer with Fit and **Save all m**, which shows one toast with one Undo
      for all of them.
  - **Linked hover.** Hovering a row lifts its pin, and hovering a pin lights its
    row.
  - **Drill.** Selecting an item opens its card drilled into the panel, with a
    back line "← *page title* · 3 of 8", using the same `CardFrame` `panel`
    kind as `PlacesPanel`.
  - **Camera.** On open, and on Fit, the camera frames the page items only, not
    the whole preset.
  - **Closing.** × navigates to `/places`. The layer is gone and the camera stays
    where it is.
  - **Unplaced items.** Blocks with no place picked, a non-Google provider or no
    coordinates are counted in the summary ("2 not on the map"), the same way
    `page/map` reports its unplaced blocks.

## Design

### 1. `page/place/core`: a pure `locatedPlaces(blocks)`
Extract the body of `placeOverlays` (`plugins/page/plugins/place/plugins/map-layer/web/internal/place-layer.ts`)
into `locatedPlaces(blocks): { located: LocatedPlace[]; unplaced: number }` in
`plugins/page/plugins/place/core`.

- It walks `PLACE_TYPE` blocks, runs `placeBlock.safeParse` on each, and requires
  a `placeId` and `lat` / `lng`.
- Each `LocatedPlace` is `{ blockId, providerId, placeId, name, address, kind, family, position }`.
- `placeOverlays` becomes a map over it.
- Unit test it beside the existing `place-block.test.ts`.

### 2. `page/map`: `PageMap.Action` render slot
Add `Action: defineRenderSlot<{ id: string; component: ComponentType<{ pageId: string }> }>`
to `plugins/page/plugins/map/web/slots.ts`. `defineRenderSlot` comes from
`primitives/slot-render`; see `plugins/stats/web/slots.ts`.

- `MapBlock` renders the slot's contributions as a floating row in the map
  surface's top-right corner, using the `Pin` / layout primitives, not absolute
  CSS.
- The block is still read-only-safe: no action renders in the version-history
  placeholder.

### 3. New plugin `plugins/apps/plugins/places/plugins/page-overlay`
This plugin owns the overlay's contract and its page-side entry point. The
dependency direction is Places → page, which creates no cycle: nothing under
`page/` imports Places.

**`core/`**
- `placesPageRoute = defineRoute({ id: "places-page", segment: "from-page/:pageId" })`.
- `PageOverlayItem`, the joined type: `{ n, blockId, googlePlaceId, name, address, position, kind, family, saved: Place | null }`.
- `joinPageOverlay(located, places)`, a pure function (with tests). It filters to
  `providerId === "google"`, numbers the items in page order, and matches
  `saved` through a `savedByGoogleId` map. Move that map's construction out of
  `places-screen.tsx` into `places-core/core` as `placesByGoogleId(places)`, and
  reuse it in both places.

**`web/`**
- **`usePageOverlay(pageId)`** reads `useLive(pageBlocks, { where: { pageId } })`
  and the page's title and icon. Find the page row's live read; the page-tree /
  page-outline plugins use one. It joins these with `usePlaces()`.
  - It returns a **state**, never a stand-in: loading, error, missing page, or
    ready with `{ page, items, unplaced }`. See the "not-known-yet" rule.
- **`OpenInPlacesAction`** is contributed to `PageMap.Action`. It is a compact
  overlay button with the Places app mark and the label "Open in Places", and
  links to `placesPageRoute.link(placesApp, { pageId })`.
- **`PageOverlayPanel`** draws the panel described above, including the DataView
  list and the Save / Save all actions.
- **The page-item ghost pin.** Its type is `places.page-item` and it is
  registered via `GeoMap.Pin`. Model it on `google-result-pin.tsx` (dashed disc
  and mark) plus the `ask-pick-pin.tsx` number badge. The pin colour is the
  overlay teal token (see the next point).
- **The overlay accent.** It is one theme token (`--places-overlay`, prototype
  `#0f766e`) on the places token group, or the app theme's existing accent if
  that fits. No hex literals in components.

### 4. `places-map`: the overlay mode of `PlacesScreen`
- **A second pane.** Add `placesPageOverlayPane` to `places-map/web/panes.tsx`,
  using route `placesPageRoute` and `app: placesApp`, and listed with the app's
  full-pane panes. It renders `<PlacesScreen overlayPageId={pageId} />`. The
  index pane renders `<PlacesScreen />`. Empty segments cannot carry keyed
  params, so this is a route, not `;page=`.
- **In `PlacesSurface`, when an overlay is present:**
  - **Pins.**
    - Ghost pins for unsaved items go into `viewOptions.map.overlays` (framed,
      not `frame: false`).
    - Saved items get `pinData` with a `pageNumber`.
    - Every other row gets `dimmed: true`.
    - Extend `PlaceVisual`, `savedPlaceMark` and `SavedPlacePin` with both
      fields, and include both in the mark cache key.
  - **Panel.** `PageOverlayPanel` takes the right-hand slot instead of
    `PlacesPanel`. Feed its width into `pastRight` / `rightReach` /
    `fitPadding` and add its ref to the click-away panels. The drilled card uses
    the panel frame with a back line.
  - **Hover.** One linked hover id (`useLinkedHover`) spans ghost pins, the
    saved pins of page items, and the panel rows.
  - **Framing the page items.** `fitRequest` frames every overlay today (see
    `FitControl` in `plugins/map/plugins/google/web/components/google-map-impl.tsx`).
    - Add an optional **`focusIds`** (the overlay ids a fit frames, when set) to
      `MapView` → the renderer → `frameView`, and pass it through the DataView
      map options.
    - The overlay sets `focusIds` to the page items' pin ids and bumps
      `fitRequest` once the items are ready, and on the panel's Fit.
    - Keep the persisted camera (`cameraKey`) for the index route only. The
      overlay route always opens framed on the page.
  - **Search.** Universal search and Ask keep working while the layer is on.
    Their cards take the right-hand slot as they do today, and the overlay panel
    returns when they close.

## Files (representative)

- `plugins/page/plugins/place/core/{located-places.ts,index.ts}` and `map-layer/web/internal/place-layer.ts`
- `plugins/page/plugins/map/web/{slots.ts,components/map-block.tsx}`
- `plugins/map/web/components/map-view.tsx`, `plugins/map/web/slots.ts`, `plugins/map/plugins/google/web/components/google-map-impl.tsx` (`focusIds`)
- `plugins/primitives/plugins/data-view/plugins/map/web/…` (pass `focusIds`)
- `plugins/apps/plugins/places/plugins/page-overlay/{core,web}/…` (new)
- `plugins/apps/plugins/places/plugins/places-core/core/…` (`placesByGoogleId`)
- `plugins/apps/plugins/places/plugins/places-map/web/{panes.tsx,index.ts,components/places-screen.tsx,components/saved-place-pin.tsx,internal/place-visual.ts}`
- Each touched plugin's `CLAUDE.md` prose, where its contract changes (places-map's "The screen", page/map's slot list).

## Execution (subagents)

The steps run in order, in this worktree. There is no isolation, because each
step builds on the one before.

1. **Sonnet, the page side:**
   - §1 (`locatedPlaces` with tests, and the `placeOverlays` refactor);
   - §2 (`PageMap.Action` slot and its render in `MapBlock`);
   - `focusIds` in the map primitive and the DataView map options.
   - Run `./equin check type-check` and `./equin test plugins/page/plugins/place`.
2. **Opus, the Places side:** §3 and §4. Use the prototype as the visual
   reference, and screenshot-compare it against the deployed build.
3. **Me:** review the diff against the merge-base, run `./equin build`, drive the
   flow (page → Open in Places → overlay, Save, Save all, Undo, ×), then report.

## Verification

- **Unit tests:**
  - `locatedPlaces`;
  - `joinPageOverlay` (order and numbering, matching saved places, non-Google
    and unplaced blocks counted);
  - `placesByGoogleId`.
  - Run `./equin test` on the touched plugins.
- **`./equin check`**, all checks: boundaries, plugin boundaries, type-check,
  lint (DataView rule, no pending collapse) and the docs being in sync.
- **`./equin build`**, then with `browser_*` on this worktree's build:
  - Open a page with place blocks (seed one in the worktree DB, through the page
    editor in this build) and click **Open in Places**. Confirm the map frames
    the page's places, the numbered and ghost pins, the dimmed others, and the
    panel.
  - Click a ghost pin. Confirm the Google card shows photos and hours, then Save
    it: it turns into a saved pin with a number, and the row shows ✓ Saved.
  - Click Undo, then **Save all**, then Undo.
  - Edit the page in another tab (add or remove a place) and confirm the overlay
    updates live.
  - Click ×: you are back on `/places` and the layer is gone.
- **Prototype comparison.** Screenshots of the panel and pins next to
  `proto-1793376812-x39bpd` (`?overlay-tpin=ghost`).
