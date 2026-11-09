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
  `uncoveredBounds(view, viewport, padding)` is the lat/lng box a view shows
  inside the area the padding leaves uncovered (what `CameraRest.visible`
  reports).
- `MapBounds` (`south`/`west`/`north`/`east`; `west > east` crosses the
  antimeridian, `-180..180` is every longitude) and `boundsContain(b, p)` —
  antimeridian-aware, edges included, longitudes compared wrapped.
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
  without ever moving the user's camera. `framingOverlays(overlays,
  focusIds?)` also narrows to the ids `focusIds` names when it is non-empty.
- **Marks** (`mark.ts`): a pin's look as data — `MapMark { key, svg, width,
  height, anchor, labelAt, texts? }`, one standalone SVG image placed with its
  `anchor` on the point. `key` names the look (equal keys = identical pixels:
  the sprite cache key); the SVG holds concrete colours only, no `<use>`, no
  `<text>` (`markSvgProblem`, enforced where it is rasterized AND where the DOM
  draws it); text goes in `texts` (`beside` at `labelAt`, in map-label paint,
  or `center` on the mark — its `anchor`, or a `point` of the box: a
  number on a badge drawn off the anchor). `markSvg`, `markIdPrefix` (ids unique per look —
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
  never remembered). `cameraOpen: "framed"` opens framed on the overlays
  (`focusIds` included) as a first visit does, yet still remembers each rest
  under the key — a view opened for one thing (a page's places) that hands
  its camera back to the map it was opened over.
- `opening` (optional, `"all"` default | `"densest"`) — what the map's first
  framing frames (never the Fit control, which frames every overlay):
  `"densest"` frames the area holding the most pins (core `densestPinIds`:
  pins bucketed on a fixed zoom-9 Mercator grid, the densest 3×3 block — ~150
  km at Paris — ties broken by position; O(pins), order-independent; `null`,
  so every overlay, when that block holds a single pin or every pin). A set
  spread over a home city and a few trips opens on the city, not the world.
  Ignored with `focusIds` (those are framed) and with a remembered camera.
  The renderer gets the narrowed set as `openingIds`.
- `onCameraRest` (optional) — the caller's: each time the camera rests (and
  once when the map first settles), a `CameraRest` (`center`, `zoom`,
  `bounds`, and `visible` — the part of `bounds` the `fitPadding` chrome
  leaves uncovered) — what a search biased to "this map area" reads, and what
  an "in view" count tests pins against (`boundsContain`). A change of
  `fitPadding` re-reports at once, though the camera did not move (a side
  panel toggling changes `visible`, not the camera).
- `fitRequest` (optional number) — a caller's own Fit: each time it changes
  (never its value at mount) the renderer frames the overlays exactly as its
  Fit control does (a flight, `frame: false` overlays left out).
- `focusIds` (optional overlay ids) — what the camera frames, when non-empty:
  the map's own first framing, the Fit control and `fitRequest` frame only the
  overlays it names (by their own `id`; a `frame: false` one still never), so
  a caller can frame one set among the others it draws (a page's places among
  the user's saved ones) — set it, then bump `fitRequest`. Absent or empty:
  every framed overlay.
- `hoveredId` / `onHoverChange` (optional) — hover linked to something outside
  the map (a result card, a list row): `hoveredId` lifts that pin as a pointer
  hover does — the same `hovered: true` state, so the same look (the
  pointer's own hover wins). `onHoverChange(id, hovered)` reports the pointer
  entering / leaving a pin as a claim / release (`LinkedHoverChange`), never a
  bare "none": the map's leave and a linked surface's enter for one pointer
  move arrive in no fixed order, and a "none" would erase the other's claim.
  The shared state every surface reports into is DataView's row-hover STORE
  (`LinkedHover`, `primitives/data-view` — owned there, since a row hover is
  a DataView concept and the list and gallery views read it without a map;
  see its *Row hover* section), read where it is drawn — `useHoveredId(hover)`
  (a map), `useIsHovered(hover, id)` (a row, a card). Never hold the hover
  as state in the component owning the surfaces: each pin the pointer
  crosses then re-renders it and everything under it (the Places screen
  re-rendered whole, 5–80×/s while the pointer glided over its pins).
- **Chrome over the tiles wears the tiles' scheme.** The tiles have one
  scheme whatever the app's (`renderer.tiles`: Google's are light), so what is
  drawn OVER them — the renderer's own controls (Fit), the empty notice, and
  a host's `controls` (optional `ReactNode`: its own floating buttons, placed
  by the host with a `Pin`; drawn only over a mounted map) — sits inside
  `<MapChrome>`, a `<Theme surface="none" className="contents">` boundary
  wearing the map-chrome **fixed theme** of that scheme (`map-chrome-light` /
  `map-chrome-dark`, contributed through `ThemeEngine.FixedTheme`, no tokens of
  their own — the schema defaults' light or dark half). So a dark Pages app
  shows light controls over the light map, and their tooltips and popovers
  stay light too (a fixed theme's popups keep it). Fixed, not a sub-theme: a
  sub-theme names a few tokens and inherits the rest from the app, so every
  colour it does not name would stay dark, and its popups leave it. `MapView`
  provides the scheme to `MapChrome` (it throws outside a `MapView`); a
  renderer wraps its own controls in it. **Pins are never inside it**: the
  mark host, the pin canvas and lifted pins resolve colours in the app's own
  scope, so an app's palette (Places') still colours its pins.
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
  `pick`, `initialCamera`, `onCameraRest`, `fitRequest`, `focusIds` — a
  renderer frames `framingOverlays(overlays, focusIds)`). **A renderer never styles a pin**: it draws every pin at rest from
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
  `{ pin, tiles }` and the renderer's `MapPinState`: `active`, `hovered`
  (the pointer's hover OR the host's linked `hoveredId` — a pin draws its hover
  look from this prop, never from CSS `:hover`, which a linked hover never
  triggers, so a row-hovered pin would lift into the DOM at rest; a lifted
  pin is first rendered with `active` / `hovered` both `false`, then its real
  state once on screen, so its CSS transitions animate the lift — fade a name
  in rather than mounting it), `scale`
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

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Vendor-neutral map primitive: <MapView overlays/> draws pins, paths and areas through the first GeoMap.Renderer (showing its set-up action while it is blocked, and a loud state when none is installed), with every pin's look contributed through the GeoMap.Pin dispatch slot keyed on its pinType, and a crowd mode the caller picks: clustering (every group of nearby pins drawn through the GeoMap.Cluster dispatch slot keyed on the pinType its pins share) or spots (every pin stays drawn — far out as a compact centred mark, with the size of each spot beside its lead pin). Chrome drawn over the tiles — the renderer's Fit control, the empty notice and a host's `controls` — wears the map-chrome fixed theme of the tiles' scheme (<MapChrome>), so it is light over light tiles whatever the app's scheme.
- Web:
  - Slots:
    - `GeoMap.Renderer`
    - `GeoMap.Pin`
    - `GeoMap.Cluster`
  - Slot contributors:
    - `GeoMap.Renderer` ← `map.google`
    - `GeoMap.Pin` ← `apps.places.places-map`
    - `GeoMap.Pin` ← `page.place.map-layer`
  - Contributes:
    - `ThemeEngine.FixedTheme` "Map controls (dark tiles)"
    - `ThemeEngine.FixedTheme` "Map controls (light tiles)"
  - Uses: 22 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/persistent-draft` ×3
    - `primitives/dom/web-storage` ×2
    - `primitives/slot-render` ×2
    - `primitives/css/center.Center`
    - `primitives/css/coords.Placed`
    - `primitives/css/layer.Layer`
    - `primitives/css/line.Line`
    - `primitives/css/motion.Presence`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/css/ui-kit.cn`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/loading.Loading`
    - `ui/icons.useIconMarkup`
    - `ui/theme-engine.ThemeEngine`
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
    - `MapChrome`
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
    - `boundsContain`
    - `cameraFor`
    - `clusterPins`
    - `clusterPinType`
    - `DEFAULT_CLUSTER_RADIUS_PX`
    - `DEFAULT_SPOT_NEAR_ZOOM`
    - `DEFAULT_SPOT_RADIUS_PX`
    - `densestPinIds`
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
    - `uncoveredBounds`
    - `viewFor`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-foreground`
    - `ui/tokens/density --space-md`
    - `ui/tokens/shadow --shadow`
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
