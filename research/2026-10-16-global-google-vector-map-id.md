# Vector Google map through a user-made Map ID

## Context

`research/2026-10-16-map-zoom-smoothness.md` measured, on the user's Chrome,
that `/places` already renders zoom at a full 120 Hz with no long frames,
exactly like google.com/maps. The remaining gap is the **zoom model**:

- Our raster map (no Map ID) snaps each wheel burst to a whole level (2×),
  with a delayed, fixed animation.
- google.com/maps is a vector map: fractional, animated and proportional.
- Fractional zoom on the raster map was tried at runtime and rejected:
  instant jumps, a 40–70 ms hitch at rest, ghosting tiles.

The vector renderer needs a **Map ID**. The user rejected letting the app hold
Cloud permissions (the Map Management API only takes the broad
`cloud-platform` scope). So the user makes the Map ID in the Cloud Console,
guided by a wizard like the other account setups, and the app stores only the
Map ID string.

Outcome:

- **With a Map ID**: every Google map is a vector map that zooms like
  google.com/maps, still hiding Google's own places, with pins unchanged.
- **Without one**: today's raster map, unchanged.

## Design

### 1. One basemap style, two spellings (`integrations/google-maps/core`)

The rule "hide Google's places" lives once, as `BASEMAP_STYLE` (the
`MapTypeStyle[]` that `map/google` passes today as `BASEMAP_STYLES`, moved
here). There are two readers:

- The raster map passes it as inline `styles` (today).
- The wizard shows `JSON.stringify(BASEMAP_STYLE)` in a `StepCommand`, for the
  Console's map-style **JSON import**. Google converts legacy JSON to its
  current format on import.

So the vector style and the raster style cannot drift apart. The constant
moves from `map/google/web/components/google-map-impl.tsx` into GM core,
because `map/google` already imports GM and the reverse would be a cycle.

### 2. Map ID in the browser config (`integrations/google-maps`)

The stored file gains the field it strips today:

- **Core** (`core/browser-config.ts`):
  - `MAP_ID_PATTERN`: lenient (hex/alnum, length bounds). Confirm it against
    the user's real Map ID before tightening.
  - The live value's set arm becomes
    `{ kind: "set"; browserKey: string; mapId: string | null }`.
  - Two new endpoints, `setMapsMapId` (body `{ mapId }`) and
    `clearMapsMapId`, so the key and the Map ID are saved and removed
    independently.
  - A Map ID without a key is unspellable: the endpoint refuses when no key
    is set.
- **Server** (`server/internal/browser-config-store.ts`,
  `browser-config-resource.ts`):
  - `StoredSchema = { browserKey, mapId?: string }`, and the "stripped on read"
    comment goes.
  - Writes are read-modify-write of the one file, under the existing
    atomic rename, then `notify()`.
  - Saving a new browser key keeps the Map ID. "Remove browser key" removes
    both.
- **Web**: `useMapsBrowserConfig()` carries `mapId`. `MapsBrowserConfigState`
  gets the field.
- **Docs**: GM `CLAUDE.md` replaces "There is no Map ID" with the two-tier
  model and why.

### 3. The wizard: a "Smooth zoom" part of the Live map pane

In `web/components/live-map-setup-pane.tsx`, below the browser-key steps, an
optional second `Steps` block (`primitives/setup-steps`) is shown once a key
is saved. Its title is "Smooth zoom (vector map), optional".

1. **Create the map style.**
   - `StepLink` to Console → Google Maps Platform → Map Styles → Create style.
   - Then the JSON tab → Import, with
     `StepCommand text={BASEMAP_STYLE_JSON} title="Copy style JSON"`.
   - `StepNote`: save it under a name, for example "Singularity basemap".
2. **Create the Map ID.**
   - `StepLink` to Map Management → Create Map ID, with type **JavaScript**
     and **Vector**.
   - Tilt and Rotation **unchecked**, because the pin canvas projects in 2D.
   - Then: associate the style from step 1 to it (light mode).
   - `StepNote`: it must be in the same project as the browser key.
3. **Paste the Map ID.**
   - `Input` with draft, `MAP_ID_PATTERN` inline error, Save →
     `setMapsMapId`, and a "Remove Map ID" button.
