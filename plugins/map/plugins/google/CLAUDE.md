# map/google

The only map-vendor code in the repo. Everything else draws maps through
`GeoMap` (`plugins/map`).

- **Credential**: the public browser key, read through
  `useMapsBrowserConfig` from `integrations/google-maps`. It is not the server-only
  Places key; that plugin's CLAUDE.md explains why there are two.
- **Loud failure**: Google reports a refused key only through
  `window.gm_authFailure`, and `@vis.gl/react-google-maps` 1.10 no longer hooks
  it. `internal/auth-failure.ts` installs it and chains to any earlier handler.
  The canvas then swaps itself for `MapErrorCard`. A refusal lasts for the whole
  page, because the script loads once with one key, so after a fix the user has
  to reload.
- **Tones**: Google strokes take colour strings, so `useToneColors` resolves each
  `MapTone` token against the map's own element and normalises it to `rgb()`,
  because a theme may use `oklch`. A stroke is not drawn until its colour is known.
- **Google's own places are hidden.** On a map whose content is the user's
  pins, Google's shops, museums and restaurants read as more pins. The canvas
  turns POI labels off with an inline map style (`BASEMAP_STYLES`), keeping
  streets, districts, transit and park greenery as context.
- **Two basemaps, chosen by the stored Map ID**
  (`integrations/google-maps`, `useMapsBrowserConfig().mapId`):
  - **None: the raster map.** It is styled inline (`BASEMAP_STYLE`) and zooms
    by whole levels.
  - **A Map ID: the vector map.** It zooms fractionally (wheel and pinch
    glide), is styled by the Map ID's cloud style (`styles` is not passed,
    since Google ignores it), and has tilt and heading interaction off.
  - The vector map's wheel is ours (`internal/wheel-zoom.ts`, Google's
    `scrollwheel` off): Google has no wheel speed and zooms several levels per
    scroll burst. A scroll moves a fixed levels-per-pixel times the user's
    **Scroll zoom speed** (`shared/config.ts`), at most one level per
    event, and glides there; a pinch
    (ctrl+wheel) follows the fingers 1:1. The raster map keeps Google's
    whole-level wheel, and so does a Map ID Google draws raster: `WheelZoom`
    switches on `getRenderingType()`, not on the Map ID.
  - A Map ID is fixed at creation, so `GoogleMapCanvas` is keyed by it.
  - `RasterNotice` shows `MapIdRasterNotice` when a Map ID still drew raster
    (local to the map). The setup pane's check is separate: `MapIdPreview`
    (`components/map-id-preview.tsx`) is this plugin's contribution to
    `integrations/google-maps`'s `LiveMapSetup.MapIdPreview` slot, a bare map
    that reports `getRenderingType()`.
  - No Advanced Markers either way: they are a DOM element per pin, the cost
    below.
- **Pins: one canvas** (`components/pin-canvas.tsx`). A single `OverlayView`
  holds a viewport-sized `<canvas data-map-pin-canvas>` in the `overlayLayer`
  pane and repaints it through `map/pin-layer`'s `PinLayer` on every `draw()`
  (each frame of a zoom) and each `bounds_changed` (a drag, coalesced to one
  frame): the canvas sits at the container's top-left in div pixels, each pin
  is projected with `fromLatLngToContainerPixel`. The plan (`planPins`: spots,
  clusters, stacking) is recomputed in world pixels at the **plan zoom**
  (`usePlanZoom`: the zoom rounded to a whole level), so a vector map's
  fractional zoom re-plans once per level crossed, never per frame or pan; marks are cached per (pin, scale). **Lifting**: a `pointermove` on the
  map div hit-tests the canvas; the hovered item and the active pin render as
  `OverlayPin`s (`renderPin` / `renderCluster`) at their mark's anchor and are
  left off the canvas — so a click always lands on a real button. A tap with
  no hover (touch) is hit-tested on the map's own `click` (not in pick mode).
  The pins on screen are listed in a visually hidden `[data-map-pins]` list of
  buttons (`aria-label`, `data-x` / `data-y` = the point in map px), rebuilt on
  `idle` and when a scene is swapped in — the keyboard / assistive-tech route
  and what e2e drives (`@plugins/map/e2e`).
