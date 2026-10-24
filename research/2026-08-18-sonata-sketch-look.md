# Sonata: a hand-drawn "sketch" look for the piano roll

## Context

The Sonata piano roll draws its falling notes on a dark Synthesia-style stage. The
user wants a second look available: the whole roll rendered as if drawn by hand on
paper — cream ground, pencil rules, notes as pastel shapes with an ink outline, and
the 88 keys below drawn with the same pen.

A working prototype already answers the design questions, at
`~/.singularity/apps/prototypes/sketch-roll/index.html` (open it before starting).
It proves the note shader, the drawn keyboard, and one negative result: the cheap
alternative — warping the whole lane through an SVG `feTurbulence` filter — fails
for anything that moves, because the distortion is nailed to the screen while the
notes slide through it. It works beautifully for the static keyboard, which is why
that panel is worth looking at before dismissing the trick entirely.

**Decisions taken with the user:**

- The look covers the falling notes, the lane background, the grid, and the
  keyboard. It does **not** touch the Sonata toolbar, side sections, or app chrome.
- **One switch drives everything.** A paper lane under glossy ivory keys must be
  unreachable, not merely discouraged.
- The keyboard primitive is shared — the chord/key readout chips and the website's
  Sonata demo vignette render it too. They follow the look, exactly as they already
  follow the existing Flat/Realistic switch.

## The shape of the solution

A look is not a theme. The roll is deliberately theme-independent (`grid.ts:20-24`,
`piano-roll.tsx:74-78`) and stays that way — the look simply parameterises those
fixed constants instead of hardcoding one set.

A look is also not a component, which rules out `ui/variant-region`: its
contribution payload must be a `ComponentType` (`variant-region/web/slots.ts:3-13`),
and the roll is a Pixi canvas. What travels between plugins here is *data* — colours,
pen parameters, a key skin id. Per the root `CLAUDE.md` rule for closed sets ("prefer
plain data in `core/` rather than introducing a slot"), the look is a small record in
a `core/` module.

**A new leaf plugin owns it: `plugins/apps/plugins/sonata/plugins/look/`.**

Neither existing plugin can own this. `piano-roll` can't, because the keyboard
primitive would then have to import a display plugin — dragging the roll into the
readout chips and the website bundle. The keyboard can't, because its config's own
docstring scopes it to *keys*. A neutral leaf with zero outgoing plugin imports is
the honest owner, and it gives a star topology that cannot cycle. Precedent for a
`defineConfig` descriptor living in `core/`: `sonata/plugins/voicing/core/config.ts`.

## Part 1 — the look plugin

New files under `plugins/apps/plugins/sonata/plugins/look/`:

- **`core/config.ts`** — `export type SonataLook = "digital" | "sketch"` plus
  `sonataLookConfig = defineConfig({ fields: { look: enumField({ label: "Look",
  options: [{ value: "digital", label: "Digital" }, { value: "sketch", label:
  "Sketch" }], default: "digital" }) } })`. `enumField` types as `string`, so export
  an `asSonataLook(v: string): SonataLook` narrowing helper beside it.

  Not `"synthesia"` for the default id: both existing key skins (Flat *and*
  Realistic) live under it, and "Flat (Synthesia)" already uses that name one level
  down for a different axis.

- **`core/styles.ts`** — the closed palette table:

  ```ts
  export interface SonataLookStyle {
    laneBg: string;                       // the DOM lane background
    laneGrain: string | null;             // optional paper-grain data: URL
    pen: { sketch: 0 | 1; marginPx: number; wobble: number; grain: number;
           stroke: number; wash: number; hatch: number;
           paper: readonly [number, number, number] };
    grid: { colorExpr: string; barLineAlpha: number; octaveLineAlpha: number;
            pitchLineAlpha: number; octaveDash: readonly [number, number] | null };
    labels: { face: "light-on-dark" | "ink-on-paper"; barNumberExpr: string };
    keys: { drawn: boolean; ivory: string; ebony: string; ink: string; shade: number };
  }
  export const SONATA_LOOK_STYLES: Record<SonataLook, SonataLookStyle> = { … };
  ```

  `Record<SonataLook, …>` makes an incomplete table a tsc error, so a future third
  look forces every surface to answer for itself. Numbers for the sketch entry come
  from the prototype's defaults (wobble 0.9, grain 0.17, stroke 1.7, wash 0.74,
  hatch 0.18, paper `#f7f2e5`, ink `#2c2926`).

