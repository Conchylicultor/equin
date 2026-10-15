# Places — Mapstr import, Been / Want to go, closed places, price ramp

## Context

The user's real saved places live in Mapstr (export: `~/Downloads/mapstr.zip` →
`mapstr.csv` + `mapstr.geojson`, 968 places, 2020-09 → 2026-09, ~280 France /
~230 Berlin / a few DK, US). The Places app currently holds placeholder data; it
is **fully replaced** by the Mapstr data.

What the export carries: name, address, coordinates (GeoJSON only), `icon`
(77 Mapstr icon names), `userComment` (740, multi-line), `date` (saved at),
`tags` (24 flat names, `/` = nesting, one colour each), `rating` (7 — dropped),
`photos` (0 — dropped). **No Google place id.**

Decisions taken with the user:

- **Status = two independent tags, Been and Want to go** (Mapstr's `.Done` /
  `.Todo`, renamed). Either, both or neither may be set: "both" = been and want
  to go back (Louvre, Panthéon dome…), "neither" = a plain pin (Home, Track,
  closed places). The exclusive Todo/Done status is **removed** from the app.
- **Pin paint: solid iff Want to go** (the app reads as a checklist — what is
  still to do is vivid, the rest pale): Want → solid, Both → solid, Been →
  pale, Neither → pale. **No Been mark on the pin for now.** Validated as the
  `status: been-want` variant of the Places map prototype.
- **Dated visits list: later** (follow-up task) — Mapstr has no visit dates.
- **Permanently closed** read from Google (`businessStatus`), on top of the
  user's own `Permanently closed` tag (kept).
- **Tag tree replaced by Mapstr's**, recoloured from the app palette; `To Try`
  ignored; `Recommended by` removed (notes keep the "Reco X" text); price tags
  grouped under **Price** with a cheap → expensive colour ramp.
- **Auto-tagging from Google types kept**, re-declared on the new tree.
- **Unmatched places** (no Google match): the importer lists them for the user
  to decide; nothing is decided up front.

## 1. Prototype variant (first, no build)

