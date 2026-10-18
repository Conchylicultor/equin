# google-maps

Google Maps Platform access: the **public consumer API** for reading the stored
Places key on the server, for the public browser config the live map renders
with, and for knowing, on the web, whether each Maps capability is usable yet.

## Two credentials, on purpose

Maps uses two keys, following Google's own guidance, and neither may stand in
for the other:

- **The Places key — server-only, a secret.** Address lookups are proxied:
  the server calls Google with this key. A server-to-Google call carries no
  browser referrer, so the key cannot be referrer-restricted — it is
  effectively unrestricted (API restrictions only), and anyone holding it can
  spend on it. It therefore lives in the auth/central secrets store and must
  **never** reach a browser. Setup: `auth/google-maps/setup-wizard`.
- **The browser key — public config.** The live map is drawn in the page by
  the Maps JavaScript API, which needs a key in the page. Such a key is public
  by design: it is restricted to HTTP referrers (`http://*.localhost:9000/*`
  plus any published domain) and to the Maps JavaScript API only, and its
  spend is bounded by a daily quota. Setup: this plugin's **Live map** pane
  (`settings/accounts/google-maps/live-map`).

The same split holds for a hosted deployment: one operator browser key
restricted to the hosted domain, and the expensive Places calls kept proxied
and rate-limitable on the server.

## Two basemaps: raster by default, vector with a Map ID

- **No Map ID: Google's raster map.** It hides Google's own places with an
  inline style (`BASEMAP_STYLE`). It zooms by whole levels: each wheel burst
  snaps 2×.
- **With a Map ID: the vector map.** It zooms fractionally and animated, as on
  google.com/maps. It is styled by the cloud style attached to the Map ID,
  because Google ignores inline styles there.
- Measured on the user's machine, both render at a full 120 Hz. The zoom model
  is the whole difference (`research/2026-10-16-map-zoom-smoothness.md`).

The user creates the style and the Map ID in the Cloud Console, guided by the
**Smooth zoom** part of the Live map pane:

1. Import `BASEMAP_STYLE_JSON` (the same rule the raster map passes inline, so
   the two cannot drift) as a map style, and publish it.
2. Create a JavaScript Vector Map ID, with tilt and rotation off because the
   pin canvas projects flat, and attach the style on the Map ID's own page
   (Map styles → Edit → Light). Google attaches styles from the Map ID, not
   from the style, so this order never goes back.
3. Paste the Map ID; the preview checks it.

The app never holds a Cloud permission. The Map Management API takes only the
broad `cloud-platform` scope, which the user declined
(`research/2026-10-16-global-google-vector-map-id.md`). Only the id string is
stored.

Nothing verifies the Map ID on write. The pane checks it live instead: step 3
draws a **preview map** with the Map ID being set up (the valid draft, else the
saved one) and the stored key, centred on central Paris so Google's shops and
museums are visible if the style is not attached yet. It reads
`getRenderingType()` and shows Checking / Vector map / Raster, and **Check
again** remounts it (Google can take minutes to serve a changed Map ID or
style). The map is drawn by `map/google`, contributed into the
`LiveMapSetup.MapIdPreview` slot (props `{ browserKey, mapId, onResult }`):
`map/google` imports this plugin, so this plugin cannot import it back, and
with no contribution installed the pane says so loudly. No automatic signal
exists for hidden places; step 3 asks the user to look at the same preview. A
Map ID that Google draws as raster also shows `MapIdRasterNotice` on the real
map, local to the renderer. There is no page-global report store.

### Where the browser config lives, and why

A host-global JSON file, `state/google-maps/browser-config.json`
(`{ browserKey, mapId? }`), declared in `data-dirs/`. Shared by every checkout
— main and every agent worktree — exactly like the Places key. The
alternatives each fail one way:

- **Not the secrets store.** The value is public by design; serving it to
  browsers from there would break that store's rule that secrets never leave
  the server.
