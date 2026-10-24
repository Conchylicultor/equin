# Piano roll: say "GPU unavailable" instead of drawing letters with no notes

## Context

On 2026-09-21 the piano roll showed note letters but no note rectangles for a
whole day, then worked again on 2026-09-22 with no commit in between.

`~/.singularity/worktrees/singularity/logs/piano-roll.jsonl` explains it: every
load on Sep 21 logged `pixi backend: canvas`, and loads before and after logged
`webgpu`. The browser had no usable GPU that day (most likely Chrome turned off
hardware acceleration after its GPU process crashed, until the browser
restarted).

Pixi's auto-detect tries `webgpu`, then `webgl`, then the plain 2D **canvas**
renderer (`autoDetectRenderer.mjs`: `preference: "webgpu"` expands to
`["webgpu", "webgl", "canvas"]`). On the canvas renderer:

- note letters and bar numbers (`BitmapText`, `labels.ts`) still draw;
- the notes don't draw. They are one custom mesh with a GLSL/WGSL shader
  (`note-mesh.ts`), and a 2D canvas can't run shaders. Nothing warns about it.

So the roll looked half-working, with no error anywhere. The canvas renderer is
never a valid backend for this display. Picking it should be impossible, and
the "no GPU" case should be a visible state.

## Approach

### 1. Take the canvas renderer out of the options — `web/internal/pixi/app.tsx`

- Change `preference: "webgpu"` to `preference: ["webgpu", "webgl"]`. The
  canvas renderer is no longer on the list, so Pixi can't pick it. If neither
  backend is available, Pixi throws `No available renderer`.
- Before `app.init`, run the same check Pixi's auto-detect runs:
  `await isWebGPUSupported()` and `isWebGLSupported(false)`. Both are exported
  from `pixi.js`. The `false` matches our `failIfMajorPerformanceCaveat: false`.
  Pixi caches the WebGL answer for the page's lifetime, so both checks use the
  same answer. If both return false, don't create the `Application`. Call a new
  `onGpuUnavailable()` prop, and write
  `clientLog("piano-roll", "pixi backend: none (gpu unavailable)")` so the log
  records it next to the existing backend lines.
- Any other init failure, including a surprise `No available renderer` if the
  check and the init ever disagree, still throws and reaches the crash reports
  as it does today. We don't match on error messages, and nothing is swallowed.
- Update the comment on `failIfMajorPerformanceCaveat`. It currently says a
  slow software WebGL beats "leaving the lane blank". That's still true, but the
  last fallback is now the GPU-unavailable message, not the canvas renderer.

### 2. Show the state — `web/components/piano-roll.tsx`

- Add `const [gpuUnavailable, setGpuUnavailable] = useState(false)` next to
  `canvasNonce`, and pass `onGpuUnavailable={() => setGpuUnavailable(true)}` to
  `PianoRollCanvas`.
- When it's true, show a full-lane message in the existing empty-score slot
  (the same `Layer` → `Center` → `Text` shape, around line 617). It takes that
  slot's place, so two centred messages never overlap:
  > **Can't draw notes: the browser has no GPU available.**
  > Graphics acceleration is off in this browser, often after a GPU crash.
  > Restart the browser; `chrome://gpu` shows the details.

  The keyboard, the chord overlays and the HUD are DOM and keep working. Only
  the canvas lane is replaced.
- No Retry button. Pixi caches the WebGL answer, so retrying in the same page
  would give the same answer. A reload or a browser restart is the real fix,
  and the message says so.

### 3. Existing handling for a lost GPU in an open tab

If the GPU goes away while a tab is open, `watchContextLoss` still bumps
`canvasNonce` to rebuild the canvas. After this change, a rebuild with no GPU
shows the message instead of a roll with letters and no notes. That was the
most likely way into the Sep 21 state, since the tab is long-lived. This needs
no further change.

## Files

- `plugins/apps/plugins/sonata/plugins/piano-roll/web/internal/pixi/app.tsx`:
  backend list, check before init, new `onGpuUnavailable` prop, log line.
- `plugins/apps/plugins/sonata/plugins/piano-roll/web/components/piano-roll.tsx`:
  new state, message in the empty-score slot.
- `plugins/apps/plugins/sonata/plugins/piano-roll/web/components/piano-roll.tsx`
  doc comment on `PianoRoll` ("WebGPU-first, WebGL fallback"): add "no canvas
  renderer; GPU-unavailable message otherwise".

## Verification

1. `./equin build` (in the background), then `./equin check type-check`.
2. Normal case: open a song with
   `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --path /sonata/song/<id>`.
   Notes draw (headless Chromium uses WebGL), and the log shows `pixi backend: webgl`.
3. No-GPU case: launch Chromium with `--disable-gpu --disable-software-rasterizer`
   (WebGPU and WebGL both unavailable) and take a screenshot. The lane shows the
   message, with no letters and no blank lane, and `piano-roll.jsonl` gets
   `pixi backend: none (gpu unavailable)`. If the harness has no switch for
   Chromium flags, add a small `e2e/gpu-unavailable.ts` in the piano-roll
   plugin that launches with those flags using the harness's `withBrowser`.
