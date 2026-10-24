# Sonata: PixiJS piano roll rewrite + realistic keyboard + generic FX system

## Context

The piano roll (`plugins/apps/plugins/sonata/plugins/piano-roll/`, abbreviated `PR/` below) renders every note as 2–3 absolutely-positioned DOM nodes. Playback jank was fixed by memoizing the cursor-invariant note subtree (one `translateY` on `ScrollLayer`), but **resize is still O(notes) per frame**: a lane-size change rebuilds the projection and React re-applies inline styles to thousands of nodes on every resize step. This is inherent to retained-mode DOM — no amount of memoization fixes it.

We rewrite the note lane as a **PixiJS v8** canvas (WebGPU-first, WebGL fallback) where notes are static GPU geometry in authored space and resize/scroll are single-transform updates, add a **generic, extensible FX plugin system** (subtle defaults always on; fancy modes opt-in), and redesign the shared **piano keyboard** primitive with pure CSS for a realistic 3D look.

Decisions made with the user:
1. **Replace in place** — rewrite `piano-roll`'s renderer; no parallel `piano-roll-gl` display.
2. **Keyboard stays DOM** — CSS redesign of the shared primitive (`…/primitives/plugins/keyboard/`); all 4 consumers benefit (piano-keyboard gutter, chord-readout, key-readout, piano-roll).
3. **FX = generic plugin slot.** V1 ships `fx-core` (ambient: key-strike glow, rising sparks, active-note brighten) + `fx-ripples`, `fx-shatter`, `fx-comets` (fancy, opt-in). Adding an effect = one new sub-plugin, zero host edits.
4. `pixi.js` ^8 as a plugin-local dependency. Hand-rolled particle pool over `ParticleContainer` (NOT `@pixi/particle-emitter` — v7-era).

## Architecture

### Coordinate model (the core trick)

Notes are authored ONCE per score in **(key-fraction × authored-seconds)** space — using the keyboard primitive's *fractional* `keyLayout(low, high)` (0..1) and `authoredSec(beat) = tempo.beatToSeconds(beat) * tempoScale` (tempo-invariant note heights, see `PR/web/components/geometry.ts` header). One container transform maps to pixels:

- **Resize** → `content.scale.x = laneWidth` + shader uniforms. O(1).
- **Scroll** (playback/scrub) → `content.y = laneHeight + authoredSec(cursor) * PX_PER_SECOND`. O(1), identical to today's `ScrollLayer` formula.
- **tempoScale change** → never rebuilds geometry (authored seconds already fold it in).

### Note rendering: one SDF mesh

One custom `Mesh` (4 verts / 6 indices per note, **uint32** indices, single draw call). Rounded corners + the 1px border/rim are computed **in screen pixels in the fragment shader** (SDF rounded-box) from uniforms `uScale=(laneWidth, PX_PER_SECOND)` + `uDpr` — resize/DPR-independent, zero per-note CPU. Rejected: Graphics (O(notes) retessellation on resize — the bug again), Sprite/NineSlice per note (non-uniform scale distorts corners, or O(notes) pixel writes). Shaders authored as GLSL + WGSL pair (Pixi v8 dual-backend requirement).

Vertex attributes: `aPos` (content-space corner), `aLocal` (corner UV), `aSize` (wFrac, hSec), `aColor` (rgba8: resolved track color × black-key 0.72 darken; alpha = 0.4 + velocity/127 × 0.6).

### Scene graph & layering