4. **Check it.**
   - A `StepDone` driven by the **reported rendering type** (§5):
     - "Vector map confirmed" once a map has drawn as vector with this ID.
     - A loud "This Map ID draws as raster: create a *Vector* JavaScript Map
       ID" when Google answered raster.
     - "Open a map to check" before any map was drawn. The step links to
       Places.

Step states follow the pane's existing pattern (`done` once the value is saved
or confirmed).

### 4. Renderer: two basemaps, one decision (`map/google/web`)

`GoogleMapRenderer` already reads `useMapsBrowserConfig()`. It derives a
`Basemap` union once:

- `{ kind: "vector"; mapId }`: `<GoogleMap mapId={mapId} colorScheme=…
  tiltInteractionEnabled={false} headingInteractionEnabled={false}>` and **no
  `styles`**. Google ignores and warns on `styles` with a Map ID; the style
  is cloud-side now.
- `{ kind: "raster" }`: exactly today (`styles={BASEMAP_STYLE}`).

Consequences inside the renderer:

- **Fractional zoom is the vector default.**
  - `fly-camera.ts` stops forcing `isFractionalZoomEnabled: false` on landing.
    It restores the value it found, so a vector map stays fractional and a
    raster flight still lands whole.
  - `viewFor`'s whole-zoom framing (`map/core/fly.ts`) stays. A whole zoom is
    a fine landing on either map.
- **The pin plan must not re-run every frame.**
  - On a vector map `zoom_changed` fires with fractional values throughout a
    zoom. `PinCanvas` then plans 957 pins per frame (`useProjectedZoom` →
    `planPins` memo).
  - Fix by construction: `PinCanvas` plans at a **plan level**,
    `usePlanZoom(map)`. It is a `useSyncExternalStore` whose snapshot is
    `Math.round(map.getZoom())`, so React bails out until a level is crossed.
  - The frame draw keeps projecting at the exact camera
    (`fromLatLngToContainerPixel` per draw, unchanged).
  - `planSpots`' `zoom >= nearZoom` and the spot radius then switch at half
    levels, which is the rounded level's behaviour.
  - `useProjectedZoom` stays for `zoomTo` (cluster click), which wants the
    exact zoom.
- **Pins on WebGL.**
  - `PinCanvas` and `OverlayPin` are plain `OverlayView`s, which Google
    supports on vector maps (drawn above the WebGL canvas).
  - Tilt and rotation are disabled both in the Map ID and in the options, so
    the 2D projection holds.
  - Verify hover/click/lift on the vector map (§Verification).

### 5. Rendering-type report: the wizard's check and the loud failure

Once the map is idle, the renderer reads `map.getRenderingType()`.

- **With a Map ID, the answer is reported** to a GM web store,
  `reportMapRendering({ mapId, type })`, owned by GM since GM owns the Map ID.
  The pane's step 4 reads it with `useMapIdCheck(mapId)`.
- **A Map ID that renders RASTER** (wrong type, wrong project, deleted) is a
  visible map notice "Map ID isn't a vector map, open setup". It reuses the
  `MapsMapAccessAction` link shape (`openPane.link(liveMapSetupPane)`). It is
  never a silent raster fallback.
- **A Map ID that Google rejects outright** surfaces through the existing
  `gm_authFailure` / load-error card.

The store is in-memory (page lifetime). It is a check, not state that needs
persisting.

### v2: in-pane preview (supersedes the §3 order and the §5 store)

User feedback: "Check it" needed a map opened elsewhere, the step order forced
going back, and the instructions were easy to miss. Now:

- The page-global `reportMapRendering` / `useMapIdCheck` store is deleted. The
  pane draws its own **preview map** (central Paris, zoom 16) with the valid
  draft Map ID or the saved one, reads `getRenderingType()` and shows
  Checking / Vector / Raster. A changed id re-checks automatically; **Check
  again** remounts the map (Google takes minutes to serve changes).
- The preview is a slot, `LiveMapSetup.MapIdPreview`, because Google map
  creation belongs to `map/google`, which imports `integrations/google-maps`.