- **`core/index.ts`** — barrel (mirror `voicing/core/index.ts`).
- **`web/index.ts`** — `ConfigV2.WebRegister({ descriptor: sonataLookConfig })` plus
  `Sonata.ViewOption({ id: "look", displays: ["piano-roll"], config: sonataLookConfig })`.
  That one contribution is the entire UI: `view-options-toggle.tsx` renders enum
  fields generically through `FieldRenderer`, so the switch appears in the View
  popover with no new components. Settings → Config picks it up for free too.
- **`server/index.ts`** — `ConfigV2.Register({ descriptor: sonataLookConfig })`.
  Both registrations are mandatory (`config-v2:registrations-paired`).
- **`package.json`**, **`CLAUDE.md`** — mirror `voicing/`.

## Part 2 — the piano roll

### 2a. Lane, grid and labels (no shader work — do this first)

Today's constants become reads from `SONATA_LOOK_STYLES[look]`:

| today | file | becomes |
|---|---|---|
| `ROLL_BG = "#262626"` | `web/components/piano-roll.tsx:79`, applied `:519` | `style.laneBg` + `style.laneGrain` as a `background-image` on the same div (under the transparent canvas — no overlay element, no blend mode) |
| `BORDER_COLOR_EXPR`, three alphas | `web/internal/pixi/grid.ts:47-52` | handle state `ink: GridInk`, applied by a new `applyInk()` |
| baked white-on-black label face | `web/internal/pixi/labels.ts:125-147` | a third `BitmapFont` face (below) |
| `MUTED_FOREGROUND_EXPR` bar numbers | `web/internal/pixi/labels.ts:113` | `ink.barNumberExpr` |

**Labels can't be fixed with a tint.** The note-name face bakes a black stroke halo
into the texture, and `tint` multiplies the whole thing — a graphite tint gives a
dark letter still wearing a black halo, i.e. a smudge on cream. Install a third face
in `ensureFonts` (`labels.ts:122-159`), same install-once guard, with a graphite fill
and a **paper-coloured** halo. `labels.setLook()` then walks both the `active` and
`free` pools setting `fontFamily`, marks `dirty`, and re-runs `refreshWindow()` so
`place()` re-measures (glyph advances differ between faces).

**Dashed octave rules need real geometry.** Pixi `Graphics` has no dash, so when
`ink.octaveDash` is set, `redrawPitchLines` (`grid.ts:99-109`) emits a run of rects
instead of one. At `[7,6]` over an 800px lane that's ~60 rects per octave line,
rebuilt only on resize/look change — nothing next to the note mesh.

**A theme flip must not clobber the look.** `refreshColors()` (`scene.ts:229-237`)
runs on every theme change *and* every `setScore`. It stays exactly as it is and
keeps working only because grid and labels now store their ink rather than closing
over module constants. Verify by switching to sketch, then toggling light/dark.

### 2b. Propagating the switch

```
piano-roll.tsx      useConfig(sonataLookConfig) beside the existing one (:164)
                    → lane style (:519) + a new look prop on <PianoRollCanvas> (:536)
app.tsx             one new layout effect after the resize effect (:202-207):
                      useLayoutEffect(() => { scene?.setLook(look) }, [scene, look])
scene.ts            setLook(look) → mesh.setLook(pen) | grid.setLook(ink, resolveColor)
                                    | labels.setLook(ink, resolveColor)
```

**Never rebuild the scene to change look.** `createPianoRollScene` runs once per Pixi
mount, and the FX plugins hold direct references to `scene.fxLayers.belowNotes/
aboveNotes` (`slots.ts:69`, `fx-context.ts:44`) through a context memoized on the
pixi pair — a rebuilt scene leaves every mounted effect parenting into destroyed
containers. Nothing in a look change touches note buffers, note colours, the onset
tracker, the label pool identities, or the colour cache.

### 2c. The note shader

**One shader pair with a `uSketch` uniform flag** — not two `Shader` objects, not a
rebuild. Toggling is then a single uniform write. Two shaders would mean four sources
to keep in agreement (the file's own header calls the existing GLSL/WGSL duplication
an accepted drift risk), a pipeline compile hitch on first toggle, and a `destroy()`
hazard where two shaders share one `UniformGroup`.

