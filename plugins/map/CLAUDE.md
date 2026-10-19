# map

The vendor-neutral map primitive. It names no map vendor: Google (or any other
engine) is a `GeoMap.Renderer` contribution in a child plugin, and everything
above this plugin — the `/map` page block, its layers, the pins — is written
against the vocabulary below and never learns which engine draws it.

## Vocabulary (`core/`)

Plain data, no React:

- `LatLng`, and the overlay union `MapOverlay = MapPin | MapPath | MapArea`.
- A **pin** carries a `pinType`. The pin's look is not in the data: `GeoMap.Pin`
  dispatches on `pinType`, so whoever makes a pin type also contributes how it
  looks.
- **Paths** and **areas** style themselves with semantic tokens only
  (`tone: MapTone`, `dashed`, `width`), never colours. `MAP_TONE_TOKEN` maps each
  tone to the theme's CSS variable, and the renderer resolves it where it paints,
  so a map re-themes with the app.
- Camera helpers: `overlayPositions` and `cameraFor` (none / one point at
  street zoom / fit bounds); `viewFor` turns a framing into the `CameraView`
  (centre + whole zoom) it puts a map of a given size in, keeping the framed
  area clear of the covered edges; `flyPath` is the smooth zoom-and-pan
  between two views (van Wijk & Nuij: a far jump zooms out, glides, zooms
  in) with its duration — a renderer just plays its frames.
- `MapPadding` (`{ top, right, bottom, left }` px, `NO_MAP_PADDING`): the room
  chrome floating over the map covers.
- Crowding (`MapCrowdRequest` / `MapCrowd`, `resolveCrowd`): `cluster` or
  `spots`, a closed union. `clusterPins(points, radiusPx)` greedily groups pins
  already projected to pixels (deterministic, input-order-insensitive,
  grid-bucketed — `grid.ts`, shared with spots), and `clusterPinType(pins)`
  names the dispatch key of a group — the shared `pinType`, or
  `MIXED_PIN_TYPE` for a mixed group. `groupSpots(points, radiusPx)` groups
  the same way but seeds most-important first (`rank`, then id), so a spot's
  lead is its best pin; `pinStackOrder(pins, activeId)` is the z-order every
  renderer stacks pins in (rank, then id; the active pin on top).
- `MapPin.rank` (default 0): a pin's importance among its neighbours.
- `frame: false` (any overlay): kept out of the camera's framing — neither the
  one framing a map makes on its own nor the Fit control frames it
  (`framingOverlays`). For proposals (search hits) shown where they are
  without ever moving the user's camera.
