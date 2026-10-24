# `/map` block — every place on the page on an interactive Google map

## Context

Pages can hold `/place` blocks (`plugins/page/plugins/place`). Each one resolves to a
`PlaceData` snapshot, with `lat`/`lng` included since the Google provider copies them from Places Details.
The user wants a `/map` block that shows all of a page's places on an embedded,
interactive Google map. Later it should support custom rendering: custom pins,
paths, areas.

Decisions already made with the user:

- **Google Maps JavaScript API**, not MapLibre and not a tile proxy. Everything we
  draw is fully under our control (pins are React via `AdvancedMarker`, plus
  `Polyline`/`Polygon`, deck.gl/WebGL overlays). The base map allows Google's cloud
  styling only, which is enough.
- **Two credentials, following industry practice.**
  - The existing Places key stays **server-only**. It can't be referrer-restricted
    because it is used server→Google, so it must never reach a browser.
  - A new **browser key**: Maps JavaScript API only, HTTP-referrer restricted. It is
    public config, not a secret.
  - This is the design that also holds for a hosted multi-user deployment. There,
    the operator supplies one browser key restricted to the hosted domain and
    controls cost with per-key quotas. Expensive calls (Places) stay proxied and
    rate-limitable server-side, as they already are.
- **Renderer-agnostic overlay vocabulary plus a swappable renderer**, so layers and
  pin styles are contributed by plugins and the block names none of them.

## Design

### Plugin layout

```
plugins/map/                              NEW top-level: the map primitive (vendor-neutral)
  core/   overlay vocabulary (MapPin, MapPath, MapArea, LatLng, MapOverlay union)
  web/    <MapView/> host, slots: Map.Renderer, Map.Pin
  plugins/google/                         NEW: Google Maps JS renderer (the only vendor code)
plugins/page/plugins/map/                 NEW: the /map block + PageMap.Layer slot
plugins/page/plugins/place/plugins/map-layer/   NEW: place → pins layer + place pin
plugins/integrations/plugins/google-maps/ EXTEND: browser-key public config + map readiness
```

The dependency arrows point one way:

- `map/google` → `map` and `integrations/google-maps`
- `page/map` → `map` and `page/editor`
- `place/map-layer` → `page/map`, `map` and `place`

`map` never names Google, and `page/map` never names `place`. This follows the
collection-consumer rule, with `Place.Provider` as precedent
(`plugins/page/plugins/place/web/slots.ts`).

### 1. `plugins/map` — the primitive