Pixi stage (painter's order): `octaveLines` (screen-space Graphics, redrawn on resize only) → `fxBelow` → `scrollRoot[ contentScaled(barLines Graphics, noteMesh), pixelScroll(barNumbers, noteLabels) ]` → `fxAbove`.

DOM above the transparent canvas (lane `bg-background` shows through — background theme reactivity is free): `ScrollLayer`(now only `ProjectionProvider + OverlayHost`) → now-line div → HUD cluster → empty-placeholder → keyboard gutter. **`buildProjection` stays the single geometry source** — DOM overlays (chord overlay) and the keyboard consume it unchanged; canvas bars must land pixel-exact with them.

Labels (`showNoteNames`): pooled `BitmapText` (runtime `BitmapFont.install`, Inter 600, chars A–G + ♭♯ + digits), **windowed** to the visible time range via binary search over notes-sorted-by-start (~30–150 live at once); live in the pixel-space scroll container so text never distorts. `noteLabelFontPx` sizing rules move verbatim into the labels module. Bar numbers: BitmapText per bar, built once per score.

### Cursor flow (no shell changes in v1)

The display re-renders per frame via `Sonata.Display.Dispatch` props (status quo). `piano-roll.tsx` keeps stable JSX; a `useLayoutEffect` forwards `scrollSec` to the scene handle and mirrors it to a ref for the FX ticker. A ref-based `subscribeCursor` on the shell is a noted follow-up, not in scope.

### Theme colors

Track colors arrive as CSS strings — **defaults are `var(--categorical-N)`**; Pixi needs numbers. New local resolver `PR/web/internal/pixi/css-color.ts`:
- `parseComputedColor(s): number | null` — pure, handles `rgb()/rgba()/color(srgb …)` serializations; **throws loudly** on unparseable (fail-loud rule).
- `resolveCssColor(expr): number` — singleton probe `<div>` on `documentElement`, `style.color = expr`, parse `getComputedStyle(probe).color`.
- `watchThemeColors(cb)` — MutationObserver on `documentElement` class (pattern: `plugins/primitives/plugins/syntax-highlight/web/internal/use-dark-mode.ts`) → `scene.refreshColors()` rewrites the color buffer (O(notes), theme-flip only).

Kept local to piano-roll; promote to a primitive only when a second consumer appears.

### Generic FX system

New slot in `PR/web/slots.ts`, re-exported from the `PR/web/index.ts` barrel:

```ts
export type FxToggleConfig = ConfigDescriptor<{ enabled: BoolFieldDef }>;

export interface FxNoteEvent {
  note: Note;
  x: number; width: number; laneY: number;   // lane screen px (now-line)
  color: number;                              // 0xRRGGBB, resolved
  velocity: number;                           // 0..1
  isBlack: boolean;
  durationSeconds: number;                    // wall-clock at current tempo
}

export interface FxContext {
  layers: { belowNotes: Container; aboveNotes: Container };
  onNoteOn(cb: (e: FxNoteEvent) => void): () => void;
  onReset(cb: () => void): () => void;        // seek/jump/score-change → drop in-flight state
  getProjection(): Projection;
  getLaneSize(): { width: number; height: number };
  ticker: Ticker;
  renderer: Renderer;
  quality: { particleBudget: number };        // cap; degrade gracefully
}

export const PianoRollFx = defineSlot<{
  id: string; label: string; icon?: IconType;
  tier: "ambient" | "fancy";
  config: FxToggleConfig;                     // each fx's own { enabled } config
  component: ComponentType<{ fx: FxContext }>; // headless; imperative Pixi in effects
}>("piano-roll.fx");
```

- **Onset detection** (no audio-engine onset surface exists): pure `createOnsetTracker(notes)` — `advance(curBeat)` returns notes with start ∈ `(prevBeat, curBeat]`; backward jump or > maxGapBeats forward → internal reset (no onset burst on seek). Host calls it from `setScroll`; `seekEpoch` change → `reset()`.
- **Host** (`FxHost` + `FxGate`): renders contributions via `renderIsolated` (per-effect error boundaries, pattern from `overlay-host.tsx`); `FxGate` reads `useConfig(c.config).enabled` generically — disabled fx costs one config read. Collection-consumer clean: generic fields only.
- **Toggles**: each fx sub-plugin registers its own one-field config (web `ConfigV2.WebRegister` + server `ConfigV2.Register`, exactly like `pianoRollConfig`). Host-owned `FxToggle` popover button (HUD cluster, top-right) lists `PianoRollFx.useContributions()` grouped by tier with switches via `useSetConfig(c.config)` — every new fx auto-appears in the popover AND the generic settings pane with zero host edits. (reorder-directive mechanism considered and rejected: it models layout/edit-mode visibility, not feature toggles.)
- **Particle pool** (`PR/web/internal/fx/particles.ts`): fixed-capacity arrays over Pixi v8 `ParticleContainer`/`Particle`; `spawn(n, init)` drops spawns when budget-full; pure step math split out and unit-tested.

Acyclicity: fx sub-plugins import only the piano-roll web barrel (slot + types), config_v2, fields/bool, pixi.js; piano-roll never imports an fx plugin. One-way edge — DAG safe. Umbrella-with-runtimes nesting precedent: `sources/plugins/midi/plugins/folders`.

### Realistic keyboard (pure CSS, same API)

Only `…/primitives/plugins/keyboard/web/internal/keyboard.tsx` changes — `KeyboardProps`/`KeyHighlight`/fractional geometry untouched. Hardcoded inline colors stay (established convention: a piano is a physical object, fixed across themes). Layers:

1. **Keybed**: keep `relative overflow-hidden rounded-sm`; add a 2px red-felt strip at top (`linear-gradient(#5e1620, #7a1f2b)`), z between whites and blacks.
2. **White key rest**: ivory sheen gradient (`#fdfdfa → #f7f6f1 55% → #efeee8 88% → #dddcd4 94% → #cfcec6`) — last ~8% reads as the front edge; inset shadows for inter-key grooves + bottom lip.
3. **White key lit/pressed**: `translateY(1px)` + 70–90ms transitions; tint via `color-mix(in srgb, ${c} …)` concentrated at the key TOP (where notes land), `c = explicitColor || "var(--primary)"`; soft outer glow; front-edge stops compress (94→97%) — the depression read.
4. **Black key rest**: glossy cap gradient (`#4a4a4a → #222 18% → #161616 70% → #060606`), side bevels via inset shadows, drop shadow onto whites, plus an absolutely-positioned front-face div (bottom 14%, `#2e2e2e → #000`) — must NOT displace `renderKey` children (face renders behind the label, key keeps `flex items-end justify-center`).
5. **Black key lit/pressed**: `translateY(1px)`, front face 14%→8%, cap tinted `color-mix(… ${c} 60%, #161616)`, glow.
6. Normalize lit `""` → `var(--primary)` so one inline-style path handles accent + explicit colors (drops the `bg-primary` class path).
7. Verify all 4 consumers: 112px roll gutter (label colors `#52525b`/`#d4d4d4` must stay legible), `h-11` chord/key-readout chips (effects are %/1–2px, scale down), piano-roll. No images, no canvas, no new deps.

## File map

```
PR/package.json                                  MODIFY  + "pixi.js": "^8"
PR/web/index.ts                                  MODIFY  re-export PianoRollFx + Fx types
PR/web/slots.ts                                  NEW     slot + FxContext/FxNoteEvent/FxToggleConfig
PR/web/components/piano-roll.tsx                 REWRITE notes/grid DOM → canvas; DOM chrome kept
PR/web/components/geometry.ts                    MODIFY  + authoredSecondsOf, buildNoteVisuals (pure)
PR/web/components/geometry.test.ts               NEW
PR/web/components/fx-toggle.tsx                  NEW     host-owned FX popover (generic)
PR/web/components/{overlay-host,pitch-axis-host,projection-context}.tsx   KEEP
PR/web/internal/pixi/app.tsx                     NEW     PianoRollCanvas (React↔Pixi bridge)
PR/web/internal/pixi/scene.ts                    NEW     createPianoRollScene handle
PR/web/internal/pixi/note-mesh.ts                NEW     buffers + GLSL/WGSL SDF shader
PR/web/internal/pixi/labels.ts(+.test.ts)        NEW     BitmapFont, pooled windowed labels, noteLabelFontPx
PR/web/internal/pixi/grid.ts                     NEW     bar lines/numbers, octave lines
PR/web/internal/pixi/css-color.ts(+.test.ts)     NEW     resolveCssColor/watchThemeColors/parser
PR/web/internal/fx/onset-tracker.ts(+.test.ts)   NEW     pure
PR/web/internal/fx/fx-context.ts                 NEW
PR/web/internal/fx/fx-host.tsx                   NEW     FxHost + FxGate
PR/web/internal/fx/particles.ts(+.test.ts)       NEW     pooled emitter
PR/plugins/fx-core/                              NEW     ambient defaults (enabled by default)
PR/plugins/fx-ripples/                           NEW     fancy, default off
PR/plugins/fx-shatter/                           NEW     fancy, default off
PR/plugins/fx-comets/                            NEW     fancy, default off
  (each: package.json [pixi.js dep], shared/config.ts [{enabled: boolField}],
   server/index.ts [ConfigV2.Register], web/index.ts [PianoRollFx + ConfigV2.WebRegister],
   web/internal/<fx>.tsx)
…/primitives/plugins/keyboard/web/internal/keyboard.tsx   REWRITE (visuals only)
```

Deleted code (not files): `GridLines`, `OctaveLines`, the per-note DOM map and `noteLabelFontPx` inside `piano-roll.tsx`.

### Scene handle (contract between React and Pixi)

```ts
interface NoteVisual {                  // built by geometry.buildNoteVisuals (pure)
  noteId: string; trackId: string;
  xFrac: number; wFrac: number;         // key-fraction space
  y0Sec: number; y1Sec: number;         // authored seconds
  colorExpr: string;                    // unresolved CSS color (var() ok)
  alpha: number; isBlack: boolean;
  label: { step: string; accidental: string } | null;
}

interface PianoRollScene {
  setScore(input: { notes: NoteVisual[]; bars: { index: number; startSec: number }[]; cBoundaryFracs: number[] }): void;
  resize(width: number, height: number, dpr: number): void;
  setScroll(authoredSec: number): void;  // content.y + label window + onset tracker
  reset(): void;                         // seek → clear onset state, fire fx onReset
  setShowLabels(on: boolean): void;
  refreshColors(): void;                 // theme flip
  fxLayers: { belowNotes: Container; aboveNotes: Container };
  onNoteOn(cb: (e: FxNoteEvent) => void): () => void;
  destroy(): void;
}
```

`PianoRollCanvas` lifecycle (the #1 Pixi-v8-in-React footgun — StrictMode double-mount vs async `Application.init()`): disposed-flag + destroy-after-init-settles:

```ts
useEffect(() => {
  let disposed = false;
  const app = new Application();
  const ready = app.init({ preference: "webgpu", backgroundAlpha: 0, antialias: true,
    resolution: devicePixelRatio, autoDensity: true,
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false } })
    .then(() => { if (disposed) return; host.appendChild(app.canvas); /* createScene, onSceneReady */ });
  return () => { disposed = true; void ready.then(() => { /* destroy scene + app */ }); };
}, []);
```

Canvas gets `pointer-events: none`; drag-to-scrub (`useInertialDrag`) stays on the DOM lane wrapper unchanged.

## Implementation order

- **Phase 0 — keyboard CSS redesign** (independent, ships alone): keyboard.tsx layers above; verify 4 consumers via screenshots.
- **Phase 1 — pure groundwork**: `buildNoteVisuals` + `authoredSecondsOf` in geometry.ts; `css-color.ts`; `onset-tracker.ts`; bun:test each.
- **Phase 2 — Pixi renderer core**: pixi.js dep; note-mesh; grid; labels; scene; `PianoRollCanvas`; rewrite `piano-roll.tsx` (keep `useElementSize`, projection/tempo memos, drag, HUD, now-line, placeholder, gutter; `ScrollLayer` keeps only OverlayHost).
- **Phase 3 — FX framework**: slots.ts + barrel re-export; fx-context; fx-host; particles; fx-toggle popover.
- **Phase 4 — FX sub-plugins**: fx-core (glow: pooled additive radial-gradient sprite at `(x, laneY)`, ~250ms ease-out, velocity-scaled; sparks: 3–8 particles upward w/ jitter+fade ~600ms; brighten: additive overlay quad on the sounding bar's screen rect, repositioned per tick); fx-ripples (expanding ring sprites, additive, ShockwaveFilter-style without full-screen displacement cost); fx-shatter (~width/3 debris particles, gravity+rotation+fade ~900ms, budget-capped); fx-comets (per-track last-onset memory → quadratic-arc comet + fading trail; memory cleared onReset). `./equin build` codegens the registry.
- **Phase 5 — verify** (below).

## Risks

- **GLSL/WGSL drift** — keep the shader tiny (one SDF + rim); test both backends.
- **Headless Playwright lacks WebGPU** → e2e exercises the WebGL fallback (confirm which backend initialized in logs); verify WebGPU manually once in a real browser.
- **oklch serialization variance** in `getComputedStyle().color` (`rgb()` vs `color(srgb …)`) — parser handles both, throws on anything else (never silently-black).
- **DPR change** (monitor move): re-read `devicePixelRatio` in the resize path; update `renderer.resolution` + `uDpr`.
- **BitmapFont glyphs**: ♭ (U+266D) / ♯ (U+266F) must be in the installed char set; verify label fit visually.
- **>16k notes** would overflow uint16 indices — use uint32 from the start.
- **Z-stack**: transparent canvas below ScrollLayer/overlays/now-line/HUD; the `transform`-stacking-context note in piano-roll.tsx still applies.
- Lint: `Application.init()` promise handled via `void ready.then(…)` (no-floating-promises); rAF/ticker loops are sanctioned when cancelled on unmount (precedent: inertial-drag).

## Verification

1. `./equin check type-check`; `bun test plugins/apps/plugins/sonata/plugins/piano-roll` (onset-tracker, geometry, labels, css-color, particles).
2. `./equin build` → `http://<worktree>.localhost:9000/sonata`; `e2e/screenshot.mjs` flows:
   - Open a library song → roll renders (notes + realistic keyboard).
   - Click play → mid-playback shot: glow/sparks at now-line, keys pressed-lit.
   - Two viewports (1000×800, 1400×900) → canvas bars align pixel-exact with DOM chord overlay + keyboard columns.
   - Dark vs light → grid/bar-number/note colors re-resolve.
   - Toggle showNoteNames + one fancy fx via the popover (before/after shots).
3. **Perf** (the point of the rewrite): densest MIDI in library; temporary frame-time probe behind a debug flag logging via `clientLog("piano-roll-perf", …)` during (a) playback, (b) a programmatic resize loop; resize frames must stay < 8ms.
4. Chord/key-readout chips + keyboard gutter screenshots for the keyboard redesign.

## Outcome (verified 2026-06-12, post-implementation)

All phases landed. 52 bun tests green; all 38 `./equin check`s pass. Measured on the densest library song (Choral Fantasy, 17min, 22 tracks), frame-time percentiles from a rAF probe during a continuous viewport-resize loop:

| Probe | Headless (SwiftShader) | Headed, real GPU (WebGPU) |
|---|---|---|
| Paused resize loop | p50 42ms | **p50 8.3ms (120Hz vsync), p90 9.3ms** |
| Playing | p50 34ms | p50 8.4ms |
| Playing, ALL fx on | p50 34ms | p50 8.3ms, max 17.9ms |

Both render backends verified live: WebGPU in headed Chrome (exercises the WGSL shader), WebGL fallback in headless.

**Measurement caveat for future perf work**: headless Chromium rasterizes WebGL/WebGPU on CPU (SwiftShader) — its frame times reflect software fill-rate, not the app's real cost, and scale with note count even when the JS is O(1). A CDP sampling profile showing time in `(program)`/`resizeCanvas` rather than app code is the tell. Always confirm GPU-canvas perf headed.

Post-plan fix during verification: `OnsetTracker.reset` anchors inclusively (a note starting exactly at the anchor fires on the next advance) so the first note of a score gets its FX when playing from the top, matching the audio scheduler.

## Follow-ups (out of scope)

- Ref-based `subscribeCursor` on `SonataContextValue` so displays can consume the cursor without per-frame React renders.
- Optional true displacement ripples via `pixi-filters` (dep added to fx-ripples only, if ever).
- Promote `css-color.ts` to a shared primitive when a second consumer appears.
