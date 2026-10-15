# Places — the Poster place card, with Google's rich details

Mockup: `proto-1791725279-9yramg` at `card=poster` (`#p21` photos, `#p4` no photos).

## Context

The place card (`places-map/web/components/place-card.tsx`) is a plain stack of
captions and sections. The user picked the prototype's **Poster** direction and
wants richer facts on it: Google photos, opening hours (open now), rating,
review count, price level, phone, website, Google's one-line description.

None of that is stored: `Place` has no such fields, and
`PLACE_DETAILS_FIELD_MASK` is deliberately Essentials + Pro only (those fields
are Enterprise tier, ~2× per call). Google's terms forbid caching most Places
content long-term, so the rich details are **fetched when a card opens and
cached server-side for 24 h** — never written to the `places` table. Photos go
through a server proxy (the Places key is server-only).

## Design

### 1. `places-api` — a second, separately priced details call

`plugins/integrations/plugins/google-maps/plugins/places-api`

- `server/internal/field-mask.ts`: add `PLACE_RICH_DETAILS_FIELD_MASK` =
  `id, photos, regularOpeningHours, utcOffsetMinutes, rating, userRatingCount,
  priceLevel, internationalPhoneNumber, websiteUri, editorialSummary`. Its
  comment carries the tier table (Enterprise). `PLACE_DETAILS_FIELD_MASK` is
  untouched — save and the monthly refresh keep the cheap price.
- `server/internal/rich-details.ts`: `placeRichDetails(apiKey, placeId):
  Promise<PlaceRichDetails>` via the existing `placesFetch`, mapping Google's
  shape to a neutral one (every field optional, since Google omits what it
  lacks).
- `server/internal/photo.ts`: `placePhoto(apiKey, photoName, maxWidthPx):
  Promise<Response>` — the raw `GET /v1/{photoName}/media` with the
  `X-Goog-Api-Key` header (never `?key=`). It throws `PlacesApiError` on a
  non-2xx response.
- `core/internal/types.ts`: `PlaceRichDetailsSchema`:
  - `photos[]`: `{ name, widthPx, heightPx, authors: {name, uri?}[] }`, at most 10.
  - `hours?`: `{ periods: {open:{day,hour,minute}, close?:{…}}[], weekdayDescriptions: string[] }`.
  - `utcOffsetMinutes?`
  - `rating?`, `ratingCount?`
  - `priceLevel?`: 0–4 (mapped from `PRICE_LEVEL_*`).
  - `phone?`, `website?`, `summary?`

  Also add `PHOTO_NAME_PATTERN` (`^places/[^/]+/photos/[^/]+$`).
- Pure, tested `openState(hours, utcOffsetMinutes, now)` → `{ kind:
  "open"|"closing-soon"|"closed"|"always-open", until?: {day, hour, minute} }`.
  - It runs on the client, so "open now" stays true even though the weekly hours it reads were fetched up to 24 h earlier.
  - It computes in the place's own clock (from `utcOffsetMinutes`).
  - It handles ranges that cross midnight, 24/7 places (one period with no close), and places with no hours.
  - It lives in `core` because it is pure and the web needs it.
- Update the plugin's CLAUDE.md section "The field mask is a cost decision".

### 2. New sub-plugin `places/plugins/place-details`

This keeps the Enterprise-priced, uncached-by-design data out of `places-core`
(the persistent entity layer).

- **core**
  - `placeDetails = liveValue("places.details", { schema:
    PlaceDetailsResultSchema, query: { googlePlaceId }, load: "on-demand" })`.
  - The result is a union:
    - `{ kind: "ok", details }`
    - `maps-not-configured`: reuse `MapsNotConfiguredSchema`, which needs exporting from `places-core/core/index.ts` first.
    - `{ kind: "unavailable", reason }`: Google refused this place id (a `PlacesApiError` 404/400). It is in-band, so the card still renders without the rich facts. Any other error throws, and the card shows a `ResourceErrorInline`.
  - `placePhoto = defineEndpoint({ route: "GET /api/places/photo", query: { name, w }, response: blob() })`. This follows the wallpaper image endpoint precedent (`apps-core/.../wallpaper/core/endpoints.ts`).
