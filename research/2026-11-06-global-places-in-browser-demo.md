# Places in the browser demo

Track: *apps running in the browser* (wiki `block-d04c6c0d-…`). Task: places-in-demo
(att-1793971798), supervised by conv-1793665695-3p52r4. Also closes the Places half of
task-1793831071-kiua0g (photo / thumbnail URLs hand-built in core).
Precedent: `research/2026-11-04-global-sonata-in-browser-demo.md`.

## Context

`/demo` runs the Agent Manager, Pages, Prototypes, Sonata, Home and the Desktop on their
real server code in a worker on PGlite. Places is not in it. User's decision (2026-11-06):
add it, with **Google Maps as a named exception** to the no-leak rule — only the map
(Google's JS and tiles), loaded with the owner's browser key the real Places app already
sends to this page. Search, save, details, photos, the icon pick and Ask need the computer
and say "not available". Scope: only `/demo`; `/website` and the real Places app unchanged.

## A. Server split (portable `server/` vs `machine/`)

| Plugin | Stays in `server/` (portable) | Moves to `machine/` | needsMachine (feature text) |
|---|---|---|---|
| `places/places-core` | tables, `places`/`placeTags` collections, tag tree, update / delete / createCustomPlace, `insertPlace`, `replaceAllPlaces`, the tag seed warm-up, the icon job (through a host service, below) | `savePlace`, `searchPlaces` + `places.search`, the refresh job, Regenerate, the Haiku picker | `savePlace` "Saving a place from Google"; `placeSearch` "Searching Google Places"; `regeneratePlaceIcon` "Picking a place's icon" |
| `places/place-details` | — | everything (details value, photo + thumbnail routes, disk cache) | `placeDetails`, `placePhoto`, `placeThumbnail` "Reading Google's details of a place" |
| `places/ask` | task category, `places.ask.candidates` collection | the scratch profile + its MCP tools | launching is already needsMachine (`useStartThread` availability) |
| `integrations/google-maps` | `google-maps.browser-config` served through a new host service `MapsBrowserConfigSource` | the file store + watcher (its provider), set/clear key and Map ID endpoints, `getPlacesClient` (auth/central) | set/clear endpoints "Setting up Google Maps" |

- **The icon pick is a host service** (`PlaceIconPicker`, declared in places-core/server):
  the job and the insert paths stay portable; `machine/` provides Haiku; a host provider
  sub-plugin `places-core/plugins/no-icon-picker` (one `server/index.ts`, like
  `task-title/filed-titles`) answers "no model here", so the pin keeps its main tag's icon.
- Debt exemptions deleted: `place-details` (thumbnail `node:fs`), `google-maps`
  (browser-config store/resource). No new exemption.

## B. The map key: a page-supplied host input

Rule 1 (the demo's code never reads the real server) stays absolute. The key reaches the
worker from the **page's chrome**, outside the scope:

- New `framework/browser-server/plugins/host-input`:
  - `core`: the worker-side store (`pageInput(value)`: `absent` | the page's latest value,
    with a change listener), fed by the port protocol: `hello` lists the keys the page
    supplies, `input` messages carry each value. Memory only — never in host storage, so
    never in the build-time snapshot (the snapshot is taken in Bun with no page at all).
  - `web`: the slot `HostInputs.Supply({ value: <liveValue> })` — a plugin declares that a
    page may hand this value of ITS OWN server to a browser host.
- `DemoScope` (page chrome; uses the page's registry and transport) reads every supply with
  `useLive` on the page's transport and posts it to the host's port. It names no plugin.
- `google-maps/web` contributes `HostInputs.Supply({ value: mapsBrowserConfig })`.
- Host provider `integrations/google-maps/plugins/page-config` (lone `server/index.ts`):
  `MapsBrowserConfigSource` from `pageInput(mapsBrowserConfig)` — `absent` → `unset`, so
  an instance without Maps shows the existing set-up state, whose writes are needsMachine.
- The Places key (server-only, auth/central) never moves; only the browser key does — the
  one the real app already sends to this page.

## C. Declared third-party hosts

- New `network/external-hosts` core: `defineExternalHosts({ hosts: ["…"], reason })`,
  literal hosts, read statically.
- Declared by the plugin that needs them: `map/google` (Maps JS + tiles + fonts), Sonata's
  `audio/piano` and `audio/soundfont` (smpldsnds.github.io, gleitz.github.io).
- `browser-host-gen` scans the scoped plugins' web/shared/core files and the graph's server
  modules, and emits `externalHosts` (host, plugin, reason) in `core/browser-host.generated.ts`.
- `no-leak.ts`: every off-origin request (page and worker) must go to a declared host; any
  undeclared one fails. Page-origin `/api` stays forbidden (telemetry aside), unchanged.

## D. Fixture writer + demo data

- New `apps/places/plugins/fixtures`: `core` — `PlacesFixture` (tags: nested, colours,
  icons; places: Google snapshot or custom, tags by fixture key, icon, note, saved date,
  ids the caller's); `server` (portable) — `writePlacesFixture` through the tag-tree
  engine's create write and `insertPlace` (gains an optional caller id), icons pre-written.
- Workspace demo: ~15 places in Lisbon (Demo planning a trip: Been / Want to go, Food ›
  Café / Bakery, Culture › Museum, Outdoors › Viewpoint, Nightlife), every id carrying
  `demo`; `bin/seed.ts` writes it, then settles.
- Composition `agent-manager-demo`: `apps.places.**` (map.** and integrations.google-maps.**
  come by closure).

## E. Web

- Photos and thumbnails: `AssetPath` over the transport (`useAssetSrc`), unavailable →
  the existing icon wash (place-hero, place-photos, place-glyph). `placePhotoUrl` /
  `placeThumbnailUrl` deleted.
- Each needsMachine read/endpoint renders its unavailable message (search bar, Save,
  details facts, Regenerate, Ask, the Maps set-up actions) — never a "paste your key"
  prompt for the visitor.

## Verification

- `./equin build` (coverage guard green, no new debt), `./equin check`.
- Workspace boot test: places + tags read back; places.search / details refused.
- e2e: snapshot, persistence, no-leak, app-switch, desktop-in-demo, prototypes-in-demo,
  sonata-in-demo, and new `apps/demo/e2e/places-in-demo.ts` (launcher → Places, map with
  pins, a tag filter, a place card, the "not available" states, Desktop window, Full screen).
- Real Places app on this build: search, card photos, map unchanged.
- Sonnet review of `git diff $(git merge-base HEAD main)`.

## Outcome (2026-11-06)

Landed as planned, with these differences:

- **Composition.** `agent-manager`'s negatives for the place block, the map
  block and the data view's map cascaded Places' map out of the demo, and an
  inherited negative cannot be contradicted (`composition-closure`). The entry
  list is now `AGENT_MANAGER_CORE` + `PLACES_ADAPTERS`; `agent-manager-demo`
  takes the core list, `agent-manager`'s extends and selection, plus `pages`,
  and selects `map.google`. `config.test.ts` pins that the only difference is
  the Places adapters.
- **Auth.** google-maps' web reads the central auth state, so `authState` and
  the central oauth / disconnect / sign-in endpoints are `needsMachine`
  ("Connecting an account"); central implements them with a new
  `endpoints/central`'s `implementCentral`. Their web readers render the
  unavailable arm.
- **page/place/google** moved to `machine/` (it calls the Places API); its
  Google type tables to `shared/` (its script regenerates them).
- **Photos.** `placePhotoAsset` / `placeThumbnailAsset` (AssetPath) replace the
  hand-built URLs; places-map reads them through `usePhotoSrc(s)`. The Places
  half of task-1793831071-kiua0g is done (Mail remains).
- **Map ID notice.** The raster-fallback notice's "fix in setup" link is hidden
  where the Map ID cannot be changed.
- **Host inputs.** Keys known at connect are declared then; a supply loaded
  later is declared on its own (`declareInputs`), never restarting the host.
  Declarations only grow (filed: task-1793979794-bl9ti9).
- **Temporary page-server read.** The page-wide icon sheet fetches the demo's
  saved icons it lacks as `GET /api/resources/icons.runtime-symbols`. The demo
  e2e allow exactly that request, temporarily; task-1793979789-wtzxz9 removes
  it (a scope gets its own symbol source).
- **Headless WebGL.** Google falls back to the raster map in headless Chromium;
  the e2e count that one console error apart (task-1793979791-ezt417).

Verification (this worktree's build):

- e2e: places-in-demo 27/27 (new), no-leak 45 (2 host skips, as before),
  snapshot 28, persistence 38, app-switch 28, desktop-in-demo 22,
  prototypes-in-demo 27, sonata-in-demo 39. Third-party hosts reached:
  maps.googleapis.com, maps.gstatic.com, mapsresources-pa.googleapis.com,
  fonts.googleapis.com, fonts.gstatic.com — all declared.
- The workspace boot test passes (places, tags, the browser config `unset`
  with no page, Google's half refused).
- The real Places app on this build: the map, tags, a card with Google's
  details, its photo strip and thumbnails, unchanged.
- Unit tests of the touched plugins pass, except
  `places-all.test.ts`'s tag-tree case, which fails on main too
  (TAG_TREE_MAX 500 vs 5001 rows).
- A Sonnet review: the host restart on a late supply and the per-render send
  were fixed; page-input unit tests added.
