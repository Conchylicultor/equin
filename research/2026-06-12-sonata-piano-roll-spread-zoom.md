# Piano-roll spread (vertical time-axis zoom)

## Context

Sonata's falling-notes piano roll renders notes shorter and more compressed than
Synthesia for the same song — the look-ahead is cramped and notes read as thin
stubs. The cause is a single hard-coded constant, `PX_PER_SECOND = 180`
(`piano-roll/web/components/geometry.ts:58`), which maps authored-seconds →
vertical pixels. Synthesia simply uses a taller mapping.

We want this **configurable and live-adjustable**, driven by:

1. A **draggable horizontal jog wheel** in the transport toolbar (primary control).
2. **Pinch / Ctrl+scroll** over the roll to zoom.
3. **Plain scroll** over the roll to seek forward/backward smoothly.

The chosen spread is a **global** display setting (remembered across songs and
reloads).

### Why this is cheap and smooth

Notes are stored in **authored seconds** (`NoteVisual.y0Sec/y1Sec`); pixels come
from applying `PX_PER_SECOND` as one Pixi container `scale.y` plus one shader
uniform. Changing spread therefore animates *one scale value* — **no note
geometry rebuild, no vertex/index buffer churn**. That's ideal for a 60fps drag.

### Two design facts that shape everything

- **Config writes are slow.** `useSetConfig` round-trips HTTP → JSONC file →
  100ms-debounced file watcher → WS push. It cannot drive a per-frame drag. So
  the **live** spread must be ephemeral client state; the global config holds the
  **persisted/committed** value (seeded on load, written on settle).
