# Sonata: Vertical Piano Roll + Piano Keyboard Below

## Context

Sonata's only Display today is a **horizontal** piano roll (`piano-roll` plugin):
time runs left→right (scrolls horizontally), pitch runs bottom→top, and the
playback cursor is pinned at 35% from the left. There is no piano keyboard.

The user wants the classic **Synthesia** layout instead: notes **fall vertically**
(time = vertical axis, pitch = horizontal axis) onto a **piano keyboard rendered
below** the roll, with the keyboard aligned to the pitch axis so each falling
note "lands" on its key. Decisions confirmed with the user:

- **Replace** the horizontal roll — the single `piano-roll` Display becomes vertical (no orientation toggle).
- The keyboard is its **own plugin**, contributed into a new pitch-axis slot (modular / swappable).
- The keyboard shows a **full 88-key piano** (A0–C8). Pitch is therefore a *fixed* axis spanning the full width — only time scrolls.

This is also a small structural fix: the `Projection` contract (in `score/core`)
currently bakes screen directions into its accessor names (`beatToX`, `pitchToY`).
With the roll now vertical we update those to match reality and add the shared
key-layout geometry both the notes and the keyboard consume from one source.

## Target layout

```
┌───────────────────────────────────┐
│   note lane  (scrolls in TIME ↓)  │  ← falling notes + overlays (chord labels)
│        ▮     ▮          ▮          │     future is UP; notes fall toward now-line
│        ▮   ▮▮                      │
│ ───────────── now-line ────────── │  ← bottom of lane = top of keyboard
│ [ ▮▮|▮|▮▮|▮|▮▮ ▮▮|▮|▮▮|▮|▮▮ … ]    │  ← pitch-axis gutter: 88-key keyboard
└───────────────────────────────────┘
```

- **Pitch → X**: full 88 keys (52 white + 36 black) laid across the container width. A note's column is centered on its key (white-note columns ≈ white-key width, black-note columns narrower), so notes align 1:1 with the keys below.
- **Time → Y**: `beatToY(beat) = laneHeight − (beat − cursorBeat) · PX_PER_BEAT`. The cursor beat maps to the bottom of the lane (the keyboard); future beats sit higher and descend as the transport advances. Pure function of `cursorBeat` + lane height (no per-frame state), matching today's "layout is a pure function of props" design.

## Files to change

### 1. `score/core/types.ts` (+ `core/index.ts` export) — generalize the contract
- Add and export a `KeyLane` interface — one piano key on the pitch axis, in screen px:
  ```ts
  export interface KeyLane {
    pitch: number;     // MIDI note
    isBlack: boolean;
    center: number;    // px center along the pitch axis
    width: number;     // px column width (white vs black)
  }
  ```
- Update `Projection` to match the vertical roll (keep the semantic capability names `"time-axis"` / `"pitch-plane"`):
  - `beatToX` → **`beatToY`** (beat → screen Y in the lane), present iff `time-axis`.
  - `pitchToY` → **`pitchToX`** (pitch → screen X center), present iff `pitch-plane`.
  - `noteToRect` unchanged in shape (`{x,y,w,h}`), still present iff both.
  - Add `keys?: readonly KeyLane[]` — the full 88-key layout, present iff `pitch-plane`.
  - Update the doc comment block to describe the vertical orientation.

> Scope note: we do **not** introduce an orientation flag / dual-orientation machinery — the horizontal roll is being removed, so a single vertical contract is the honest, minimal design. Generalizing to N orientations later (if a staff/horizontal display ever returns) is a localized follow-up.

### 2. `piano-roll/web/components/geometry.ts` — full-keyboard pitch geometry
- New constants: `KEYBOARD_LOW = 21` (A0), `KEYBOARD_HIGH = 108` (C8); white-pitch-class set `{0,2,4,5,7,9,11}`; `BLACK_WIDTH_RATIO ≈ 0.62`; `PX_PER_BEAT` (now vertical px/beat).
- `keyLayout(width: number): KeyLane[]` — pure. 52 white keys tile edge-to-edge (`whiteW = width / 52`, `center = whiteIndex·whiteW + whiteW/2`); black keys centered on the white/white boundary above their lower white neighbor (`center = (whiteIndex(pitch−1)+1)·whiteW`, `width = whiteW·BLACK_WIDTH_RATIO`). Build a `pitch → KeyLane` map for O(1) lookup.
- `buildProjection({ width, height, cursorBeat })`:
  - `keys = keyLayout(width)`, `pitchToX(pitch) = keyByPitch[pitch].center`.
  - `beatToY(beat) = height − (beat − cursorBeat)·PX_PER_BEAT`.
  - `noteToRect(note)`: `const k = keyByPitch[note.pitch]; return { x: k.center − k.width/2, w: k.width, y: beatToY(note.start + note.duration), h: note.duration·PX_PER_BEAT }` (top = note end since Y grows downward as beat decreases).
  - `capabilities: new Set(["time-axis","pitch-plane"])`, `viewport: { width, height, scrollBeat: cursorBeat }`.
