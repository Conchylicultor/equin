# Places map zoom: why it still is not Google-Maps smooth

## Context

After the canvas pin layer (`research/2026-10-15-map-canvas-pin-layer.md`),
a `/places` zoom run (957 pins) costs 9.8 s of main-thread work against 8.1 s
for the same map with pins hidden. Pins now add about 20 %, yet the user still
finds zooming less responsive and fluid than google.com/maps. Those numbers do
not explain the gap, and three facts suggest they were the wrong measurement:

1. **The browser was not a real one.** `withBrowser` runs Playwright's
   `chrome-headless-shell` (`infra/deps/.../playwright-browser.ts:launchChromium`),
   which usually composites and rasterizes in software (SwiftShader). No
   GPU is the opposite of how the user's Chrome zooms, so "Paint / Layerize /
   raster" times say little about the real machine.
2. **It was throttled.** Agent sessions are launched through
   `backgroundPrefix()` (`conversations/runtime-tmux`), so the e2e Chromium
   inherits darwinbg (E-cores, low I/O and GPU priority), and an agent's e2e op
   takes a *background*-lane grant (`op-runtime/cli/direct-op.ts`). Every frame
   time measured from an agent is inflated.
3. **What the user feels may not be CPU at all.** The map is a raster Google
   map with no Map ID (`map/plugins/google/CLAUDE.md`), so `isFractionalZoomEnabled`
   is false. The only exception is the Fit flight in `internal/fly-camera.ts`.
   Each wheel or trackpad gesture is collected and then *snaps* to the next
   whole zoom level (2×) in a fixed animation, after which tiles at the new
   level are fetched and swapped in. google.com/maps is a WebGL vector map
   with fractional zoom: the scale follows the fingers every frame. That
   difference is about *how the map responds to input*, and no main-thread
   cost fixes it.

The goal is to measure, on the user's own Chrome (GPU, default priority),
where zoom time and jank come from (base map, pins, or React/app work),
compare that with google.com/maps doing the same gesture, and then fix the
largest cause.

## Hypotheses (ranked)

- **H1, the input model.** Integer-step raster zoom feels steppy even at
  0 ms of work: the gesture does not follow the fingers, there is an animation
  latency, and tiles are blurry and then swapped. Expected signature: when
  `map.getZoom()` is sampled every frame during a pinch, it holds still and
  then jumps one level, whereas google.com/maps changes it every frame.
- **H2, a spike at each zoom step.** Every whole-zoom change fires
  `zoom_changed`. That leads to `useProjectedZoom` → a `planPins` re-plan of
  957 pins plus a React render of `PinCanvas` and possibly new-scale sprite
  rasterization (`pin-canvas.tsx`). Each `idle` rebuilds the hidden
  `[data-map-pins]` list (one `hitTest` and one button per on-screen pin) and
  calls `onCameraRest` (remembered camera, `map/web/components/map-view.tsx`).
  These are single long tasks at the start or end of each step's animation,
  which would show up as hitches and not as total time.
- **H3, Google's own raster pipeline.** The 7.2 s of JS in the no-pins
  baseline is probably Google's tile and label code. If it dominates on a real
  GPU too, the only fix is the vector renderer (needs a Map ID, see Phase C).

## Phase A: measure for real (tools first, no behaviour change)

### A1. Make the existing scripts tell the truth about their environment

In `plugins/apps/plugins/places/plugins/places-map/e2e/zoom-perf.ts`, and in
the shared harness where the code is reusable:

- Print an **environment line** before every run: the headless or headed
  executable, the WebGL `UNMASKED_RENDERER` (SwiftShader vs Apple GPU), the
  device pixel ratio, the refresh interval (median rAF at idle), and the lane
  (`SINGULARITY_LANE`). A number from a software-GL or background-lane run is
  labelled as such, so it can never pass for a real one again. This helper
  belongs in `e2e-harness/e2e` (e.g. `describeRenderEnv(page)`), next to
  `withBrowser`.
- **Per-frame attribution** in place of totals alone: a
  `PerformanceObserver({ type: "long-animation-frame" })` probe (LoAF:
  per-frame script attribution with `sourceURL`), with each script bucketed as
  *google* (`googleapis`/`gstatic`), *app*, or *render* (style/layout/paint
  share of the frame). The report shows, for frames > 1 vsync, which bucket
  they belong to. This is the base map vs pins vs React split, frame by frame.
- **A zoom track**: sample `map.getZoom()`, or the `.gm-style` tile
  transform scale when the map instance is not reachable, every rAF. It shows
  whether the map follows the gesture (H1). It also logs `zoom_changed` /
  `idle` timestamps against the long frames (H2).
- Keep `--hide-pins` and `--trace`, and add `--headed`. The
  headless-vs-headed delta in the agent environment is itself a data point.