- **Marks** (`mark.ts`): a pin's look as data — `MapMark { key, svg, width,
  height, anchor, labelAt, texts? }`, one standalone SVG image placed with its
  `anchor` on the point. `key` names the look (equal keys = identical pixels:
  the sprite cache key); the SVG holds concrete colours only, no `<use>`, no
  `<text>` (`markSvgProblem`, enforced where it is rasterized AND where the DOM
  draws it); text goes in `texts` (`beside` at `labelAt`, in map-label paint,
  or `center` on the mark). `markSvg`, `markIdPrefix` (ids unique per look —
  marks are also drawn inline), `markShadow` / `MARK_SHADOW_PAD` (`shadow-md`
  inside the box), `MARK_PENDING` (an icon still loading: drawn once ready,
  never a stand-in).
- **The teardrop** (`drop.ts`): `dropHeadSvg` — the place-pin head every place
  pin draws (a square with three round corners turned −45°, or a disc;
  equal colour slices from the top, an optional pale veil, a 2px outline
  inside the box, `shadow-md`, an upright glyph); `dropTipPx`, `sliceWedges`.

## Host and slots (`web/`)

- `<MapView overlays activeId onActivate cluster focusId empty/>` fills its
  parent; the caller owns the size. The renderer is mounted whatever the
  overlays: with none, `empty` floats on a card over the map (`null`: a bare
  map) — a set that empties (a filter matching nothing) and fills again keeps
  the camera. `crowd` picks how crowding pins are drawn:
  `{ kind: "cluster", radiusPx? }` (default 48) merges them into cluster marks;
  `{ kind: "spots", radiusPx?, nearZoom? }` (defaults 34px, zoom 13) keeps
  every pin drawn — below `nearZoom` each is drawn `far` (a compact mark
  anchored at its centre) and each spot's lead is told the spot's size. Absent:
  every pin on its own. `focusId` pans to a pin
  when it changes and is off-screen, never refitting or zooming. `fitPadding`
  (a `MapPadding`, default none) names the edges floating chrome covers: fitting
  frames the overlays in the uncovered area, and a focused pin under the chrome
  counts as off-screen and is panned to the uncovered area's middle — re-checked
  when the padding changes, since a card opening with the selection is measured a
  render later. A change of padding never re-frames (the user's map stays put).
- `pick` (optional `(position: LatLng) => void`) is **pick mode**: while set,
  the cursor is a crosshair and a click on the map itself — never on a pin —
  reports where it landed. It is how a caller asks "where?" (Places drops and
  moves custom pins with it). The overlay change a pick leads to does not
  re-frame the map: it lands where the user just clicked.
- `cameraKey` (optional) remembers the camera on this device
  (`persistent-draft`, no expiry): the map opens at the centre and zoom the
  user left it at, and frames the overlays only on a first visit. The
  renderer gets it as `initialCamera` (read once, at mount; it then skips its
  one framing) and reports each resting view through `onCameraRest`; the host
  remembers it only while some overlay frames (an empty map's world view is
  never remembered).
- `onCameraRest` (optional) — the caller's: each time the camera rests (and
  once when the map first settles), a `CameraRest` (`center`, `zoom`,
  `bounds`) — what a search biased to "this map area" reads.
- `hoveredId` / `onHoverChange` (optional) — hover linked to something outside
  the map (a result card): `hoveredId` lifts that pin as a pointer hover does
  (the pointer's own hover wins), and `onHoverChange` reports the pin under the
  pointer (`null`: none).
- `GeoMap.Renderer` — a data slot. **First contribution wins**; zero is a loud
  "no map renderer installed" state. Its contract is `Place.Provider`'s, widened
  to three states: `useReadiness(): "pending" | "ready" | "blocked"`, and
  `AccessAction`, which is rendered while blocked. Pending renders a loading
  state, never the set-up action, because a pending configuration is not a
  missing one.
- The renderer component receives `MapRendererProps` (`overlays`,
  `renderPin(pin, state)`, `markPin(pin, scale)`, `onActivate`, `activeId`,
  `crowd`, `renderCluster(pins)`, `markCluster(pins)`, `focusId`,
  `fitPadding` — always set, zeros when nothing floats — and the optional
  `pick`). **A renderer never styles a pin**: it draws every pin at rest from
  its mark (`markPin` — the matched contribution's `mark`, via
  `GeoMap.Pin.useMatch()`, the same match `.Dispatch` renders) on ONE surface
  (`map/pin-layer`), and lifts only the pins being interacted with (hovered,
  active) into the DOM as the node `renderPin` returns (`GeoMap.Pin.Dispatch`,
  already isolated by the slot middleware), placed at the mark's anchor. Why:
  one DOM subtree per pin made every zoom frame relayout and re-layerize ~1000
  stacking contexts (~94 ms/frame at 957 pins; plan
  `research/2026-10-15-map-canvas-pin-layer.md`). A renderer
  owns the camera, and **the camera is the user's**: it frames the overlays
  once (the first time there are any — fit-to-bounds, or the single-point
  zoom), then never moves on its own — a changed overlay set (a filter, an
  edit, a new pin) keeps the pan and zoom. Instead it offers a **Fit** control
  that flies (`flyPath`, never a jump) to frame the overlays showing now, on
  demand.
- `GeoMap.Pin` — a dispatch slot keyed on `pin.pinType`. A contribution
  carries a required pure `mark({ pin, scale }, env)` (`MapPinMarkFn`; `env`:
  `icon` — `useIconMarkup`'s reader, `color` — any CSS colour resolved to its
  computed value in the map's scope, `tiles`) and its `component`, which draws
  the SAME mark through `<MapMarkImage mark/>` (`useMapMarkEnv(tiles)` gives
  it the env) plus what only the DOM does: hover / active transitions, the
  name on hover. Its box is the mark's box, so lifting a pin moves no pixel. The
  host's `MarkHostProvider` (a hidden probe in the map's subtree) resolves the
  colours and measures the label fonts (`useMapTextStyle`). Its component gets
  `{ pin, tiles }` and the renderer's `MapPinState`: `active`, `scale`
  (`near`: anchored at its bottom centre; `far`, spots mode only: anchored at
  its CENTRE, so draw centred) and `spot` (`{ count, hushed }`, on a far spot's
  lead only: draw the count beside the pin, faded while `hushed` — a pin of the
  spot is hovered). The fallback is a neutral dot (with the count beside it as
  a lead), so an unclaimed type is still visible.
- `GeoMap.Cluster` — a dispatch slot keyed on `clusterPinType(pins)`, with a
  `mark({ pins, count }, env)` beside its component like a pin's. Its
  component gets `{ pins, count, tiles }`. The fallback is a neutral count disc,
  which a mixed group always gets. A renderer places `renderCluster`'s node like
  a pin's, never the active pin (which is always drawn on its own), and a click
  on it frames the cluster's pins.

The namespace is `GeoMap`, not `Map`, so it does not shadow the JS global.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Vendor-neutral map primitive: <MapView overlays/> draws pins, paths and areas through the first GeoMap.Renderer (showing its set-up action while it is blocked, and a loud state when none is installed), with every pin's look contributed through the GeoMap.Pin dispatch slot keyed on its pinType, and a crowd mode the caller picks: clustering (every group of nearby pins drawn through the GeoMap.Cluster dispatch slot keyed on the pinType its pins share) or spots (every pin stays drawn — far out as a compact centred mark, with the size of each spot beside its lead pin).
- Web:
  - Slots:
    - `GeoMap.Renderer`
    - `GeoMap.Pin`
    - `GeoMap.Cluster`
  - Slot contributors:
    - `GeoMap.Renderer` ← `map.google`
    - `GeoMap.Pin` ← `apps.places.places-map`
    - `GeoMap.Pin` ← `page.place.map-layer`
  - Uses:
    - `primitives/css/center.Center`
    - `primitives/css/coords.Placed`
    - `primitives/css/layer.Layer`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/loading.Loading`
    - `primitives/persistent-draft.DraftOptions`
    - `primitives/persistent-draft.readDraft`
    - `primitives/persistent-draft.writeDraft`
    - `primitives/slot-render.defineDispatchSlot`
    - `primitives/slot-render.renderIsolated`
    - `ui/icons.useIconMarkup`
  - Exports (types):
    - `MapClusterMarkFn`
    - `MapClusterProps`
    - `MapLabelProps`
    - `MapMarkEnv`
    - `MapPinMarkFn`
    - `MapPinMarkInput`
    - `MapPinProps`
    - `MapPinScale`
    - `MapPinState`
    - `MapRendererContribution`
    - `MapRendererProps`
    - `MapRendererReadiness`
    - `MapTextStyle`
    - `MapViewProps`
  - Exports (values):
    - `GeoMap`
    - `MAP_LABEL_HALO_PX`
    - `MAP_LABEL_PAINT`
    - `MapLabel`
    - `MapMarkImage`
    - `MapView`
    - `useMapMarkEnv`
    - `useMapTextStyle`