**core/**: plain data, no React:

```ts
type LatLng = { lat: number; lng: number };
type MapPin  = { kind: "pin";  id: string; position: LatLng; pinType: string; label?: string; data?: unknown };
type MapPath = { kind: "path"; id: string; points: LatLng[]; style?: { tone?: …; dashed?: boolean; width?: number } };
type MapArea = { kind: "area"; id: string; ring: LatLng[]; style?: … };
type MapOverlay = MapPin | MapPath | MapArea;
```

- Styles are semantic tokens (tone and dash), never hex colors.
- Paths and areas are in v1's vocabulary so the renderer contract is complete from day one.
  Only pins are produced in v1.

**web/**:

- **`Map.Renderer`** is a data slot: `{ id, label, component: ComponentType<MapRendererProps>, AccessAction?, useReady? }`.
  - The `useReady` / `AccessAction` pair is exactly the `Place.Provider` contract.
  - Selection logic: first contribution wins. Zero contributions renders a loud "no map renderer installed" state.
- **`Map.Pin`** is a dispatch slot keyed on `pin.pinType`. Its component receives `{ pin, active }` and returns
  the pin's React content. The fallback is a neutral dot.
- **`<MapView overlays onActivate? activeId? />`** is the host.
  - It picks the renderer, renders its `AccessAction` while not ready, otherwise renders the renderer component.
  - Pins go through `Map.Pin.Dispatch`, so a renderer never styles a pin itself.
- **`MapRendererProps`**: `{ overlays, renderPin(pin, active): ReactNode, onActivate(id), activeId, fit: "overlays" }`.
  - The renderer owns camera behavior:
    - fit-to-bounds over all overlays;
    - one pin → zoom ≈15;
    - zero → the host shows the empty state and never mounts the renderer.

### 2. `plugins/map/plugins/google` — the renderer

- Dependency: `@vis.gl/react-google-maps` in its own `package.json`.
- The impl is behind `lazyComponent` (`plugins/primitives/plugins/lazy-component/web`), following
  `plugins/primitives/plugins/graph-canvas/web/components/graph-canvas.tsx`, so the Maps SDK stays off the boot wave.
- Contribution: `Map.Renderer({ id: "google", label: "Google Maps", useReady: () => useMapsAccess("map").ready, AccessAction: MapsMapAccessAction, component })`.
- The impl:
  - `<APIProvider apiKey={browserKey}>` wrapping `<Map mapId={mapId ?? "DEMO_MAP_ID"}>`;
  - `<AdvancedMarker>` per pin, whose children are `renderPin(pin)` and whose click calls `onActivate`;
  - `Polyline`/`Polygon` for paths/areas, drawn from the `@vis.gl` map instance;
  - fit bounds via `map.fitBounds`, re-run only when the set of positions changes (not on every render), so the user's pan survives edits.
- **Loud failure**: Google calls `window.gm_authFailure` on a rejected key (wrong referrer, API not
  enabled). The renderer installs it and renders an error card naming the likely fixes. It never shows a
  grey map silently.

### 3. `integrations/google-maps` — browser key as public config

**Storage**: a host-global JSON file in a data dir declared by `integrations/google-maps` (`data-dirs/`,
using the `defineAppDataDir` / subdir pattern of `plugins/apps-core/data-dirs/index.ts` and the wallpaper
store `…/wallpaper/server/internal/store.ts`). It holds `{ browserKey, mapId? }`.

Why not the alternatives:

- **Not the secrets store.** The value is public by design. Serving it from the secrets store would break
  that store's rule that secrets never leave the server.
- **Not config_v2.** Its user layer is per worktree namespace, so every agent worktree would show
  "set up Maps" again.
- **Not central.** Central runs main's code, so the feature could not be exercised on a branch.

A host file is shared by every checkout, just like the Places key, and works from the branch immediately.

How it flows:

- **Served** as a `liveValue` + `serveValue` external source (`plugins/network/plugins/live`).
  - Notify happens on write and from a `file-watcher` on the file, so every worktree's browser updates live.
  - This is not polling.
- **Written** through `POST /api/google-maps/browser-config` (defineEndpoint, zod-validated).
  - The key must match `^AIza…`.
  - The mapId is optional free text.
  - No server-side verify, because a referrer-restricted key can't be verified honestly from the server.
    `gm_authFailure` is the verifier.
- **`useMapsAccess`** becomes `useMapsAccess(capability: "places" | "map")`. `MapsAccessBlocker` gains
  `"no-browser-key"`, the arm its doc comment already anticipates.
  - `"places"` keeps today's logic.
  - `"map"` also requires the browser config to be loaded and set.
  - A pending state is `loading`, never "not configured".
  - The one existing caller, `page/place/plugins/google/web/index.ts`, passes `"places"`.
- **Setup UI**: a `MapsMapAccessAction` button opens a "Live map" setup pane owned by `integrations/google-maps`.
  It isn't added to the `auth/google-maps/setup-wizard`, because that plugin is already imported *by*
  `integrations/google-maps` and adding it there would create a cycle.
  - The pane uses `Steps` from `primitives/setup-steps`.
  - Step: enable **Maps JavaScript API**.
  - Step: create a key restricted to **HTTP referrers** `http://*.localhost:9000/*` (plus any published
    domain) and to **Maps JavaScript API** only.
  - Step: suggest a daily quota.
  - Step: paste the key.
  - Step: optional Map ID for cloud styling, with `DEMO_MAP_ID` used until then.
  - A `StepCommand` copies the referrer pattern.

### 4. `plugins/page/plugins/map` — the `/map` block

- **Handle** (`core/map-block.ts`): `defineBlock({ type: "map", schema: MapDataSchema, label: "Map", icon: symbol("map"), aliases: ["places map"], empty: () => ({}), markdown: { tag: { name: "map", body: "none", attrs, parseAttrs } } })`.
  - The block is void, with no `text` key.
  - v1 data is `{}`; add `height?` later only if needed.
  - Markers are **derived**, never stored, so the map can't drift from the page.
- **Server**: `Editor.BlockData(mapBlock)`.
- **Config**: add `page.map:map` to `config/page/editor/block.jsonc` (Media group) next to
  `page.place:place`, and let the build regenerate `block.origin.jsonc`.
- **`PageMap.Layer`** is a data slot: `{ id, overlays(blocks: readonly Block[]): PageMapOverlay[] }`, where
  `PageMapOverlay = { overlay: MapOverlay; blockId?: string }`.
  - It is a pure function: derivation from block data needs no hooks, so it composes trivially.
  - An async layer (e.g. road routes via a server Routes call) would later be an added component-shaped
    variant, not a change to this one.
  - `blockId` is how the block maps a click back to page content without the primitive knowing about blocks.
  - An unrelated layer can omit `blockId`.
- **Renderer** `MapBlock({ block })`:
  - `const { blocks } = useBlockEditor()` gives the flat list, including collapsed toggle children, with
    optimistic edits applied, so a newly picked place appears at once.
  - Keep `b.pageId === block.pageId`. This excludes inline-expanded sub-pages, which have their own pageId,
    so the map shows *this* page.
  - Run every `PageMap.Layer` and memo on `blocks`.
  - Render `<MapView overlays activeId onActivate>` inside the block card, at a fixed height ≈ 20rem
    (a `css` primitives container).
  - `onActivate(id)`: look up its `blockId`, set it active, then reveal it:
    `blockRowIn(blockContentScope root, blockId)?.scrollIntoView({ block: "center" })` and
    `useSelectionControl()?.enterSelectionMode(blockId)` to highlight the place block.
  - If the target sits in a collapsed toggle (no row), skip the scroll and keep only the pin active.
  - Empty state (no pins): "Add a /place block to see it on the map".
  - A footer note shows "N places not shown yet", counting place blocks without coordinates (still
    resolving, or picked before `lat`/`lng`), via a layer-reported `unplaced` count. Dropping them silently
    would be a lie.
    - Shape: `overlays()` returns `{ overlays, unplaced }`. Settle that exact shape in implementation.
- **Read-only surfaces** (version-history preview) keep today's generic `PlaceholderCard`, the same as
  `/place`. A read-only map needs a page-forest context that `read-only-view` doesn't offer, so it is out
  of scope. A follow-up task will be filed.

### 5. `plugins/page/plugins/place/plugins/map-layer`

- `PageMap.Layer({ id: "place", overlays })` covers every `b.type === PLACE_TYPE` block. It uses
  `placeBlock.safeParse(b.data)` (`place/core`), keeps rows with numeric `lat`/`lng`, and produces
  `{ overlay: { kind: "pin", id: b.id, pinType: "place", position, label: name }, blockId: b.id }`.
  Rows without coordinates count toward `unplaced`.
- `Map.Pin({ match: "place", component: PlacePin })` is a compact bubble.
  - It shows the location icon plus the name, truncated (`Text`, `Badge`/`Surface` primitives), with
    theme tokens only.
  - It grows and raises when active.
  - This is the first custom pin, and proves the slot.

## Critical files

- New: `plugins/map/{core,web}/…`, `plugins/map/plugins/google/web/…`, `plugins/page/plugins/map/{core,web,server}/…`,
  `plugins/page/plugins/place/plugins/map-layer/web/…`
- Edit: `plugins/integrations/plugins/google-maps/web/internal/use-maps-access.ts`,
  `…/web/components/maps-access-action.tsx`, `…/web/index.ts`, `…/server/index.ts` (+ new
  `server/internal/browser-config.ts`, `core/` endpoint + live value, `data-dirs/`),
  `plugins/page/plugins/place/plugins/google/web/index.ts` (pass `"places"`),
  `config/page/editor/block.jsonc`, `integrations/google-maps/CLAUDE.md` (document both credentials and why).

Reuse: `defineBlock` (`page/editor/core/define-block.ts`), `useBlockEditor` / `blockContentScope` /
`blockRowIn` / `useSelectionControl` (`page/editor/web`), `placeBlock` / `PLACE_TYPE` (`place/core`),
`lazyComponent`, `defineSlot` / `defineDispatchSlot` (web-sdk), `liveValue` / `serveValue` / `useLive`
(`network/live`), `file-watcher`, `Steps` (`primitives/setup-steps`), `openPane`.

## Verification

1. `./equin build` must pass. This covers checks: boundary-rules, plugin-boundaries (no cycle
   google-maps ⇄ wizard), plugins-registry-in-sync, and docs.
2. Unit tests (`./equin test plugins/page/plugins/place/plugins/map-layer plugins/map`):
   - the place layer maps blocks → pins, counts `unplaced`, and ignores other types and parse failures;
   - bounds and zoom selection for 0/1/N pins, if kept as a pure helper in `map/core`.
3. E2E script `plugins/page/plugins/map/e2e/map-block.ts`:
   - open a blank page;
   - paste markdown with two `<place … lat lng …/>` tags (branches can't search Places) and `<map/>`;
   - assert two pins render (without a browser key, assert the "Set up" access action instead);
   - click a pin and assert its place block is scrolled into view and selected;
   - reload and assert the map persists.
4. Manual, on `http://<worktree>.localhost:9000`:
   - set the browser key through the new pane;
   - check that a second worktree's map picks it up live;
   - check that a wrong key shows the `gm_authFailure` error card, not a grey map.

## Follow-ups (file as tasks, not in v1)

- A read-only / public-site rendering of `/map`.
- An async layer variant plus a "route between consecutive places" path layer (Routes API, server-proxied).
- Cloud map styling per theme (light/dark Map IDs).
- Clustering (`@googlemaps/markerclusterer`) for large pages.