- Steps: 1 create the Map ID (JavaScript, Vector, tilt/rotation off), 2 paste
  it (preview = the vector check), 3 hide Google's places (create the style,
  import the JSON, associate it with the Map ID; confirmed by eye on the same
  preview, there being no signal for hidden POIs).
- Instructions are `StepActions` / `StepAction` / `StepKey` in
  `primitives/setup-steps`: a numbered, full-contrast click-path with the exact
  Console labels in bold.
- The on-map `MapIdRasterNotice` stays, local to the renderer.

## Critical files

- `plugins/integrations/plugins/google-maps/core/browser-config.ts`: `mapId`,
  `MAP_ID_PATTERN`, `BASEMAP_STYLE`, endpoints
- `plugins/integrations/plugins/google-maps/server/internal/browser-config-store.ts`,
  `browser-config-resource.ts`: stored field, set/clear handlers
- `plugins/integrations/plugins/google-maps/web/components/live-map-setup-pane.tsx`:
  the Smooth zoom steps
- `plugins/integrations/plugins/google-maps/web/internal/`: `use-maps-browser-config.ts`
  (`mapId`), new `map-rendering-report.ts` (`reportMapRendering`, `useMapIdCheck`)
- `plugins/map/plugins/google/web/components/google-map-impl.tsx`: `Basemap`
  decision, `mapId` / no `styles`, interaction flags, rendering report, notice
- `plugins/map/plugins/google/web/internal/fly-camera.ts`: restore, not force-off
- `plugins/map/plugins/google/web/internal/projected-zoom.ts`: `usePlanZoom`
- `plugins/map/plugins/google/web/components/pin-canvas.tsx`: plan on the plan zoom
- Docs: GM `CLAUDE.md`, `map/plugins/google/CLAUDE.md` (no-Map-ID section → two
  basemaps), `research/2026-10-16-map-zoom-smoothness.md` (link)

Reused as is: `primitives/setup-steps` (`Steps`, `Step`, `StepLink`,
`StepCommand`, `StepNote`, `StepDone`), the `liveValue` / `serveValue`
browser-config resource and its file watcher, `fetchEndpoint`, and
`openPane.link(liveMapSetupPane)`.

## Verification

- `./singularity test plugins/integrations/plugins/google-maps plugins/map`:
  - store round-trip (key kept when the Map ID changes, both cleared together,
    a Map ID refused without a key)
  - `MAP_ID_PATTERN`
  - `usePlanZoom` re-renders only on level crossings
  - `planPins` unchanged
- `./singularity build`, then with the user (Claude in Chrome on
  `http://<worktree>.localhost:9000`):
  1. Settings → Accounts → Google Maps → Live map: the Smooth zoom steps.
     Copy the JSON, then the user creates the style and the Map ID in the
     Console and pastes it.
  2. Open `/places`. Step 4 reads "Vector map confirmed", and Google's places
     stay hidden.
  3. Re-run the `research/2026-10-16-map-zoom-smoothness.md` scripted wheel
     run. Each burst must glide fractionally like google.com/maps (+~0.6 per
     5 ticks, animated) with p99 ≈ one vsync and 0 long frames. The count of
     `planPins` runs during a zoom equals the levels crossed.
  4. The pins: hover lifts, click opens the card, spot counts, Fit flies and
     the map stays fractional after. The user's trackpad pinch is the
     acceptance test.
  5. Remove the Map ID: the raster map returns, unchanged.
  6. A deliberately raster Map ID shows the loud notice.
- e2e: the existing places-map and map/google scripts pass with no Map ID
  (raster, headless). `zoom-perf.ts`'s motion tracking reads inline
  transforms, which a vector map does not have. Its frame and long-frame
  numbers still apply, and its `[probe]` line already says "motion not
  tracked" when there is nothing to read.
- `./singularity check`.

## Risks

- **Style conversion is approximate.** Google converts imported legacy JSON.
  If POI labels still show, the step's note says to switch off "Points of
  interest" in the style editor. That is checked during verification.
- **Style changes propagate with a delay** (Google cites hours on mobile, less
  on web). That affects only later edits, not the first setup, which the
  wizard says.
- **Dark tiles** stay out of scope (`GOOGLE_TILES` is `light`). A Map ID can
  carry a dark style later, keyed by `colorScheme`.
