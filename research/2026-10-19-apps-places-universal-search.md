# Places — universal search bar ("Search or add places")

Track: page `block-ef922c48-b280-4db9-861a-f60d99c7c5b2` (Universal search). Task:
task-1792363522-l6c0ku. Prototype: `proto-1791725279-9yramg`, `gpin: ghost`.
Ask Sonnet is out of scope; it gets its own task.

## Context

Places has two entry points today:

- The DataView's search field (`searchPlaceholder="Search places"`). It filters saved places only.
- `AddPlaceButton` (`places-map/web/components/add-place.tsx`). This is a popover over Google **Autocomplete** (`placeSearch` in places-core). Autocomplete returns names only.

The goal is one bar that does three things at once:

- It filters your places and their pins live.
- It shows Google results as rich cards with Save, updated live and biased to the map area.
- It draws each Google result as a ghost pin. The ghost pin is hover-linked both ways with its card, and the camera never moves.

## What the prototype specifies (gpin: ghost)

**The bar**
- It sits in the top-right tools card. The placeholder is "Search or add places" and the bar is about 340px wide.
- `/` focuses it from anywhere. An × clears it.

**The panel**
- A panel about 410px wide sits under the bar. It opens on focus.
- It closes on Esc, on an outside mousedown, on a click on empty map, and on opening a saved place.
- Closing it keeps the query, so the filter and the ghost pins stay.

**Your places section**
- Header: `YOUR PLACES <n> · filtered on the map`.
- At most 4 rows, each with glyph, name, "city · tags" and a Been/Want badge.
- Then "+N more on the map", or "None of your places match."
- A click on a row closes the panel and selects the place, which opens its card.

**Google section**
- Header: `GOOGLE <n|spinner> · around this map area`.
- 5 cards, then "Show N more".
- Two skeleton cards while loading with nothing to show yet.
- Empty state: "No Google results here — pan the map to search elsewhere."

**Card anatomy**
- A 60px thumbnail tinted with the category colour, with its icon.
- The name.
- `4.5 ★★★★★ (3.1k) · €€`.
- `Type · address`.
- Open line: green when open, amber when closing soon, red when closed.
- An "off the map" tag when the result lies outside the view.
- A Save pill at top-right. An already-saved result shows a green `✓ Saved` pill, and clicking it opens the saved place.

**Save**
- Tags the place `[auto-tag from Google type, Want to go]`.
- Shows a toast, "Saved X · tagged …", with Undo.
- Does **not** select the place, keeps the panel open and leaves the camera where it is.
- The ghost pin turns into the real pin.

**Ghost pin**
- A 28px circle, 92% white, with a 2px dashed border in the category colour (darkened) and the category icon.
- Its name label shows on hover only.
- Card hover lifts the pin: it grows 1.3×, the border turns solid and the label shows. Pin hover highlights the card.
- A click on the pin opens the panel and scrolls its card into view.
- Already-saved results get no ghost pin, because the real pin is already there.

**Live updates**
- Google is asked at 2 or more characters, debounced about 260ms.
- It is asked again when the camera comes to rest after a pan or zoom.
- Results inside the view sort first.

## Design

### 1. Google rich search (server + contract)

**`integrations/google-maps/places-api`: extend `searchText`**
- Add a `detail: "basic" | "rich"` option. `basic` is today's Pro mask, which the Mapstr import keeps.
- `rich` adds the Enterprise fields:
  - `rating`, `userRatingCount`, `priceLevel` (the enum mapped to 0–4, matching `PlaceRichDetails`)
  - `primaryType`, `primaryTypeDisplayName`
  - `currentOpeningHours`, `utcOffsetMinutes`
- It returns a `PlaceSearchResult`: a `PlaceCandidate` plus those optional facts.
- `SearchTextBias` gains a `rectangle: {low, high}` arm next to `circle`.
- Tested against canned responses: the mask, the bias wire shape and the price mapping.