`~/.singularity/apps/prototypes/proto-1791725279-9yramg/index.html` ("Places
map") already declares `status: pin-style | tag-slice`. Add a third value,
`been-want`:

- Data: `STATUS` → two independent tags `want` / `been`; in `data.js` give a
  few places both / neither.
- Pin: solid fill when `want`, the existing pale wash (`TODO_WASH`, dark ink)
  otherwise. No Been badge (tried, dropped). Cluster: `✓ n` counts Been.
- Card / list: two toggles (Want to go, Been) instead of the Todo/Done segment.

Read `prototypes/CLAUDE.md` (Options) before editing. Validate with the user
before porting to the app.

## 2. Status model: Been / Want to go (places-core)

Keep "find a tag by role" (pin paint must not key off a name), drop exclusivity.

- `core/internal/tag-tree.ts`: `TAG_ROLES = ["been", "want"]`; delete
  `PLACE_STATUSES`, `placeStatus`, `withPlaceStatus`, `statusTagIds`. Add
  `placeFlags(place, tags) → { been: boolean; want: boolean }` (via
  `tagIdByRole`, which may return none — the tags are deletable-protected but a
  missing role is a loud error only where it is required). `isStatusTag` →
  `isRoleTag` (role ≠ null; no `status` parent any more). `ringColors` keeps
  excluding role tags.
- `core/internal/fields.ts`: drop the "always holds the todo or done tag"
  invariant comment; `role` stays `nullable(enumTextField(TAG_ROLES))`.
- `core/internal/endpoints.ts`: `UpdatePlaceBodySchema` loses `status`; Been /
  Want are toggled through `tags` like any tag. `SavePlace` comment: a new place
  gets its auto tags **+ Want to go**.
- `server/internal/tag-edits.ts`: remove the both-refused / re-add-status rules;
  keep unknown-id rejection and `autoTags ⊆ tags`.
- `server/internal/places-repo.ts` `savePlace`: `tags: [...autoTags, wantId]`.
- `server/internal/tags-repo.ts`: role tags stay undeletable.
- Migration: none for columns (`role` text enum widens/changes values only —
  check `enumTextField` emits a CHECK; if so `./singularity build` regenerates).
  Existing rows are wiped by the import (§5), so no data migration.
- Tests: rewrite `tag-tree.test.ts` role/status cases, `tag-edits.test.ts`,
  `seed-tags.test.ts` (each role held by exactly one seed tag),
  `places-map/web/internal/sidebar-filter.test.ts` fixtures.

## 3. UI (places-map, tag-manager) — port of the validated variant

- `places-map/web/internal/place-visual.ts`: `status` → `{ been, want }` on
  `PlaceVisual` / `MapPin.data`.
- `components/place-drop.tsx` + `internal/pin-paint.ts`: wash + `todoInk` when
  `!want` (today's todo look), solid + white icon when `want`. No Been mark. `saved-place-pin.tsx` ground shadow `opacity-60` keyed on `!want`.
- `components/place-glyph.tsx`: `PlaceGlyph` pale when `!want`; `PlaceCover`
  badge shows "Want to go" / "✓ Been" (both possible, or none).
- `components/saved-place-cluster.tsx` + `clusterRing`: the `✓ n` counts Been.
- `components/place-card.tsx`: replace the Todo/Done segment with two toggles
  (Want to go, Been) patching `tags`.
- `internal/fields.tsx`: replace the derived `status` column with two boolean
  columns `want` / `been` (filterable, groupable).
- `tag-chip.tsx`, `tag-picker.tsx`: exclude role tags (renamed predicate).
- `tag-manager-panel.tsx`: `deletable = role === null` (unchanged).

## 4. Closed places from Google

- `integrations/google-maps/plugins/places-api`: add `businessStatus` to
  `PLACE_DETAILS_FIELD_MASK` (`field-mask.ts`) — a **Pro**-SKU field, same tier
  as `primaryType` already requested, so no price change (verify against the
  current SKU table in the file comment). `PlaceSnapshotSchema`:
  `businessStatus: z.enum(["OPERATIONAL","CLOSED_TEMPORARILY","CLOSED_PERMANENTLY"]).optional()`.
- `places-core/core/internal/fields.ts`: new `businessStatus` nullable enum
  column (`touchedBy: true`); `savePlace` writes it.
- Freshness: a `defineJob` with a schedule (monthly) re-fetching details for
  places whose `fetchedAt` is older than 30 days, updating `businessStatus` /
  `types` / `fetchedAt` (no in-process timer). ~1k Pro calls/month — inside the
  free monthly cap.
- UI: `CLOSED_PERMANENTLY` → grey pin (greyscale fill, no badge) and a
  "Permanently closed" line on the card; `CLOSED_TEMPORARILY` → a muted
  "Temporarily closed" line. A `closed` filterable field in `fields.tsx`.

## 5. Tag tree (replaces `server/internal/seed-tags.ts`)

The seed becomes this tree (fresh installs get it; the import (§6) wipes and
re-seeds). Children with no colour inherit the parent's (`tagColor`).

| Tag | Role | Colour | Google types (auto-tag) |
|---|---|---|---|
| **Want to go** | `want` | `#94a3b8` | — |
| **Been** | `been` | `#22c55e` | — |
| **Food** › Restaurant, Bar, Fast-food, Snacks | | `#f97316` | `restaurant` · `bar`, `pub`, `wine_bar` · `fast_food_restaurant` · `cafe`, `coffee_shop`, `bakery`, `ice_cream_shop` |
| **Museum** › Art, History, Science, Autre | | `#3b82f6` | `museum` on the parent · `art_gallery`, `art_museum` · `history_museum` · — · — |
| **Attraction** | | `#14b8a6` | `tourist_attraction`, `amusement_park` |
| **Extérieur** | | `#16a34a` | `park`, `hiking_area`, `national_park`, `beach` |
| **Jeux/Shows/Events** (name as in Mapstr) | | `#6366f1` | `performing_arts_theater`, `concert_hall`, `movie_theater`, `bowling_alley` |
| **Club** | | `#ec4899` | `night_club` |
| **Shop** | | `#a16207` | `store`, `book_store`, `shopping_mall` |
| **Area** | | `#84cc16` | — |
| **Planifier** | | `#a855f7` | — |
| **Price** › 40€, 100+€ | | `#eab308` ramp | — |
| **Permanently closed** | | `#78716c` | — |
| **Track** / **Home** / **Social** | | `#1e293b` / `#e11d48` / `#0ea5e9` | — |

The Google type list is a starting point; check each against Google's Table A
before seeding (types not in Table A never match).

### Price ramp — a tag-tree primitive, not two hand-picked hexes

Add `childColors: "ramp" | null` to `placeTagFields` (default null). When a
parent is `ramp`, `tagColor` gives its colourless children an ordered shade of
the parent colour by `rank`: child *i* of *n* =
`mix(parent, white→black, t = i/(n-1))` from light (cheap, first) to deep
(expensive, last), computed as hex in `core` (tiles do not follow the theme).
Adding a `20€` child between them re-spreads automatically; the same works for
any future ordered group. Tag manager: a "Shade children" toggle on a parent row.

## 6. Importer — `./singularity places import-mapstr <path>`

A `cli/` verb on places-core (`defineCliCommand` + `runExec`, the
`infra/audio-analysis/cli` pattern), so it runs with the worktree's DB, config
and Maps key. Default target: this checkout's DB. Pointing it at main is the
user's call when the result is reviewed.

**Phase A — match (default, read-only on the DB):**

1. Read `mapstr.zip` (or the extracted folder): CSV for `date`, GeoJSON for
   coordinates; join by row order + name (assert they agree).
2. For each place, Google **Text Search (New)** with an IDs-only field mask
   (`places.id,places.displayName,places.location`) — free SKU — query
   `"<name>, <address>"`, `locationBias` circle (Mapstr coords, 250 m). Add a
   `searchText(apiKey, query, bias)` to `places-api` beside `autocomplete`.
3. Accept the top hit if it is within 150 m **and** its name is similar
   (normalised token overlap); otherwise *unmatched*. Duplicate Google ids
   across Mapstr rows (e.g. `Umami`, `Wen Cheng`) → reported, first kept.
4. Write `mapstr-matches.json` (Mapstr row → Google id | unmatched + reason)
   next to the input and print a summary + **the unmatched list** — shown to
   the user to decide (fix by hand in the JSON, drop, or a later custom-pin
   feature).

**Phase B — `--apply` (reads the matches file, never re-searches):**

1. One transaction: delete all `places` and `place_tags`; insert the §5 tree.
2. For each matched place: `placeDetails` (Pro; ~1k calls), then insert with
   the Google snapshot (name/address/location/types/mapsUrl/businessStatus),
   `note = userComment`, `createdAt = date`, `tags` = Mapstr tags mapped by
   name to the new tree (deduped; `.Done` → Been, `.Todo` → Want to go,
   `To Try` dropped), `autoTags = []` (every tag was the user's choice),
   `icon = null`. Insert through a server function factored out of `savePlace`
   (`insertPlace(snapshot, extras)`) so both paths share one insert.
3. Enqueue `placeIconJob` per place (serial Haiku, ~1h for 968 — fine; verify
   the enqueue from an exec child lands in the shared queue).
4. Unmatched rows are not inserted; the report lists them.

## 7. Follow-ups (tasks, not this change)

- Dated visits list (Been derived from / set by "Mark visited").
- Custom pins (places with no Google id) — if the unmatched list warrants it.

## Verification

- `./singularity test plugins/apps/plugins/places` — rewritten tag-tree,
  tag-edits, seed-tags, sidebar-filter, pin-paint tests; new tests for
  `placeFlags`, the ramp in `tagColor`, the Mapstr tag mapping and the match
  scorer (pure functions, fed rows from the real CSV).
- Prototype: flip `status: been-want` and confirm the four pin states.
- `./singularity build`, then `./singularity places import-mapstr ~/Downloads/mapstr.zip`
  (phase A) → review counts + unmatched list with the user → `--apply`.
- `query_db`: 968 − unmatched places; tag counts match the CSV profile
  (Been 565, Want to go 401, Food/Restaurant 206…, minus unmatched); `created_at` spans
  2020-09 → 2026-09; `business_status` set.
- Screenshot `/places` (e2e `screenshot.ts`): pale vs vivid pins, ✓ badges,
  Price chips in two yellows, the 3 closed places grey; `places-map/e2e/tour.ts`
  still passes.

## Addendum (2026-10-14) — titles, custom places, three override kinds

Asked after phase A's review: a Google place shown under the user's own name
("Japantown" for Google's "Rue Sainte-Anne"), and pins for what Google has no
place for (the bunker, closed venues, one-off events kept as memories).

- **Title** — `places.title` (nullable). `placeName(place)` (places-core core)
  = `title ?? name` is the one derivation: pin labels, card, DataView name
  field (search reads title AND Google's name), delete dialog, Haiku's icon
  prompt (with Google's name beside it). `name` stays Google's and is now
  re-fetched by `places.refresh-details` (`refreshedColumns`); the title is
  never touched by it. The card's name is edited in place; clearing it (or
  typing Google's name) stores null, and "On Google: <name>" shows under a
  title.
- **Custom place** — `google_place_id` nullable (the unique index still holds
  for non-null ids). Not a discriminated column type — the field/entity system
  derives one flat row — so the pairing is held by a CHECK,
  `places_custom_no_google`: no Google id ⇒ no title, primary type, maps URL,
  business status, and empty types. Writes go through `insertPlace(NewPlace)`,
  `NewPlace = {kind:"google", snapshot, title?} | {kind:"custom", name,
  address, lat, lng}`. The refresh job selects `google_place_id IS NOT NULL`;
  "Open in Google Maps" opens a custom place at its coordinates; the Haiku icon
  job reads the name with no types (it picks fine: `push_pin`, a theatre mask…).
  `PATCH` takes `title` (a custom place's name) and `location` (custom only).
- **UI** — Add place › *Drop a custom pin* (the typed text seeds the name), and
  a custom place's card › *Move*, put the map in **pick mode**: a new optional
  `pick` on the map primitive (`MapView` / `MapRendererProps`, the data-view
  map's `MapViewOptions`), crosshair cursor, the next map click reports a
  `LatLng`. The Google renderer holds its re-framing after a pick so the view
  stays where the user clicked. `entities`' `indexes` callback now also accepts
  `check(…)` builders.
- **Importer overrides** are three strict shapes (`matches-file.ts`):
  `{index, googlePlaceId, title?, note?}`, `{index, custom: {name, lat?, lng?},
  note?}` (pin defaults to the Mapstr one), `{index, discard: true, reason}`.
  `--apply` still refuses an unmatched row with no override, lists every
  discarded row with its reason, never merges custom places (they keep the
  Mapstr address), and skips the "Saved in Mapstr as …" note line when the
  place has a title or is custom.
- Migration `20261014_212748_fa2b8e7c__places_custom_titles` (schema only; no
  data migration — every existing row has a Google id). Verified by
  `places-map/e2e/custom-pin.ts` (title set/cleared on a pin + card; custom pin
  dropped, moved, deleted; data left as found).