- Core:
  - Uses: `packages/string-hash.hash53`
  - Exports (types):
    - `CameraRest`
    - `CameraView`
    - `ClusterPoint`
    - `DropHeadInput`
    - `DropIcon`
    - `DropShape`
    - `FlyPath`
    - `LatLng`
    - `MapArea`
    - `MapBounds`
    - `MapCamera`
    - `MapCrowd`
    - `MapCrowdRequest`
    - `MapMark`
    - `MapMarkPending`
    - `MapMarkResult`
    - `MapMarkText`
    - `MapOverlay`
    - `MapPadding`
    - `MapPath`
    - `MapPin`
    - `MapStrokeStyle`
    - `MapTileScheme`
    - `MapTone`
    - `MapViewport`
    - `PinCluster`
    - `PinSpot`
    - `SpotPoint`
  - Exports (values):
    - `cameraFor`
    - `clusterPins`
    - `clusterPinType`
    - `DEFAULT_CLUSTER_RADIUS_PX`
    - `DEFAULT_SPOT_NEAR_ZOOM`
    - `DEFAULT_SPOT_RADIUS_PX`
    - `dropHeadSvg`
    - `dropTipPx`
    - `escapeSvg`
    - `flyPath`
    - `framingOverlays`
    - `groupSpots`
    - `MAP_TONE_TOKEN`
    - `MARK_PENDING`
    - `MARK_SHADOW_PAD`
    - `markIdPrefix`
    - `markShadow`
    - `markSvg`
    - `markSvgProblem`
    - `MIXED_PIN_TYPE`
    - `NO_MAP_PADDING`
    - `overlayPositions`
    - `pinStackOrder`
    - `resolveCrowd`
    - `SINGLE_POINT_ZOOM`
    - `sliceWedges`
    - `viewFor`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-foreground`
    - `ui/tokens/density --space-md`
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shadow --shadow-md`
  - Imported by:
    - `apps/places/places-map`
    - `map/google`
    - `map/pin-layer`
    - `page/map`
    - `page/place/map-layer`
    - `primitives/data-view/map`
- Sub-plugins:
  - **`google`** — Google Maps JavaScript API as the map renderer: draws GeoMap overlays (pins as overlays holding each pin's contributed content, Google's own places hidden, paths as polylines, areas as polygons…
  - **`pin-layer`** — The map's pin layer, vendor-neutral: PinLayer holds every pin at rest as a scene of marks and draws a frame from a projection — one sprite per pin on one surface (marks rasterized once per look, a…

<!-- AUTOGENERATED:END -->