Extend the group at `note-mesh.ts:266-269`. **Field order is load-bearing**: Pixi
derives the WebGPU UBO layout from declaration order, and the hand-authored WGSL
`struct` must match it field for field. Getting this wrong is silent and
WebGPU-only.

```ts
uScale (vec2) | uDpr (f32) | uSketch (f32) | uMargin (f32)
              | uPen (vec4: wobble, grain, stroke, wash)
              | uPaper (vec4: r, g, b, hatch)
```

Three things the port must get right that the prototype glosses over:

1. **The ink is clipped by the quad.** The pen writes up to ~2.5px outside the note
   box; in the prototype every stroke is sliced flat at the bounding box. Expand the
   quad in the *vertex* shader by `uMargin` (0 in the digital look, so the math is an
   exact no-op) — no buffer change. Guard the division:
   `uMargin / max(aSize * uScale, vec2(1e-6))`, or a zero-height grace note NaNs out
   the quad in *both* looks.
2. **Precision.** The fragment shader is `precision mediump float`
   (`note-mesh.ts:83`); `hash21`'s `fract(p * vec2(123.34, 456.21))` is meaningless
   at fp16. Raise it to `highp`. On desktop this is numerically identical; on mobile
   it makes the existing SDF strictly more accurate.
3. **The per-note seed — hash in the VERTEX stage, and quantize.** No new attribute
   is needed: `aPosition - aLocal * aSize` recovers the note's authored top-left at
   all four corners (verified against `setNotes` corner order — `aLocal` is exactly
   0/1 and `aSize` is written identically to all four vertices).

   But hashing that in the *fragment* shader turns every note into TV static. The
   recovery is exact in real arithmetic, not in f32: the bottom corners compute
   `yBottom - hSec`, so the recovered origin differs between top and bottom by ~1e-5
   at a few minutes into a score, and a discontinuous hash amplifies that to the full
   0..1 range per pixel. Hash in the vertex shader and interpolate the scalar result:

   ```glsl
   vec2 origin = aPosition - aLocal * aSize;
   vSeed = hash21(floor(origin * vec2(1024.0, 128.0) + 0.5));
   ```

   The grid is orders of magnitude coarser than the error, yet still unique per (key
   column, onset). **Do not use `flat`** — GLSL ES picks the last provoking vertex
   and WGSL the first, so a flat varying seams down the quad's diagonal on one
   backend.

   If this is ever refuted in practice, the fallback is *not* a new buffer: widen
   `aLocal` to `float32x3` and write a CPU-side golden-ratio seed in `.z`.

The fragment's sketch branch ports from the prototype (`index.html:447-535`): seeded
fbm displacing the rounded-box SDF, pen pressure varying the stroke width, a lighter
ghost stroke outside it, tone variation over the body, optional hatching. The digital
path keeps its existing early `return` **before any new code executes** — the old look
is not reimplemented compatibly, it is literally the same three lines.

Author GLSL first, verify, then port to WGSL and verify again. `preference: "webgpu"`
(`app.tsx:138`) means both paths ship; the active backend is already logged at
`app.tsx:164`, and flipping the preference temporarily is how you exercise the other.

## Part 3 — the drawn keyboard

`keyboard.tsx` reads `sonataLookConfig` alongside the existing `keyboardStyleConfig`.
When `look === "sketch"` it renders the drawn skin and **does not consult `keyStyle`
at all**; otherwise Flat/Realistic behave exactly as today. The mismatched
combination isn't validated away — it's unreachable, because one config makes the
other irrelevant. `keyboardStyleConfig` stays where it is and keeps its store path,
so no persisted user preference resets.

The keys are percentage-positioned divs styled with CSS gradients — fine for bevels,
useless for irregular outlines. The drawn skin adds a decorative SVG layer instead:

- **`web/internal/sketch-paths.ts`** (+ colocated test) — port `keyRng`,
  `drawnKeyPath`, `drawnLine` from the prototype. Pure, framework-free. Seeding is
  purely a function of `pitch`, so a key's shape is stable across re-renders with no
  ref bookkeeping.
- **`web/internal/sketch-skin.tsx`** — one shared `<svg>` per key group (whites,
  blacks), one `<defs>` of shading gradients for all of them, sized in *measured
  pixels* via `useElementSize` (`@plugins/primitives/plugins/element-size/web`). A
  0..1 viewBox stretched with `preserveAspectRatio="none"` would distort the wobble
  and the stroke widths.