**places-core: replace `placeSearch`**
- The Autocomplete value is replaced by `placeGoogleSearch`, a `liveValue("places.google-search")`.
- Its query is `{ q, bias: MapBounds }`. Its result is `{kind:"ok", results} | {kind:"maps-not-configured"}`.
- It is served `source: "external"` like today, through `searchText(key, q, { detail: "rich", bias: rectangle, maxResults: 20 })`.
- The web hook is `usePlaceGoogleSearch(query | null)`.
- `placeSearch` and `usePlaceSearch` are deleted. `add-place.tsx` was their only consumer.
- `autocomplete` stays in places-api, because `page/place/google` uses it.

**`savePlace`**
- `session` becomes optional. Text Search has no session tokens, and the save's details fetch then stands alone.
- Otherwise it is unchanged: `autoTagsFor(types)` plus Want to go, and `already-saved` is idempotent.

**Cost**
- This makes every debounced keystroke and every camera rest one Text Search Enterprise call. Autocomplete was nearly free.
- It is the only API that returns rating, price and open-now in one call. Autocomplete followed by details for each result would cost more.
- Guards against extra calls:
  - at least 2 characters;
  - a 300ms debounce;
  - the bias quantised to about 3 decimals, so a sub-pixel settle is the same query;
  - the live runtime dedups identical params.

### 1b. Quota ledger + downgrade ladder (stay inside Google's free tiers)

Google's API does not report how much of the free allowance is left. Cloud Billing does, but it lags by hours and needs extra credentials. Since there is one instance per user, this app is effectively the only caller of the key, so it **counts its own calls**.

**New sub-plugin: `integrations/google-maps/plugins/usage`**

- **Table `google_maps_usage`:** `(month, sku) → count`.
  - `month` is the billing month in **Pacific time**, computed with `packages/wall-clock`.
  - Increments are an atomic upsert.
- **Server API:**
  - `recordCall(sku)`
  - `monthUsage(sku)`, which returns `{ count, freeCap, budget }`
- **Config:** a `config_v2` handle holds each SKU's free cap and safety margin. The defaults are 1,000 / 50 for the Enterprise tier, 5,000 / 200 for Pro and 10,000 / 500 for Essentials (including Autocomplete), editable in Settings → Config.

**Every Google call is metered by construction.**
- places-api's request layer takes a required `meter: GoogleUsageMeter`, an interface declared in places-api `core`.
- The SKU is derived from the endpoint plus the field mask it sends, by `skuFor(endpoint, mask)`. It is the highest tier among the requested fields, which is how Google bills.
- A call site therefore cannot forget to record, and cannot record the wrong tier (tsc enforces it).
- Covered calls: `searchText`, `autocomplete`, `placeDetails` (on save), rich details (on card open), photos, and page/place's provider.
- The Mapstr CLI import gets a meter that writes the same table through its DB connection.

**The ladder: the search loader in places-core picks a tier per query.**

| Rung | When | What the card shows |
|---|---|---|
| `rich` | Text Search Enterprise usage < budget | Rating, review count, price, type, address, open-now, ghost pins |
| `basic` | Text Search Pro usage < budget | Name, type, address, icon thumbnail, ghost pins (Pro still has location) |
| `names` | Otherwise (Autocomplete) | Name + second line; no ghost pins; Save uses a session token, so the session is billed as one |

- The result carries `tier`.
- The Google section header states a downgrade and never hides it: "Ratings paused until Nov 1 · free Google quota used", or "Names only until Nov 1".
- `savePlace` keeps an optional `session` for the `names` rung.

**Out of this task (follow-up)**
- Downgrading the place card's rich details when its own Enterprise budget is spent. Those calls are already recorded by the ledger.
- A usage readout in the Google Maps settings.

**Also recommended:** a daily quota cap on the Places API in the Google Cloud console, as a hard stop if the counter ever breaks. That is the user's action; the plan does not do it.

### 2. Map primitive: non-row overlays, controlled hover, bounds