- **`OverlayPin`** is the DOM mechanism for a lifted pin: a plain `OverlayView`
  that portals the pin's React content into the `overlayMouseTarget` pane,
  translated so its `anchor` (the mark's) sits on the point. It owns click and
  Enter/Space activation (`role="button"`), the stacking order, and stopping
  presses and clicks at the pin so they do not pan the map or count as a map
  click. The wheel is NOT stopped (unlike Google's
  `preventMapHitsAndGesturesFrom`): scrolling over a pin zooms the map like
  anywhere else, instead of scrolling the page.
- **Clustering** (`crowd.kind === "cluster"`): pins are projected to world
  pixels (`getProjection().fromLatLngToPoint` × 2^zoom), which depend on the
  zoom alone, so only `zoom_changed` re-clusters, never a pan. A cluster is
  one more canvas item (its mark, with the count drawn in its middle); a click
  on it frames its pins.
- **Camera**: `FitCamera` frames once (the first time there are overlays,
  `moveCamera` straight there); `FitControl` — our `IconButton` on an overlay
  surface, placed with `MapControl` at `RIGHT_BOTTOM` above Google's camera
  control — flies there on click (`internal/fly-camera.ts`: one `moveCamera`
  per animation frame along the core's `flyPath`, fractional zoom switched on
  for the flight and put back as it was (a raster map snaps to whole zooms, a
  vector map stays fractional); a
  press, wheel or drag stops it). Both target `frameView` → core `viewFor`.
  With an `initialCamera` (a remembered view) the map opens there and
  `FitCamera` is not mounted; `ReportCameraRest` reports Google's `idle`
  (the camera at rest) through `onCameraRest`.
- **Pick mode** (`pick`): `draggableCursor: "crosshair"` and the map's own
  `click` (a pin stops its own clicks, so a pin click never lands there). The
  camera frames once, so a pin dropped or moved where the user clicked never
  re-frames the map.
- **Covered edges** (`fitPadding`): `fitBounds` gets `FIT_PADDING_PX` plus
  each edge's padding (`fitBoundsPadding`, also for a cluster click); a single
  point and a focused pin are centred in the uncovered area (`paddedCenter`,
  a world-pixel shift by half the difference of opposite paddings), and
  `isInUncoveredArea` projects the pin against the map div's size minus the
  padding to decide whether a focus pans at all.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Google Maps JavaScript API as the map renderer: draws GeoMap overlays (pins as overlays holding each pin's contributed content, Google's own places hidden, paths as polylines, areas as polygons, strokes in resolved theme tones), frames them once and then only from its Fit control, zooms the vector map on the wheel at the user's Scroll zoom speed setting, shows the live-map set-up action until a browser key is set, and replaces Google's silent grey map with an error card when the key is refused. Draws the Live map setup's Map ID preview map. Lazily loaded off the boot wave. Stores the Google map's settings (Scroll zoom speed) so Settings can edit them.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "config"
    - `GeoMap.Renderer` "Google Maps" → `LazyBoundary`
    - `LiveMapSetup.MapIdPreview` → `MapIdPreview`
  - Uses: 23 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `integrations/google-maps` ×6
    - `map/pin-layer` ×3
    - `map` ×3
    - `config_v2` ×2
    - `primitives/css/spacing` ×2
    - `primitives/css/center.Center`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/lazy-component.lazyComponent`
    - `primitives/loading.Loading`
- Server:
  - Contributes: `ConfigV2.Register` "config"
  - Uses: `config_v2.ConfigV2`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/density --space-md`
    - `ui/tokens/shape --spacing`

<!-- AUTOGENERATED:END -->
