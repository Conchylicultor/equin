# Map pin layer: every pin on one canvas, DOM only for the pins you touch

## Context

Wheel-zooming `/places` (957 saved places, all in view at city zoom) is laggy
next to Google Maps. Measured with
`plugins/apps/plugins/places/plugins/places-map/e2e/zoom-perf.ts` (main, same
zoom run, pins shown vs `--hide-pins`):

| main thread | pins | no pins |
|---|---|---|
| total | 36.9 s | 11.8 s |
| **Layerize** | **17.2 s (~94 ms/frame)** | 0.15 s |
| Paint / HitTest / PrePaint | 4.9 / 3.5 / 1.9 s | 0.6 / 0.7 / 0.25 s |
| JS (FunctionCall) | 7.3 s | 7.2 s |

Origin (rate × cost): every pin is its own `google.maps.OverlayView`
(`map/plugins/google/web/components/overlay-pin.tsx`) — a positioned,
z-indexed DOM subtree. Google calls each one's `draw()` on **every animation
frame**, which moves ~1000 boxes, so Chrome repaints and re-layerizes ~1000
stacking contexts per frame. Stripping CSS effects only took Layerize 17 → 8 s:
the per-pin DOM itself is the cost, not its styling. The legitimate requirement
is "~1000 marks that track the map"; drawing them as 1000 live DOM nodes is
not. Google draws its own pins as pixels on one surface — so do we.

Outcome: one canvas holds every pin at rest (≈1 ms/frame for 1000 sprites,
one compositor layer); a real DOM pin exists only for the pin being hovered
and the selected one, so hover, click, labels and the card keep today's look
and behaviour. The drawing backend sits behind an interface so WebGL
(`WebGLOverlayView` / deck.gl) can replace Canvas 2D later.

## Design

### 1. A pin's look is a **mark**: data, not a React tree

New vendor-neutral type in `map/core` (`core/mark.ts`):

```ts
interface MapMark {
  key: string;              // identity of the look: equal keys ⇒ identical pixels (sprite cache key)
  svg: string;              // a standalone <svg> (no <use>, no CSS vars, no web fonts) — concrete colours
  width: number; height: number;   // CSS px
  anchor: { x: number; y: number }; // the map point inside the box (tip, centre)
  label?: { text: string; show: "always" | "interactive" }; // drawn beside the mark (MapLabel paint)
}
```

`GeoMap.Pin` and `GeoMap.Cluster` contributions gain a required pure
`mark(pin | pins, state, env) => MapMark | MarkPending` next to their
`component`. `env` hands over what a pure function cannot read:
`env.icon(ref, { active }) → { kind: "ready", svg } | { kind: "pending" }`,
`env.color(css) → "rgb(…)"` (resolves tokens / `color-mix` / relative oklch via
a probe element, generalising `map/plugins/google/web/internal/tone-colors.ts`)
and `env.tiles`. `DefaultPin` / `DefaultCluster` get marks too, so the
fallback path never needs DOM.

**One look, two surfaces.** The React `component` (used for hovered / active
pins) draws the SAME mark: a new `<MapMarkImage mark/>` (map/web) renders the
mark's SVG inline at the same box and anchor, and the component wraps it with
what only DOM does well — hover lift/scale transitions, the halo name label,
the active grow. So the canvas sprite and the promoted DOM pin can never
drift apart: they are one SVG string.

### 2. Places pins as SVG

`places-map/web/components/place-drop.tsx`: `PlaceDropHead` becomes a pure
`placeDropSvg(visual, { shape, sizePx, iconSvg, resolve })` (rotated
rounded-square path with the tip corner square, 2px white border, conic
slices as wedge paths from 45° — SVG has no conic-gradient —, the pale 78 %
veil, the icon `<path>`s centred unrotated, an SVG filter for the multi-colour
icon shadow and `shadow-md`). `PlaceDropHead` renders that SVG, so gallery
covers and list glyphs keep sharing the one paint. Paint helpers stay in
`web/internal/pin-paint.ts` (tested). `SavedPlacePin` gains
`mark: savedPlaceMark` (near: drop + ground shadow, 24×29 anchored at the
tip; far: 19 px disc anchored at the centre); its component composes
`<MapMarkImage>` + `Name`. The page map-layer `PlacePin` gets the same treatment
(its always-on label → `label.show: "always"`).

### 3. Icons as markup — `ui/icons` web gains a reader

`useIconMarkup()` (icons web barrel, over `sprite-store.ts` /
`runtime-symbol-store.ts`): returns `(ref, { active }) → ready svg | pending`
for the caller's icon scope style (`useIconStyle` + `styleKeyOf`), subscribed
to the stores so a sprite landing re-renders, and wanting a missing style /
runtime symbol exactly as `<Icon>` does. It extracts the `<symbol>`'s inner
paths into a standalone `<svg viewBox>`. No reading `document.getElementById`.

### 4. The pin layer — `map/plugins/pin-layer` (new sub-plugin)