These are generic additions, written so that a future "proposal pins" consumer (Ask Sonnet's picks) reuses them.

**`MapOverlay` gets `frame?: false`**
- An overlay marked this way is never part of the camera's framing: neither the one-time first fit (`FitCamera`) nor the Fit control.
- So ghost pins cannot move the camera, even on a first visit with zero saved places.
- This is the structural guarantee behind "never moves the camera", and it does not rely on `cameraKey` happening to be set.

**`MapRendererProps` and `MapView` get `hoveredId` + `onHoverChange(id | null)`**
- `pin-canvas`'s internal hover becomes the union of the pointer hover and the external `hoveredId`. That pin is lifted to the DOM exactly as on pointer hover.
- Pointer hover changes are reported out.

**`onCameraRest` reports bounds**
- The report becomes `{ center, zoom, bounds: MapBounds }`. The Google renderer reads `map.getBounds()`.
- It is exposed on `MapView` next to the internal `cameraKey` draft write.

**data-view/map `MapViewOptions` gains:**
- `overlays?: { items: readonly MapOverlay[]; onActivate: (id) => void }`. These are extra, non-row overlays, merged after the row pins. A click on one routes to its own handler, never to `onRowActivate`.
- `hoveredId?`, `onHoverChange?`, and `onCameraRest?` (passed through).

### 3. DataView search with suggestions

**`DataViewSearch` gains `suggestions?: ReactNode`**
- The toolbar's search field renders it in an anchored, non-modal panel under the field.
- The panel opens on focus or on a non-empty query. It closes on Esc and on an outside pointerdown. Focus stays in the input.
- ArrowDown moves into the panel's first focusable element.
- It works in the floating arrangement and the compact fold. The suggestions are portalled, so they are not clipped by the card.

**Panel state**
- `DataViewSearch` also gains `wide?: boolean` (a 340px field) and an `open` / `onOpenChange` pair, so the host can open the panel from outside (a ghost-pin click) and close it (picking a saved place).
- This replaces the bespoke popover pattern. Any DataView can offer "search or create" suggestions this way.

**`/` shortcut.** A surface shortcut, `places.focus-search`, uses the existing `focusSearch` part of the toolbar.

### 4. Places UI (places-map)

**`places-screen.tsx`**
- It owns `query` and passes `search={{ query, onQueryChange, suggestions: <UniversalSearchPanel/>, wide, open, onOpenChange }}`.
- It drops `actions={<AddPlaceButton/>}` and `searchPlaceholder` becomes "Search or add places".
- It holds `bounds`, from `viewOptions.map.onCameraRest`.
- It holds `hoveredGoogleId`, shared by the cards and the ghost pins.
- It reads `usePlaceGoogleSearch(q.length >= 2 ? { q, bias: quantise(bounds) } : null)` and keeps the last ok answer shown while the next one loads, with the spinner in the section header.
- It feeds the not-yet-saved results to `viewOptions.map.overlays` as `pinType: "places.google-result"` with `frame: false`.
- The empty-state copy becomes "No places yet — search above to find and save one."

**`web/components/universal-search.tsx`** (new): the panel's two sections and the footer.
- **Your places**
  - It shows the top 4 rows matching `placeSearchText` (the same accessor the DataView filters by), then the counts.
  - Rows use `PlaceGlyph`, the name, the city and tags, and a Been/Want badge.
  - These rows are transient chrome. `Row` + map gets the annotated `data-view/no-adhoc-row-list` disable, as Add place's rows did.
- **Google**
  - The section header comes first, then the cards (5, then "Show N more").
  - The states: loading skeletons, a `ResourceErrorInline` on error, and `MapsAccessAction` when Maps is not configured.
- **Footer row:** *Drop a custom pin*, moved from Add place and seeded with the query. Pick mode is unchanged.

**`web/components/google-result-card.tsx`** (new): the card described above.
- The tint and icon come from the place's would-be tags: `autoTagsFor(result.types, tags)` resolved like `placeVisual`, falling back to `location-on` and slate.
- It reuses the in-plugin `compactCount`, `openLine` (from `currentOpeningHours`) and the `place-facts` rating and price rendering. Those are lifted into pure helpers in `web/internal/place-facts.ts` so the card and the place card share them.
- "Saved" is decided from `Set(places.map(p => p.googlePlaceId))`.
- Save calls `savePlace({ googlePlaceId })`, then `showToast("Saved X · tagged …", action Undo → useDeletePlace)`.

**`web/components/google-result-pin.tsx`** (new): the `GeoMap.Pin` contribution for `places.google-result`.
- `mark` draws the dashed ghost disc as an SVG sprite.
- `component` draws the lifted version: solid border, 1.3×, and the `MapLabel` name.
- A click calls `overlays.onActivate`, which opens the panel and scrolls that card into view (`data-google-id` + `scrollIntoView({block:"nearest"})`).

**"Off the map" and ordering**
- Results are sorted in-view first, client-side from `bounds`.
- Out-of-view results get the tag.

**Delete** `add-place.tsx`, and update `places-map/CLAUDE.md` (replace the Add place section with "Universal search").

## Files

- `plugins/integrations/plugins/google-maps/plugins/places-api/server/internal/search-text.ts`, `core/internal/types.ts`
- `plugins/apps/plugins/places/plugins/places-core/{core/internal/maps.ts,resources.ts,endpoints.ts}`, `server/internal/{resources.ts,places-repo.ts}`, `web/internal/hooks.ts`
- `plugins/integrations/plugins/google-maps/plugins/usage/` (new: table, `recordCall` / `monthUsage`, config); places-api `server/internal/request.ts` + each endpoint (required `meter`, `skuFor`); call sites in places-core, place-details, page/place/google, mapstr-import
- `plugins/map/core/overlays.ts`, `plugins/map/web/{slots.ts,components/map-view.tsx}`, `plugins/map/plugins/pin-layer/web/internal/pin-canvas.tsx`, `plugins/map/plugins/google/web/components/google-map-impl.tsx` (FitCamera / FitControl skip `frame:false`; bounds on idle; external hover)
- `plugins/primitives/plugins/data-view/plugins/map/{core/internal/types.ts,web/components/map-data-view.tsx}`
- `plugins/primitives/plugins/data-view/core/internal/types.ts` (`DataViewSearch`), `web/components/toolbar/data-view-toolbar.tsx`, `plugins/floating-toolbar/web/internal/floating-toolbar.tsx`
- `plugins/apps/plugins/places/plugins/places-map/web/components/{places-screen,universal-search,google-result-card,google-result-pin}.tsx`, `web/internal/place-facts.ts`, `web/index.ts` (the new `GeoMap.Pin`), with `add-place.tsx` removed

## Verification

**Tests** (`./singularity test …`)
- Usage ledger and ladder:
  - `skuFor` maps each mask to the right tier.
  - The Pacific-time month boundary.
  - The ladder picks `rich` → `basic` → `names` as the counts cross the budgets (the loader is tested with a fake meter).
- places-api: the `searchText` rich mask, rectangle bias and price mapping.
- `place-facts`: the lifted rating and price helpers.
- data-view/map: an extra overlay's activation does not reach `onRowActivate`.
- map: `frame:false` overlays are excluded from the fit bounds (the pure part of `FitCamera`).

**`./singularity build`** with the checks green.

**e2e** (`places-map/e2e/`)
- Extend `camera-stays.ts`: type "ramen" after a user zoom, and the saved pins' screen positions are unchanged while ghost pins appear. Then clear it, and the ghosts are gone and the camera is still unmoved.
- New `universal-search.ts`:
  1. Type, and the Your places count matches the sidebar's `shown / total`.
  2. Google cards render with rating and open line.
  3. Hovering a card lifts its ghost pin, and hovering the pin highlights the card.
  4. Save shows the toast, the card turns Saved and the ghost turns into a saved pin.
  5. Undo removes it again.
  6. Pan the map, and the results refresh.
  7. Esc closes the panel and the filter stays.
  8. There is no "Add place" button.

**Screenshots** of the panel against the prototype at `gpin=ghost`, using `compare-diff.ts`.

**Track page:** tick the `[Places] Universal search bar` line, set the status to the next step (the embedded conversation view), and file that next task only if it is not already filed. It is already filed as task-1792363529-hu6prs, so no new task.
