# Places — implementation plan (v0)

Vision: [`2026-10-12-global-places-app-vision.md`](2026-10-12-global-places-app-vision.md).
Reference UI: prototype `proto-1791725279-9yramg` (`~/.singularity/apps/prototypes/proto-1791725279-9yramg/`,
options at their defaults: `status=pin-style`, `emoji=material`, `drop=bare`).

## Context

The user wants a saved-places app with Mapstr-like nested coloured tags, a
full-screen map with floating chrome, and the map as a DataView view type with
arbitrary queries. The repo has most of the substrate — the vendor-neutral
`map` primitive (`MapView`, `GeoMap.Renderer` / `GeoMap.Pin`), the Google Places
client (`integrations/google-maps/plugins/places-api`: `autocomplete`,
`placeDetails` → `PlaceSnapshot` with `types`, `primaryType`, `lat`, `lng`), the
DataView view-type slot, the `tags` field type, `defineEntity` /
`liveCollection`, `runClaudePrint` for Haiku — but is missing five generic
pieces (below) plus the app itself.

## Gaps found (exploration)

| Gap | Where it is today |
|---|---|
| No `location` field type | `plugins/fields` has no geo type |
| No hierarchy-aware filter | tags are flat `string[]`; `FieldOption {value,label,variant,hint}`; `FilterLowerContext {column, now}` — an operator cannot see the field's options |
| No external/floating DataView chrome | toolbar arrangements exist (`data-view/core/internal/toolbar-arrangement.ts`, `capsule-toolbar`) but the band is always in flow; `useDataViewControls()` is provided only around the toolbar |
| No map clustering | `map/plugins/google/.../google-map-impl.tsx` renders every pin as its own `OverlayView` |
| No map view for DataView | view types: table, gallery, list, tree, icons |

## Design

### 1. `fields/plugins/location` — location field type
- `defineFieldType<Location>("location")`, `Location = { lat: number; lng: number; address?: string }` (zod `LocationSchema` in core).
- Identity (`Fields.Identity`, icon `location_on`), cell (address, else `lat, lng`), storage (jsonb, `Fields.Storage`), filter: `is set` / `is not set`.
- Pattern: copy the shape of an existing small type (`fields/plugins/color`, `fields/plugins/tags`).

### 2. Hierarchical field options + "nested" tags operators (data-view + fields/tags)
- `FieldOption` gains `parent?: string` (the option value of its parent) — `data-view/core/internal/types.ts`.
- `FilterLowerContext` gains `field: FieldDef<unknown>` so an operator can read the field's `options`; every `lower(...)` call site passes it (`lowerFilterGroup`, live-filter).
- A pure helper `optionDescendants(options, value): string[]` in data-view core.
- `fields/plugins/tags/plugins/filter`: two operators, offered only when the field's options declare a `parent`:
  `has-nested` ("has any of, or nested under", operand `string[]`) → `clause(col, "hasAny", closure)`;
  `lacks-nested` → `hasNone` over the closure. Lowering stays client-side, so live sources work unchanged.
- Unit tests for the closure + lowering.

### 3. DataView floating chrome (data-view + new arrangement)
- `ToolbarArrangement.overlay?: true` — the host renders the band absolutely over the view body (transparent, pointer-events only on its parts) and gives the body the full surface.
- New arrangement plugin `data-view/plugins/floating-toolbar`: view switcher as a floating tab card (top-left of the content area), search + controls + creators + actions as a floating card (top-right).
- `DataViewBaseProps.aside?: ReactNode` — host-owned panel rendered inside the DataView's controls context (so it can call `useDataViewControls().filter.setFilter`), placed as a floating left card when the arrangement is `overlay`, else as a left column. Arrangements get `asideInset` so their cards start right of it.

### 4. Map clustering (`map` + `map/plugins/google`)
- `MapViewProps.cluster?: { radiusPx?: number }` → `MapRendererProps.cluster`.
- New dispatch slot `GeoMap.Cluster` keyed by the cluster's `pinType` (all pins in a cluster share their layer's pinType; mixed → fallback), props `{ pins: MapPin[]; count; tiles }`; fallback = neutral count disc.
- Google renderer: on `idle`/zoom, project pins to pixels and greedy-merge within the radius (pure `clusterPins(points, radius)` in `map/core`, unit-tested); a cluster renders through the existing `OverlayPin` host; clicking zooms to its bounds.
- `MapViewProps.focusId?` pans to a pin without refitting (selected row).

### 5. `data-view/plugins/map` — the map view type
- `DataViewSlots.View({ type: "map", title: "Map", icon: symbol("map"), supportsGroupBy: false, supportsFold: false, configSchema: { locationField } })`.
- Uses `useFlatRows(...)` (search → filter → sort), maps rows with a location to `MapPin`s, renders `<MapView cluster activeId={selectedRowId} onActivate={…rowActivation/onRowOpen} />` full-bleed.
- Code options (`viewOptions.map`): `{ pinType?: string; pinData?: (row) => unknown; label?: (row) => string }` — a consumer contributes its own `GeoMap.Pin` / `GeoMap.Cluster` for its pinType; absent → default pin.
- Location field: config `locationField`, default = first field of type `location`.