- Mount it as a `pointer-events-none aria-hidden` sibling *before* each
  `{whites/blacks.map(renderLane)}` block, and have `whiteKeyStyle`/`blackKeyStyle`
  return transparent chrome under sketch. The existing `data-pitch` divs stay exactly
  as they are — they're the hit-test targets `usePlayableKeyboard` reads, and the
  label host. Same layering discipline `BLACK_FACE` already uses.
- Depth comes from **shade, not bevels**: a graphite gradient down the front of each
  ivory, a blurred cast shadow where each ebony meets the white beside it, a sheen
  down the black, and a doubled offset outline standing in for pen pressure (SVG has
  no per-length stroke width, so the overdraw *is* the pressure).
- `useMemo` the path strings on `[lanes, measuredW, measuredH]`. Lighting a key must
  rewrite `fill` only — never recompute a `d`. Reuse the existing `mix()` helper for
  the lit tint rather than porting the prototype's `mixHex`.
- Scale the wobble amplitude off the measured key height (roughly
  `clamp(h * 0.02, 0.4, 1.8)`). The prototype could hardcode it for one canvas size;
  the primitive renders at both the full 88-key roll and the `h-11` readout chip,
  where a fixed amplitude reads as noise.

## Staging

1. **Inert refactor.** Create the look plugin with only the `digital` entry, holding
   today's exact literals, and migrate `grid.ts` / `labels.ts` / `piano-roll.tsx` to
   read from it. Add the `setLook` plumbing with sketch == digital. *Screenshot-identical
   to main* — this is the firewall for everything after it.
2. **The look becomes visible without a shader.** Register the config, add the
   ViewOption, thread the prop and the effect, fill in the sketch palette's non-shader
   half (cream lane, grain, graphite grid, ink labels). The switch now works and shows
   a paper roll with today's flat notes. Demoable on day one.
3. **The note shader.** Uniforms, vertex seed + margin, fragment branch. GLSL, then WGSL.
4. **The drawn keyboard** (Part 3).
5. **Dashed octave rules and hand-drawn bar lines.** Pure `grid.ts` geometry; bar-line
   jitter must be expressed in `1/(PX_PER_SECOND*spread)` units like the existing
   height math, so it stays ~1px at any zoom.

## Verification

- `./equin build`, then open `http://<worktree>.localhost:9000/sonata`, open a
  song, and switch Look in the View popover (the `MdTune` chip).
- Watch a long held chord fall while scrolling. The ink must ride *with* each note —
  any crawl, shimmer or per-pixel static means the seed was hashed in the wrong stage.
- Toggle light/dark while sketch is active: the roll must stay paper.
- Screenshot both looks at 88 keys and confirm short notes still read as drawn rather
  than as mud — `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts`
  with `--click "Sketch"` does the before/after in one shot.
- Play a glissando in sketch mode: the drawn skin must not break `data-pitch`
  hit-testing.
- `./equin test plugins/apps/plugins/sonata` — the existing `labels.test.ts`,
  `geometry.test.ts` and `css-color.test.ts` cover pure functions this plan doesn't
  touch and should pass unmodified. Add a test for `sketch-paths.ts`.
- `./equin check` — `config-v2:registrations-paired` must pass for both
  descriptors independently, and `plugins-doc-in-sync` after the build regenerates
  the new plugin's `CLAUDE.md`.

## Deliberately out of scope

- **The FX plugins.** `fx-core`'s glow is additive (`blendMode: "add"`), which has
  almost no headroom over cream — it will look wrong on paper. Do *not* gate FX on
  the look in the host: `FxHost` reads only generic slot fields and must never name
  an effect, and auto-writing another plugin's config silently clobbers a user
  preference. The right seam is a generic `getLook()` accessor on `FxContext`
  alongside `getProjection`/`getLaneSize`, leaving each effect's author to adapt.
  Ship with FX untouched and note it.
- **A handwriting font for note names.** `BitmapFont.install` rasterizes immediately,
  so a webfont needs a `document.fonts.ready` gate before `ensureFonts` — a real
  lifecycle change for a taste win.
- **Graying out the now-inert Key style row** under sketch. Cross-config coupling
  isn't something the `Sonata.ViewOption` slot shape supports; adding an optional
  `disabledWhen` predicate is a separate, small change.
- **Note letter labels inside the bars**, as the reference image shows. At 88 keys
  those are a few pixels wide; likely only viable zoomed in.