- **Not config_v2.** Its user layer is per worktree namespace, so every agent
  worktree would show "set up the live map" again.
- **Not central.** Central runs main's code, so the feature could not be
  exercised from a branch.

It is served as the `google-maps.browser-config` live value (external source):
a write through `POST` / `DELETE /api/google-maps/browser-config` (the key;
deleting it removes the Map ID too) or `/api/google-maps/map-id` (the Map ID,
refused with 409 while no key is stored) notifies its
own backend, and every backend with a subscribed tab watches the directory
(`infra/file-watcher`) so a write from another checkout — or a hand edit —
reaches every tab live. No polling.

Nothing verifies the browser key on write. A referrer-restricted key cannot be
checked honestly from the server (no referrer ⇒ refused; a forged one proves
nothing about a real page), so a stored key is not a verified one: the map
renderer's `gm_authFailure`, raised in the real page, is the verifier.

## Public API

This plugin owns the Google Maps vocabulary so consumers (the `/place` block's
Google adapter, the live map renderer) go through it and **never** import
`@plugins/auth/*` directly or name the provider id themselves.

- **`server`** (`@plugins/integrations/plugins/google-maps/server`)
  - `getMapsKey(): Promise<MapsKeyResult>` — the Places key from the shared
    auth/central secrets store. `{ ok: true; key }` or
    `{ ok: false; reason: "not-configured" }`; never `""`. Lets
    `AuthCentralOfflineError` propagate, and throws on any other central failure
    (fail loudly).
- **`core`** — `mapsBrowserConfig` (the live value), `setMapsBrowserConfig` /
  `clearMapsBrowserConfig` and `setMapsMapId` / `clearMapsMapId` (the
  endpoints), `BROWSER_KEY_PATTERN`, `MAP_ID_PATTERN`, `BASEMAP_STYLE` /
  `BASEMAP_STYLE_JSON` (the one "hide Google's places" rule).
- **`web`** (`@plugins/integrations/plugins/google-maps/web`)
  - `useMapsAccess(capability: "places" | "map"): MapsAccess` — reactive
    `{ configured, ready, loading, blocker }` for ONE capability. `configured`
    means that capability's own credential is stored: the Places key for
    `"places"`, the browser key for `"map"`. The map does not need the Places
    key.
  - `blocker: "not-configured" | "no-browser-key" | null` — the ONE next unmet
    prerequisite. `"not-configured"` arises only for `"places"`,
    `"no-browser-key"` only for `"map"`. Pending is `loading`, never a blocker.
  - `useMapsBrowserConfig(): MapsBrowserConfigState` — `loading` / `unset` /
    `set { browserKey, mapId }`, for the renderer.
  - `LiveMapSetup.MapIdPreview` — the slot a map renderer fills with the
    Map ID preview map. `MapIdRasterNotice` — the map's
    "this Map ID isn't a vector map" affordance (opens the Live map pane).
  - `MapsAccessAction` — opens the Places setup wizard, or `null` when Places
    is ready. `MapsMapAccessAction` — opens the Live map pane, or `null` when
    the map is ready. A Maps surface that cannot work renders the matching one
    **in place**, rather than telling the user to go find Settings.
  - `MAPS_BLOCKER_BODY` — the shared per-blocker explanation copy.

## Two known limits of the Places api-key arm

Both are properties of `kind: "apikey"` auth, stated here rather than papered
over:

- An account is `connected: true` from the moment a key is stored, and nothing
  ever marks it stale — the refresh loop skips non-oauth2 providers. A key
  revoked or unbilled upstream still reads "configured"; the failure surfaces as
  a loud `PlacesApiError` from the call itself.
- Disconnecting deletes the local entry without revoking anything at Google.

## Sub-plugin