### 6. The app: `apps/plugins/places`
Empty namespace + sub-plugins (create-app skill; full-pane like `apps/chord`):

- `shell` — `defineApp({ id: "places", name: "Places", basePath: "/places", iconKey: "location_on" })`, `Apps.App`, `<AppShellLayout><FullPane/></AppShellLayout>`.
- `places-core` (core/server/web):
  - Entities (`defineEntity`, `@plugins/infra/plugins/entities/server`):
    - `places`: `id`, `googlePlaceId` (unique), `name`, `address`, `location` (jsonb Location), `primaryType`, `types` (jsonb string[]), `mapsUrl`, `icon` (SavedSymbolName, nullable — Haiku), `note`, `tags` (jsonb tag ids), `autoTags` (jsonb tag ids ⊆ tags), `fetchedAt`, `createdAt`, `updatedAt`.
    - `place_tags`: `id`, `name`, `parentId` (nullable), `color` (hex, nullable = inherit), `icon` (nullable), `googleTypes` (jsonb string[]), `rank`, `createdAt`.
  - Seed (idempotent, first boot): the prototype's tree — Status›Todo/Done (well-known ids `todo` / `done`), Food & drinks›…, Culture›…, Nature›…, Shopping›…, with colours, icons and Google types from the prototype's `data.js`.
  - Live: `liveCollection("places.places")` and `liveCollection("places.tags")` (bounded: default limit 2000 / maxLimit 5000 — a personal set), `serveCollection`.
  - Endpoints (`defineEndpoint` / `implement`): `POST /api/places/places` `{googlePlaceId, session}` → resolve with `placeDetails(getMapsKey())`, auto-tag from `googleTypes`, add `todo`, insert, enqueue icon job; `PATCH /api/places/places/:id` (note, tags, status); `DELETE`; tag CRUD `POST/PATCH/DELETE /api/places/tags` (delete moves children up and re-tags places with the parent, as in the prototype).
  - Search: `GET /api/places/search?q&session` → `autocomplete(getMapsKey())`.
  - Haiku icon (`runClaudePrint({tier:"haiku"})`, pattern `apps/plugins/pages/plugins/auto-icon`): one Material Symbols name per place, validated by `parseSavedSymbolName`; on failure the place keeps `icon = null` and the pin shows its main tag's icon.
  - Pure helpers in core: `tagColor(tagId, tags)` (own or nearest ancestor), `ringColors(place, tags)`, `mainColor`, `autoTagsFor(types, tags)`, `tagPath`.
- `places-map` (web) — the index pane:
  - `<DataView rows={places} fields={…} views={["map","gallery","list"]} toolbar={floatingToolbar} aside={<TagSidebar/>} viewOptions={{ map: { pinType: "saved-place", pinData } }} />` full-bleed.
  - Fields: name, address, tags (`tagsField` with options = tag tree incl. `parent`), status (derived), location, note, createdAt.
  - `GeoMap.Pin` "saved-place" = the drop pin (§ The pin in the vision; CSS from the prototype); `GeoMap.Cluster` "saved-place" = colour-mix ring + count + ✓ done.
  - `TagSidebar` (aside): "Tagged / Not tagged" summary chips with any/all, tag search, tree with faceted counts; click cycles include → exclude → off by editing the top-level `has-nested` / `lacks-nested` rules of the view filter on the tags field; footer `+ New tag`, `Manage tags`.
  - Place card (floating right, on the selected row): icon, name, address, Todo/Done switch, tags with path + AUTO, add/remove tag, note, Google Maps link.
  - Add place: toolbar action → search popover (debounced, one session token per pick) → `POST`.
  - Legend card (bottom).
  - Saved views seeded in config: All places (map), Gallery, List.
- `tag-manager` (web): the Manage tags panel (floating over the map, as in the prototype): name, parent select, colour swatches (own / inherit), icon (`IconPicker`, `primitives/icon-picker/web`), Google types chips, count, + child, delete.

## Execution

Agents work in this one worktree on disjoint folders; none runs `./singularity build`
(the coordinator builds after each wave and fixes integration).

- **Wave 1 (parallel):** §1 location field · §2 hierarchical options + operators · §3 floating chrome · §4 clustering · §6 backend (shell + places-core + seed + endpoints + Haiku job).
- **Wave 2 (parallel, after build):** §5 map view · §6 web (places-map, pins, sidebar, card, add place, tag-manager).
- **Wave 3:** build, `./singularity check`, screenshots against the prototype, fixes.

## Verification

- `./singularity test` on: location field, data-view (closure/lowering), map (`clusterPins`), places-core helpers (colour inheritance, auto-tags).
- `./singularity build` then `./singularity check` green.
- Screenshots (`e2e-harness/e2e/screenshot.ts --path /places`): map with clusters and drop pins, sidebar include/exclude changes the count, gallery/list switch, Manage tags, place card. Without a Google browser key the map shows its set-up action (expected); the sidebar, gallery and list still work.
- Add a place end to end when a Places key is configured: auto tags + AUTO badge, icon appears after the Haiku job.

## Out of scope (v0)

Agents (capture, explore), photos/ratings (Enterprise-tier Places fields), import from
Google Takeout / Mapstr, mobile layout, trips/routes, sharing.