### A2. Make the probe reusable outside Playwright

Factor the probe (rAF intervals, LoAF bucketing, zoom track) into a single
self-contained snippet in `places-map/e2e/` that `zoom-perf.ts` injects with
`addInitScript`. The same snippet can then be pasted into or injected into any
page, including google.com/maps (where only the rAF and LoAF parts apply).

### A3. Run on the user's real Chrome, with google.com/maps as the reference

Through **Claude in Chrome**: the user's Chrome at default QoS, real GPU,
real trackpad. In a new tab, run the following on
`http://singularity.localhost:9000/places`, and separately on
`https://www.google.com/maps` framed on the same city at the same window
size:

1. Inject the A2 probe.
2. Ask the user for a ~10 s trackpad pinch in and out (synthetic wheel
   events lack trackpad gesture phases, so a real gesture is the ground
   truth), then a mouse-wheel run.
3. Read back the probe summary: frame-interval p50/p90/p99, LoAF count and
   buckets, and the zoom track.

On `/places`, repeat with pins hidden (the same CSS as `--hide-pins`), which
gives four columns: Google, base map, base map + pins, plus the agent-run
numbers for contrast. If Claude in Chrome cannot run the probe, the fallback
is that the user records a DevTools Performance trace of each and saves it to
the scratchpad. The existing `printTrace` summariser in `zoom-perf.ts` already
reads that format, extended to bucket by `sourceURL`.

**Gate A → B/C:** a table in this doc, appended as `## Findings`, with each
hypothesis confirmed or killed, and the fix order chosen by the numbers, not
by this ranking.

## Phase B: fixes inside the current raster map (expected first)

### B1. Continuous zoom (if H1 holds)

Set `isFractionalZoomEnabled: true` for the map's whole life. Google supports
it on raster maps: tiles are scaled between levels, so a pinch tracks the
fingers. `fly-camera.ts` then stops toggling it. Consequences:

- `zoom_changed` fires with fractional values on every frame of a pinch.
  `useProjectedZoom` must not drive `planPins` with them. The plan must be keyed
  to a **plan zoom** (`Math.round(zoom)`, the level whose spots or clusters
  are shown), and the per-frame draw keeps projecting at the true fractional
  scale, as it already does through `fromLatLngToContainerPixel`. The best
  form is for `PinCanvas` to take the plan level as a *derived* store read
  (`useProjectedZoom` returns the rounded level for planning, with the exact
  zoom only inside the draw), so a fractional zoom cannot re-plan by
  construction.
- Pin scale choice (`near`/`far`) and clustering thresholds read the plan
  zoom, so pins do not flicker between looks mid-pinch.
- Camera persistence (`CameraView.zoom`), `FitCamera` and `viewFor` already
  carry a number. Check that a remembered fractional zoom restores as is.
- The wheel: Google maps wheel deltas to fractional zoom when the flag is on.
  Verify that mouse-wheel notches still feel discrete enough (google.com/maps
  is the reference).

### B2. Remove the per-step spikes (if H2 shows long frames at zoom_changed/idle)

Whichever spikes the trace names:

- **Re-plan**: precompute the plan for the adjacent plan levels when idle
  (`planPins` is pure core), so crossing a level swaps a ready scene instead
  of computing one during the animation's first frame.
- **Hidden list rebuild on idle**: diff it by id (stable keys, no rebuild of
  unchanged buttons) or defer it with `requestIdleCallback`, so it never lands
  on the frame after the camera stops.
- **`onCameraRest`**: make sure the remembered-camera write re-renders nothing
  on the map's React tree.

### B3. Re-measure

Repeat A3 on the user's Chrome and A1 headed in the agent environment.

## Phase C: the vector map (only if H3 holds after B)

If Google's own raster pipeline still dominates on the real GPU, the
remaining step is the WebGL vector renderer. It needs a **Map ID** (a Cloud
Console setup by the user). A Map ID drops the inline `BASEMAP_STYLES`, so POI
hiding moves to cloud-based map styling. That reverses a recorded decision
(`integrations/google-maps` strips `mapId`) and is a product and setup
decision for the user. This doc stops at presenting the measured case for it.
The canvas pin layer is unaffected (an `OverlayView` works on vector maps, and
`WebGLOverlayView` becomes an option for the `PinPainter` seam).

## Critical files

- `plugins/apps/plugins/places/plugins/places-map/e2e/zoom-perf.ts`: env line,
  LoAF + zoom-track probe, `--headed`
- `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/`: `describeRenderEnv`
  (new, exported from the e2e barrel)