- **`places-api`** — the stateless typed Places API (New) client. It takes the
  key per call and touches no storage, which is what keeps this broker (which
  reads auth) and the transport free of an import cycle.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Google Maps Platform access broker (web): per-capability readiness (Places lookups vs the live map), the public browser config read, the 'set up Google Maps' / 'set up the live map' affordances consumers render in place of routing the user to Settings, and the Live map setup pane — listed in Settings → Accounts as the Google Maps 'Live map' row — (browser key, plus the optional vector-map Map ID, checked live by a preview map the renderer plugin draws into the pane's LiveMapSetup.MapIdPreview slot). Google Maps Platform access broker (server): getMapsKey() reads the stored Places API key via the shared auth/central store, so consumers never import @plugins/auth; serves the host-global public browser config (Maps JavaScript API key) as a live value, with its write/clear endpoints for the key and the vector map's Map ID.
- Web:
  - Slots:
    - `google-maps-live-map-setup.actions`
    - `LiveMapSetup.MapIdPreview`
  - Slot contributors:
    - `google-maps-live-map-setup.actions` ← `primitives.pane`
    - `LiveMapSetup.MapIdPreview` ← `map.google`
  - Contributes:
    - `Pane.Register` "google-maps-live-map-setup"
    - `Auth.Integration` "Live map"
  - Uses: 33 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/setup-steps` ×10
    - `primitives/live-state` ×5
    - `auth` ×3
    - `primitives/pane` ×3
    - `infra/endpoints` ×2
    - `primitives/css/ui-kit` ×2
    - `apps-core/tabs.appLinkProps`
    - `auth/google-maps/setup-wizard.googleMapsSetupPane`
    - `network/live.useLive`
    - `primitives/css/clip.Clip`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/loading.Loading`
    - `primitives/slot-render.defineDispatchSlot`
  - Exports (types):
    - `MapIdPreviewProps`
    - `MapIdPreviewResult`
    - `MapRendering`
    - `MapsAccess`
    - `MapsAccessBlocker`
    - `MapsAccessCapability`
    - `MapsBrowserConfigState`
  - Exports (values):
    - `LiveMapSetup`
    - `MapIdRasterNotice`
    - `MAPS_BLOCKER_BODY`
    - `MapsAccessAction`
    - `MapsMapAccessAction`
    - `useMapsAccess`
    - `useMapsBrowserConfig`
- Server:
  - Contributes: `resource.declare` "google-maps.browser-config"
  - Uses:
    - `auth.getTokenFromCentral`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/file-watcher.defineFileWatcher`
    - `network/live.serveValue`
  - Exports (types): `MapsKeyResult`
  - Exports (values): `getMapsKey`
  - Register: `defineFileWatcher('google-maps.browser-config')`
  - Resources: `google-maps.browser-config` (push, notified)
  - Routes:
    - `POST /api/google-maps/browser-config`
    - `DELETE /api/google-maps/browser-config`
    - `POST /api/google-maps/map-id`
    - `DELETE /api/google-maps/map-id`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
  - Exports (types):
    - `MapsBrowserConfigInput`
    - `MapsBrowserConfigValue`
    - `MapsMapIdInput`
  - Exports (values):
    - `BASEMAP_STYLE`
    - `BASEMAP_STYLE_JSON`
    - `BROWSER_KEY_PATTERN`
    - `clearMapsBrowserConfig`
    - `clearMapsMapId`
    - `MAP_ID_PATTERN`
    - `mapsBrowserConfig`
    - `MapsBrowserConfigInputSchema`
    - `MapsBrowserConfigValueSchema`
    - `MapsMapIdInputSchema`
    - `setMapsBrowserConfig`
    - `setMapsMapId`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `apps/places/place-details`
    - `apps/places/places-core`
    - `apps/places/places-map`
    - `map/google`
    - `page/place/google`
- Sub-plugins:
  - **`places-api`** — Stateless typed Google Places API (New) client: places:autocomplete, places:searchText, place details, the separately priced rich details (photos, hours, rating, phone, website, summary) and place…

<!-- AUTOGENERATED:END -->