- **Remove** `pitchRange` / `planeHeight` and `PX_PER_SEMITONE` (pitch is now the fixed full keyboard; lane height comes from the container, not the score).

### 3. `piano-roll/web/components/piano-roll.tsx` — vertical layout
- Root: `flex flex-col`. **Note lane** = `flex-1 relative overflow-hidden` (its measured height drives `beatToY`); **gutter** = fixed-height (`KEYBOARD_HEIGHT`, e.g. `h-24`) `relative` band at the bottom.
- Measure the **lane** height with the existing `useElementSize` hook; build the projection from `{ laneWidth, laneHeight, cursorBeat }`.
- Notes: map `noteToRect`, cull rects fully outside `[0, laneHeight]`; keep the velocity-opacity + rounded styling.
- `GridLines`: bar lines become **horizontal** (`top: beatToY(bar.startBeat)`, full width) via the reused `bars(score)` helper; bar-number label at the left. Now-line = a horizontal line at the lane bottom (`top: laneHeight`) spanning full width.
- Wrap lane overlays in `<ProjectionProvider>` + `<OverlayHost>` (unchanged).
- In the **gutter**, render `<PitchAxisHost projection={projection} />` (new, below).

### 4. `piano-roll/web/components/pitch-axis-host.tsx` — NEW (mirrors `overlay-host.tsx`)
- Reads `Sonata.PitchAxis.useContributions()`, filters on the **generic** field only (`requires ⊆ projection.capabilities`) — never names the keyboard (collection-consumer clean) — and renders each via `renderIsolated("sonata.pitch-axis", c, { projection })`. No annotation dependency (unlike overlays).

### 5. `shell/web/slots.ts` — new slot
- Add, mirroring `Sonata.Overlay`:
  ```ts
  PitchAxis: defineSlot<{
    id: string;
    requires: Capability[];
    component: ComponentType<{ projection: Projection }>;
  }>("sonata.pitch-axis", { docLabel: (p) => p.id }),
  ```

### 6. `rich/plugins/chord-overlay/web/components/chord-overlay.tsx` — follow the rotated axis
- Still `requires: ["time-axis"]`. Switch from `beatToX`→`beatToY`: place each chord label at `top: beatToY(a.start)` along a thin **left** band (`absolute inset-y-0 left-0`), `-translate-y-1/2`; cull on `y < −20 || y > height + 20` using `projection.viewport.height`.

### 7. NEW plugin: `plugins/apps/plugins/sonata/plugins/piano-keyboard/`
- `package.json` (copy a sibling sub-plugin's, e.g. `chord-overlay`, byte-for-byte; rename).
- `web/index.ts`: default-export `PluginDefinition` contributing
  ```ts
  Sonata.PitchAxis({ id: "piano-keyboard", requires: ["pitch-plane"], component: PianoKeyboard })
  ```
- `web/components/piano-keyboard.tsx`: `({ projection }) => …`. Guard `if (!projection.keys) return null`. Draw, from `projection.keys`:
  1. white keys (`!isBlack`): full-height rects (`center − width/2`, `width`), light fill + border, note-letter label (C D E F G A B), octave number on each C.
  2. black keys (`isBlack`) on top: ~60% height, dark fill, higher `z`.
- CLAUDE.md autogen stub (regenerated by build).

## Cross-plugin boundaries (sanity)
- `piano-keyboard` imports `Sonata` from `…/shell/web` and `Projection`/`KeyLane` types from `…/score/core` — both runtime barrels. ✓
- Slot `Sonata.PitchAxis`: defined in **shell**, consumed in **piano-roll**, contributed by **piano-keyboard** — a clean DAG, consumer filters on generic fields only. ✓
- No new cross-plugin re-exports; `KeyLane` lives in `score/core` so both roll and keyboard import it from the source barrel (not via each other). ✓

## Verification
1. `./equin build` (regenerates docs/migrations, rebuilds, restarts; runs checks incl. `--plugin-boundaries`).
2. Open `http://<worktree>.localhost:9000/sonata`.
3. Drive with Playwright (`e2e/screenshot.mjs` or a small script): the MIDI source is a dropzone, so upload a small `.mid` (use an existing fixture if present under the repo, else a tiny generated one) via the hidden `input[type=file]`, then **Play**, and capture before/after screenshots. Confirm:
   - notes fall **downward** toward the keyboard and land on the correct keys (column X aligns with the key below);
   - the **88-key keyboard** renders across the full width below the lane (white + black keys, letter/octave labels);
   - bar lines are horizontal and scroll up with time; the chord overlay labels track the correct beats down the side.
4. `./equin check` clean (boundaries, eslint, migrations, plugins-doc-in-sync).

## Out of scope (note for later)
- Key-aware enharmonic spelling on keys (the screenshot's "Eb Major" labels) — would read `score.meta.key`; easy follow-up.
- Highlighting keys that are currently sounding at the cursor — a natural next contribution to `Sonata.PitchAxis` once this lands.