- **core** (pure, unit-tested): `drawList({ pins, marks, crowd, zoom,
  project, activeId, promotedIds }) → DrawItem[]` — reuses `groupSpots`,
  `clusterPins`, `pinStackOrder` from `map/core`; owns the spot/cluster
  grouping that `SpotPins` / `ClusteredPins` do in React today, the spot-count
  label as a renderer-drawn label (lifted out of `SavedPlacePin` / `DefaultPin`,
  which both draw it identically), z-order, and drops promoted pins (drawn in
  DOM instead). `hitTest(items, x, y)` over the existing grid (`core/grid.ts`)
  — topmost item whose mark box contains the point.
- **web**: `rasterizeMark(mark, dpr)` (SVG → Blob URL → `createImageBitmap`,
  cached by `key@dpr`; all pending keys of a draw land together so pins
  appear at once, never one by one); `PinPainter` interface
  `{ resize(w, h, dpr); draw(items, sprites, labels); dispose() }` with
  `createCanvas2dPainter(canvas)` as the only implementation now (labels:
  `strokeText` halo + `fillText` in the label font, truncated at 192 px).
  The swappable backend is this interface.

### 5. Google renderer

`map/plugins/google/web/components/`:

- `pin-canvas.tsx` — ONE `OverlayView` hosting a viewport-sized canvas in the
  `overlayLayer` pane. On `draw()` (every animation frame) and
  `bounds_changed` (drag), coalesced to one rAF: place the canvas at the
  container's top-left in div pixels, project each pin
  (`fromLatLngToContainerPixel`; cull off-screen), recompute `drawList` only
  when zoom / pins / crowd / active / promoted change, paint. React holds data
  only — no per-pin React tree, so a zoom does not re-render 957 components.
- **Hover promotion**: the map's `mousemove` → `hitTest` → `hoveredId`
  state; the hovered pin and the active pin render as today's `OverlayPin`
  with the contribution's `component` (role=button, Enter/Space, stopped
  presses, wheel passes through — `overlay-pin.tsx` unchanged), and are
  skipped on the canvas. So clicks always land on a real DOM pin; touch (no
  hover) uses the map `click` + `hitTest` → `onActivate`. Cursor: pointer over
  a hit.
- `SpotPins` / `ClusteredPins` / the non-crowded pin loop in
  `google-map-impl.tsx` are replaced by `PinCanvas` + the promoted
  `OverlayPin`s. Paths and areas stay Google `Polyline` / `Polygon`.

### 6. Accessibility and e2e

Canvas pins are not tab stops (today 957 are — arguably worse). A
visually-hidden list of the on-screen pins (`role=button`, `aria-label`,
Enter activates), rebuilt on `idle` only — static, unpositioned, so it costs no
layerize — keeps keyboard / screen-reader reach and gives e2e stable names.
New `map/e2e` helpers (`mapPins(page)`, `clickPin(page, name)` = hover the
pin's point, then click the promoted DOM pin; positions read from the
hidden list's `data-x/-y` written on idle). Update the DOM-keyed scripts:
places-map `click-away`, `custom-pin`, `open-card`, `camera-stays`,
`backdrop-panel`, `load-perf`, `tour`, `zoom-perf`; map/google
`wheel-over-pin`, `zoom-profile`; page `place-pin-verify`, `map-block`.

## Phasing (one branch, each step builds)

1. `MapMark` + `mark` on the slots + `MapMarkImage`; `useIconMarkup`; marks for
   `DefaultPin`, `DefaultCluster`, `SavedPlacePin`, page `PlacePin` (components
   switched to `MapMarkImage`) — visually unchanged, verify by screenshots.
2. `pin-layer` core (drawList, hitTest, tests) + raster cache + Canvas 2D
   painter.
3. Google `PinCanvas` + promotion + hidden list; remove `SpotPins` /
   `ClusteredPins`.
4. e2e helpers + script updates; docs (`map/CLAUDE.md`, google CLAUDE.md,
   places-map CLAUDE.md).

## Verification

- `./singularity test plugins/map plugins/apps/plugins/places` — drawList
  (spot leads, z-order, promoted skipped, culling), hitTest (overlap → top),
  mark SVG snapshots (`pin-paint` / `placeDropSvg`).
- `./singularity build`, then `zoom-perf.ts` (with `--trace`): target Layerize
  ≈ the `--hide-pins` baseline and total main-thread time within ~1.3× of it.
- Look: `compare-diff`-style screenshot of `/places` before/after at far and
  near zoom (light + dark tiles) — pins pixel-close; hover a pin → lift +
  name; click → card; spot counts beside leads.
- Updated e2e scripts pass; `./singularity check`.

## Risks

- SVG-as-image cannot use web fonts or CSS vars — marks carry concrete
  colours and no text (labels are painter-drawn). Enforce: `rasterizeMark`
  throws on `var(` / `<use` / `<text` in a mark.
- Hover → DOM swap must be pixel-identical at rest (same SVG, same anchor), or
  pins visibly "jump" on hover; covered by the shared mark.
- Pending icons: a pin whose icon markup is pending is not drawn until it lands
  (no stand-in glyph); resident sprites make this rare.