- **server**
  - `details-cache.ts`: `Map<googlePlaceId, { at, value }>` with a 24 h TTL, plus `createInflight()` (`packages/inflight`) so concurrent opens share one call.
    - Only `ok` and `unavailable` results are cached.
    - It is in memory, per backend. A restart costs one call per place re-opened, which is acceptable.
    - The loader takes `getMapsKey()`, then calls `placeRichDetails`.
  - `serveValue(placeDetails, { source: "external", changes: { fixed: { reason } }, loader })`. This mirrors `placeSearchServed`, and the reason names the 24 h server cache.
  - `handle-photo.ts`:
    - Validates `name` against `PHOTO_NAME_PATTERN` and clamps `w` to 200–1600.
    - Calls `getMapsKey()`, then `placePhoto`, and streams the body back with Google's content type and `cache-control: private, max-age=86400`. The router defaults responses to `no-store`, so the handler must set this itself.
    - A 4xx from Google is passed through as a 404 (the photo's name expired). The card then simply drops that image.
- **web**: `usePlaceDetails(googlePlaceId | null)` = `useLive(placeDetails, …)`, and `placePhotoUrl(name, width)`.
- It needs a `package.json` and a CLAUDE.md covering the ToS / 24 h rationale, how open-now is computed, and the photo proxy.

### 3. The card (`places-map/web/components/`)

`place-card.tsx` is split by region. It keeps the `PlaceCard` props and the
exported `PLACE_CARD_WIDTH`. It reads `usePlaceDetails(place.googlePlaceId)`,
which is `null` for a custom place.

- **`place-hero.tsx`**
  - **Photos**: a horizontal scroll-snap strip of `<img>` (`Scroll axis="x"` or `scrollClasses` plus `snap-x snap-mandatory`).
    - A "1 / n" counter.
    - Previous/next `IconButton`s, shown on hover.
    - The current photo's author credit, linked to the author's page, as Google's terms require.
    - Images after the first are lazy-loaded.
  - **No photos** (a custom place, `unavailable`, or none returned): the wash, a gradient of `visual.colors` through `paleTint`-style `color-mix`, with the place's icon as a large faint watermark.
  - **While details load** (a Google place): a hero-height placeholder from `primitives/loading`, never the wash, so the hero never swaps from wash to photo once the data arrives.
  - The scaled `PlaceDropHead` overlaps the hero's foot, as it does today, but positioned over the edge.
- **Head**
  - `PlaceTitleInput`, unchanged in behaviour, using `Text` role `title`.
  - "On Google: …" under it when the place has a user title.
  - Type · city, with the place icon.
  - The rating line (rating, `star` icons, count compacted, price level).
  - The open-now line: a coloured dot, "Open · closes 22:30" / "Closes soon" / "Closed · opens Tue 09:00". It re-derives on the minute through an existing clock hook if one exists; otherwise it is computed at render, since the card re-renders often.
  - The closed-permanently / closed-temporarily pill, which replaces the open-now line.
  - While details load, the facts lines render a `Loading` placeholder, not an absence.
- **Body**
  - The summary paragraph.
  - Want to go / Been: two large toggle buttons, each tinted with its role tag's colour when on. They write the same `tags` PATCH as today.
  - Tags: `TagChip` gains a tinted pill look (the tag colour through `style`, as TagMark does), with AUTO shown as a small ✨ icon. The × on hover stays.
  - The note `Textarea` (`aria-label="Note"`, which the e2e script depends on), styled as the warm slip.
- **Info rows** (`Line` + `Icon` + `Fill Text` + action):
  - Hours: a `Collapsible` that folds out the week from `weekdayDescriptions`, today in bold.
  - Address: with a `CopyButton`.
  - Phone: a `tel:` link plus a `CopyButton`.
  - Website: a link.
  - Saved date, with the Google type underneath.
  - Icon by Haiku: with Regenerate / Pick one.
  - A faint "Photos, hours and rating from Google" line when rich details are shown.
  - A `maps-not-configured` result shows `MapsAccessAction` in place of the facts.
- **Footer** (`Column` footer, so it is always visible):
  - Open in Google Maps (a primary button filled with `washInk(mainColor)`).
  - Directions (`https://www.google.com/maps/dir/?api=1&destination=…&destination_place_id=…`).
  - Delete (the existing `confirmDialog`).
- **Height**: the card hugs its content. `places-screen.tsx` gives the `Pin` a `max-height` down to the screen's bottom gap, and the card's body scrolls (`Column` body).
- All styling goes through primitives:
  - `Surface`, `Column`, `Line`, `Cluster`, `Stack`, `Text` roles, radius tokens.
  - Inline `style` only for data colours: gradients, tints, the watermark colour.
  - No raw layout or typography classes, per the `no-adhoc-*` lints.

## Files

- `plugins/integrations/plugins/google-maps/plugins/places-api/{core/internal/types.ts, core/internal/open-state.ts(+test), server/internal/{field-mask,rich-details,photo}.ts, server/index.ts, core/index.ts, CLAUDE.md}`
- `plugins/apps/plugins/places/plugins/place-details/` (new: core, server, web, package.json, CLAUDE.md)
- `plugins/apps/plugins/places/plugins/places-core/core/index.ts`: export `MapsNotConfiguredSchema`.
- `plugins/apps/plugins/places/plugins/places-map/web/components/{place-card.tsx, place-hero.tsx (new), place-facts.tsx (new), tag-chip.tsx, places-screen.tsx}` and its CLAUDE.md "The place card" section.

## Verification

- `./singularity test plugins/integrations/plugins/google-maps/plugins/places-api` covers:
  - `openState`: open, closing soon, closed, ranges past midnight, 24/7, no hours, the place's timezone ≠ the browser's.
  - The rich-details mapping from a recorded Google response fixture.
  - The photo-name validation.
- A test for the details cache: TTL hit and miss, concurrent calls collapsed into one, `ok` / `unavailable` cached, a thrown error not cached.
- `./singularity build` (checks pass), then
  `./singularity run plugins/apps/plugins/places/plugins/places-map/e2e/open-card.ts --place "<name>"`
  on a famous place (photos, hours) and on a custom pin (the wash, no rich facts). Compare the screenshots against the prototype at `card=poster`.
- Check `~/.singularity/worktrees/<wt>/logs/` for Places API errors, and that reopening the card makes no second Google call. Log one line per fetch on the `places-details` channel.
- **Cost note**: each first open of a place's card in a 24 h window is one Enterprise Place Details call, plus one Place Photo call per photo viewed (photos are then cached by the browser for 24 h). Every worktree has its own in-memory cache.