- **Spread ≠ tempoScale.** `tempoScale` scales scroll *rate* but deliberately
  **not** note heights (the score's tempo map folds it in and it cancels). Spread
  scales **everything**, including note heights (the `uScale[1]` shader term) —
  which is exactly the Synthesia "taller notes" behavior. So spread is a new,
  independent multiplier, not a reuse of the tempo path.

## Approach

Mirror the existing `tempoScale` precedent: spread is ephemeral transport state
in the Sonata shell context, threaded into the renderer exactly where
`PX_PER_SECOND` is consumed, with a thin persistence bridge to a global config
field owned by the piano-roll plugin.

### 1. Global persisted config — `floatField`

`piano-roll/shared/config.ts`: add a `spread` field to `pianoRollConfig`.

```ts
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
// ...
spread: floatField({
  label: "Note spread",
  description: "Vertical zoom of the falling notes (Synthesia-style spacing).",
  default: 1.5,            // 1 = today's look; 1.5 ≈ Synthesia. Tunable.
  min: 0.4,
  max: 3,
  step: 0.05,
}),
```

- Read: `useConfig(pianoRollConfig).spread` (non-suspending, hydrated at boot).
- Write: `useSetConfig(pianoRollConfig)` → `setConfig("spread", v)`.
- Already registered via `ConfigV2.WebRegister` in `piano-roll/web/index.ts`; the
  Settings pane renders the float field automatically (gives a keyboard-precise
  fallback editor for free).

### 2. Live ephemeral state — Sonata shell context (mirror `tempoScale`)

`shell/web/context.tsx` — add `spread` next to `tempoScale`, byte-for-byte
mirroring the precedent:

- `SonataContextValue`: add `spread: number;` and `setSpread: (v: number) => void;`
  (near `tempoScale` line 109 / `setTempoScale` line 203).
- State: `const [spread, setSpreadState] = useState(1);` (near line 251).
- `spreadRef` mirror (like `tempoScaleRef` at 362) for imperative formulas.
- `setSpread` clamps to `[0.4, 3]` (a `MIN_SPREAD`/`MAX_SPREAD` pair like the
  tempo clamp constants).
- Add `spread` + `setSpread` to the `value` memo (lines 654/695) and its deps.

This context wraps the whole app, so both the toolbar wheel and the display
renderer share the same live value — exactly why `tempoScale` lives here.

### 3. Persistence bridge (load-seed + save-on-commit) — owned by piano-roll

Both the wheel and the config live in the piano-roll plugin, so importing the
private `shared/config.ts` is in-bounds. Seed once from persisted, write on
commit; no feedback loop because config is only written on an explicit
settle/idle (no drag active then, so the re-seed effect is a no-op).

Seed lives in `PianoRollInner` (always mounted with the display):

```ts
const persistedSpread = useConfig(pianoRollConfig).spread;
const { spread, setSpread } = useSonata();
useLayoutEffect(() => { setSpread(persistedSpread); }, [persistedSpread, setSpread]);
```

This also makes the **Settings-pane** float editor drive the roll live (edit →
persisted changes → effect seeds context → renderer updates).

### 4. Thread `spread` into the renderer

`spread` flows wherever `PX_PER_SECOND` is consumed. The renderer holds a
`spreadRef` and reacts to context `spread` changes.

**Pixi scene** — add a `setSpread(spread: number)` method to `PianoRollScene`
(`scene.ts`) that stores spread and recomputes all dependent pixel mappings
(notes never rebuild). It updates / re-applies:

| Site | File:line | Change |
|---|---|---|
| Content scale | `scene.ts:154` | `contentScaled.scale.set(width, PX_PER_SECOND * spread)` |
| Per-frame scroll | `scene.ts:125` | `scrollRoot.y = laneHeight + scrollSec * PX_PER_SECOND * spread` (re-apply on spread change) |
| Note SDF uniform | `note-mesh.ts:338` | `setUniforms` takes spread → `uScale[1] = PX_PER_SECOND * spread` |
| Bar-line height | `grid.ts:84` | `1 / (PX_PER_SECOND * spread)` (re-run `setBars`/reposition on spread change) |
| Label window pad | `labels.ts:195` | make `WINDOW_PAD_SEC` dynamic: `32 / (PX_PER_SECOND * spread)` |
| Note label Y | `labels.ts:276` | `-y0Sec * PX_PER_SECOND * spread - 3` |
| Visible window max | `labels.ts:288` | `laneHeight / (PX_PER_SECOND * spread)` |
| Label font height | `labels.ts:302` | `(y1Sec - y0Sec) * PX_PER_SECOND * spread` |
| Bar-number Y | `labels.ts:359` | `-startSec * PX_PER_SECOND * spread + 2` |

`grid` and `labels` each gain a stored `spread` + a `setSpread` setter that the
scene's `setSpread` fans out to; labels re-run their window/reposition pass.

**Cleaner internal abstraction:** rather than sprinkle `* spread` at 9 sites,
hold `pxPerContentSecond = PX_PER_SECOND * spread` as scene state and have grid /
labels / note-mesh read it through their setters. Localizes the change and keeps
one source of truth for the effective scale.

**React/DOM layer** (`piano-roll.tsx`):

- `buildProjection` gains a `spread` param → `pxPerSecond = PX_PER_SECOND *
  tempoScale * spread` (`geometry.ts:238`); add `spread` to the `useMemo` deps
  (line 143). This keeps DOM overlays + FX (which read `projection.beatToY` /
  `noteToRect`) pixel-glued automatically.
- DOM scroll mirror `applyCursor` (`piano-roll.tsx:303`): multiply the seconds
  term by `spreadRef.current`.
- Drag-scrub `unitsPerPixel` (`piano-roll.tsx:172`): `1 / (PX_PER_SECOND *
  tempoScale * spread)`.
- New effect: on context `spread` change → `scene.setSpread(spread)` then
  re-apply the current cursor (`applyCursor(getCursorBeat(), false)`) so content
  stays glued while it grows/shrinks in place.
- `PianoRollCanvas` (`app.tsx`): add a `spread` prop pushed via a
  `useLayoutEffect` → `scene.setSpread(spread)`, mirroring the `setShowLabels`
  effect at `app.tsx:144`.

### 5. The jog wheel control (piano-roll → `Sonata.Toolbar`)

New `piano-roll/web/components/spread-wheel.tsx`, contributed from
`piano-roll/web/index.ts`:

```ts
Sonata.Toolbar({ id: "spread", component: SpreadWheel })
```

(`Sonata.Toolbar` from `@plugins/apps/plugins/sonata/plugins/shell/web`; same
slot the transport-bar `PlaybackControls` uses.)

- Reuse `useInertialDrag` (`primitives/.../inertial-drag/web`) with `axis: "x"`:
  - `origin: () => spread`, `bounds: [0.4, 3]`,
    `unitsPerPixel` tuned (e.g. `0.004`/px),
  - `onScrub: (v) => setSpread(v)` (live, 60fps, ephemeral),
  - `onSettle: () => setConfig("spread", spread)` (persist the committed value).
- Visual: a ribbed horizontal wheel — a repeating tick pattern (CSS
  `repeating-linear-gradient`) translated by drag for a physical feel; show the
  current zoom `%` like the tempo stepper. `phase === "dragging"` →
  `cursor-grabbing`. Use spacing/text/icon primitives (no ad-hoc Tailwind
  gap/size — `no-adhoc-*` lint).

### 6. Wheel gestures on the roll surface (`piano-roll.tsx`)

Attach a non-passive `wheel` listener via a ref + `addEventListener("wheel", …,
{ passive: false })` in a `useEffect` (React `onWheel` is passive and can't
`preventDefault`). On the lane element:

- **`e.ctrlKey` (trackpad pinch **and** Ctrl+mouse-wheel both set it) → zoom**:
  `setSpread(clamp(spread * Math.exp(-e.deltaY * K)))` (multiplicative = smooth);
  `preventDefault()`. Persist via a debounced "wheel idle" timeout (~200ms) →
  `setConfig("spread", latest)` (wheel has no explicit end event).
- **plain scroll → seek**: accumulate `e.deltaY` into authored-seconds using the
  same `unitsPerPixel` as drag-scrub, `seekTo(secondsToBeat(clamp(cur + Δ, 0,
  endSeconds)))`; `preventDefault()`. Mirror the drag's pause-on-active /
  resume-on-idle (debounced) so seeking while playing feels like the drag scrub.

All handler inputs (`spread`, `setSpread`, `seekTo`, `tempo`, `endSeconds`,
`setConfig`) are already in scope in `PianoRollInner`.

## Critical files

- `piano-roll/shared/config.ts` — add `spread` float field.
- `shell/web/context.tsx` — add `spread`/`setSpread` (+ ref, clamp, value memo).
- `piano-roll/web/components/piano-roll.tsx` — seed effect, spread→scene effect,
  DOM `applyCursor` + drag `unitsPerPixel`, the `wheel` listener, pass `spread`
  to `buildProjection` + `PianoRollCanvas`.
- `piano-roll/web/components/geometry.ts` — `buildProjection` takes `spread`.
- `piano-roll/web/internal/pixi/scene.ts` — `setSpread` method + stored spread.
- `piano-roll/web/internal/pixi/note-mesh.ts` — `setUniforms` takes spread.
- `piano-roll/web/internal/pixi/grid.ts` — spread-aware bar-line height.
- `piano-roll/web/internal/pixi/labels.ts` — spread-aware label/window math.
- `piano-roll/web/internal/pixi/app.tsx` — `spread` prop + push effect.
- `piano-roll/web/components/spread-wheel.tsx` — **new** jog-wheel control.
- `piano-roll/web/index.ts` — `Sonata.Toolbar({ id: "spread", … })`.

## Reused primitives (no new infra)

- `useInertialDrag` — `primitives/.../inertial-drag/web` (momentum drag; already a
  piano-roll dep).
- `useConfig` / `useSetConfig` — `@plugins/config_v2/web`.
- `floatField` — `@plugins/fields/plugins/float/plugins/config/core`.
- `Sonata.Toolbar` slot — `shell/web/slots.ts`.
- `useSonata()` context — `shell/web/context.tsx`.

## Verification

1. `./equin build`; open
   `http://<worktree>.localhost:9000/sonata/song/<id>`.
2. **Default look**: notes are taller / more Synthesia-like out of the box
   (default spread 1.5).
3. **Jog wheel**: drag right → notes grow taller and the look-ahead window
   shrinks smoothly at 60fps; release → flick momentum settles. Reload → spread
   persisted. Open another song → same spread (global).
4. **Pinch / Ctrl+scroll** over the roll zooms; **plain scroll** seeks
   forward/backward smoothly without zooming or scrolling the page.
5. **Glue check**: while zoomed, the keyboard, bar lines, note labels, bar
   numbers, and any chord/FX overlays stay pixel-aligned with the falling notes,
   playing and paused.
6. **Settings pane**: the "Note spread" float field reflects and live-drives the
   same value.
7. e2e: `bun e2e/screenshot.mjs --url …/sonata/song/<id> --out /tmp/spread`
   before/after a wheel drag to confirm note height changes.
8. Unit: extend `geometry.test.ts` to assert `buildProjection({…, spread})`
   scales `beatToY`/`noteToRect.h` by `spread` (and that `spread = 1` matches the
   current baseline). Run `bun test piano-roll/web/components/geometry.test.ts`.

## Open / flagged

- **Default spread = 1.5** (improves the out-of-box look per the original
  complaint). Set to `1.0` to preserve today's exact rendering. One-line change.
- **Per-frame `setState` for spread** mirrors `tempoScale`; if a 60fps drag shows
  jank, push spread through a ref + imperative path like the cursor (optional
  follow-up, not needed initially).