- `plugins/map/plugins/google/web/components/google-map-impl.tsx`: fractional zoom option
- `plugins/map/plugins/google/web/internal/fly-camera.ts`: stop toggling the flag
- `plugins/map/plugins/google/web/internal/projected-zoom.ts`: plan-level vs exact zoom
- `plugins/map/plugins/google/web/components/pin-canvas.tsx`: plan keyed to the
  plan level; hidden-list rebuild
- `plugins/map/plugins/google/CLAUDE.md`: zoom model documented

## Verification

- **Smooth** is defined numerically, from the reference run on the same
  Chrome. During a trackpad pinch on `/places`: frame-interval p90 within one
  vsync of google.com/maps' p90, no LoAF > 50 ms, and a zoom track that
  changes every frame (it follows the fingers) and does not step.
- Pins cost: the pins-shown vs pins-hidden delta stays ≤ ~20 % on the real
  run. With fractional zoom it must not grow (no per-frame re-plan: the count
  of `planPins` calls during a pinch equals the number of plan levels crossed).
- `./singularity test plugins/map`: plan-level derivation, and no re-plan
  across fractional changes within a level.
- `./singularity build`. Then run the e2e scripts that touch zoom or the
  camera: `zoom-perf.ts`, `zoom-profile.ts`, `wheel-over-pin.ts`,
  `camera-stays`, `click-away`, `open-card`. Hover, click and the card behave
  as before. The Fit flight still flies.
- The user confirms the feel on their machine. That remains the
  acceptance test.

## Findings

### 2026-10-16: the agent-side numbers are not a browser's

`zoom-perf.ts --no-profile` against main, from an agent session (headless):

```
[env] headless shell, gpu "ANGLE (… SwiftShader driver)", dpr 1, frame 104.2 ms, agent session (darwinbg inherited)
[probe] 452 frames in 46149 ms; gap p50 103.4 p90 109.6 p99 195.9
[probe] long frames 436 (42350 ms): script google 5427, app 476; style+layout+paint 335 ms
```

The page draws at **~10 fps at rest**, before any zoom. The long frames'
42 s is mostly time outside main-thread script and render (5.9 s + 0.3 s),
which points at software raster/compositing on demoted cores. App script is
under 0.5 s of it. So the 2026-10-15 figures (9.8 s vs 8.1 s main thread)
measured a renderer this slow and say nothing about the feel on the user's
Chrome. Claude in Chrome was not connected in this session, so the
real-browser run (A3) is a console snippet the user pastes: the A2 probe,
built from `plugins/map/e2e/zoom-probe.ts`.

### 2026-10-16: the user's Chrome. Smooth frames, wrong zoom model

Claude in Chrome on the user's machine: ANGLE Metal on an Apple M5 Pro, dpr 2,
120 Hz (8.3 ms frames). Same scripted run in both tabs: six real wheel
inputs of 5 ticks each, three in and three out, 1 s apart, from Paris at
zoom 12.

| | frames p50 / p99 / max | long frames (LoAF) | zoom per input | motion |
|---|---|---|---|---|
| `/places`, raster, whole zoom (today) | 8.3 / 9.4 / 17.7 ms | **0** | **+1 whole level (2×)** | starts 22–108 ms after input, then animates 215–950 ms after the input ends |
| google.com/maps (vector) | 8.3 / 9.4 / 16.9 ms | **0** | +0.63, fractional (12 → 12.63 → 13.25 → 13.88) | animated, proportional |
| `/places` with `isFractionalZoomEnabled: true` (set at runtime) | 8.3 / 9.4 / 66.6 ms | 4 (56–80 ms, no script attributed) | +0.26, **in one frame** (no animation) | a 42–67 ms hitch ~385 ms after each input (at rest); tiles ghost mid-zoom |

Hypotheses:

- **H2 (per-step spikes) and H3 (Google's raster JS) are dead.** On a real GPU
  `/places` renders a zoom run at full 120 Hz with no long frame, exactly as
  google.com/maps does. The pins, React and app work cost nothing
  perceptible. The 9.8 s / 8.1 s "main-thread" totals were an artefact of the
  agent environment (software GPU, darwinbg).
- **H1 (the input model) is the whole gap.** google.com/maps turns a wheel
  burst into a fractional, animated, proportional zoom. Our raster map
  turns it into a 2× jump with a delayed, fixed-length animation.
- **B1 (fractional zoom on the raster map) does not close it.** Google's
  raster renderer applies a fractional wheel step instantly, with no glide.
  It redraws tiles at rest with a 40–70 ms hitch and ghosts tile levels while
  scaling. It trades the step for jumps, a hitch and blur, so B1 is dropped.
- **What remains is the vector renderer (Phase C).** It is the renderer
  google.com/maps uses: fractional, animated, crisp labels at every zoom.
  It needs a Map ID, which moves POI hiding from inline `styles` to cloud
  styling. That is a setup and product decision for the user.
