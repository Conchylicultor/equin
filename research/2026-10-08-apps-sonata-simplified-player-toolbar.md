# Sonata — simplified player toolbar

## Context

The Sonata song page's header has grown to ~25 controls in one row (screenshot in
the originating task): ← Library, the song title, a "DISPLAY" label + four view
tabs, a volume slider, the zoom wheel, loop, the metronome button, a "Ped."
chip, rewind / play / fast-forward, the speed wheel, a "60 bpm" readout and the
transpose stepper. It reads as clutter and overflows into the "⋯" menu at
ordinary widths.

The design was iterated in prototype **proto-1791407620-ij8o** (layout
`two-row`). Decisions taken with the user:

- **Two rows.** The header holds identity and tools; a strip below it holds
  playback: play/pause, the time, the chord timeline, loop.
- **Prev / next (seek bar) buttons go.** ←/→ keyboard seek stays — it is
  `controls/web/seek-hold-controller.tsx`, independent of the buttons.
- **The "Ped." sustain chip goes.**
- **Speed and zoom stay jog wheels** (the app's existing `JogWheel`), but at
  rest they collapse to icon + value; the ribbed face opens out on hover, focus
  or drag. Volume collapses the same way: speaker icon at rest, slider on hover.
- **Metronome stays a popover** (it already is). **Transpose becomes a popover**
  (today it is an inline stepper).
- **The view switcher is a plain switcher** (Chord grid / Notation / Piano roll /
  Songsheet): icons, the active one labelled, no "Display" label and no menu.
  It sits at the **far right of the header, after all the tools** (user's call —
  not centred, so no change to the shared pane-header row).
- Per-view options (the piano roll's Key / View / FX HUD chips) stay exactly as
  they are.

Target header, left → right:

```
← Library   Song title ……………………   ⏲100%  ⏱  ⇅  🔈 │ 🔍0.75× │  ▦ ♪ [≡ Piano roll] ▤
```

Target strip:

```
▶  0:02.6  ━━●━━━━━━━━━━━━ chord timeline ━━━━━━━━━━━━━  5:02.4  ⟲
```

## How the toolbar is built today (what we change)

- The header is the pane header of `sonataPlayerPane`
  (`library/web/panes.tsx`), rendered by `PaneChrome` into an `AdaptiveBar`.
  Every control is a `sonataPlayerPane.Actions({ id, component })`
  contribution. **Order, sides and hiding live in the reorder config**
  `config/apps/sonata/library/sonata-player.actions.jsonc`, not in code.
- The strip is the `SonataPlayer.Transport` render slot (`player/web/slots.ts`),
  rendered by `PlayerTransport` (`player/web/components/parts.tsx`). Its only
  contributor today is `ProgressBar`
  (`progress/plugins/scrubber/web/components/progress-bar.tsx`), which draws its
  own full-width row (border, padding, time text).
- Below, `SONATA` = `plugins/apps/plugins/sonata/plugins`.

## Changes

### 1. Jog wheel: collapsible face (`SONATA/primitives/plugins/jog-wheel`)

Add a `collapsible?: boolean` prop to `JogWheel`. When set, the ribbed face
(`h-6 w-16`) is width-0 / transparent at rest and animates open while the
control is hovered, has focus within, or `drag.phase !== "idle"` (so it never
snaps shut mid-flick or mid-coast). Icon and readout are always visible, and the
readout stays clickable/focusable so keyboard users can reach the face.

The pill frame (`ToolbarControl`) stays as it is. The open/closed rule lives in
the primitive, so both wheels behave the same.

### 2. Speed: its own header item (`SONATA/transport-bar`)

Split `PlaybackControls` (`transport-bar/web/components/playback-controls.tsx`):

- Remove both `SeekButton`s and the `SeekButton` component.
- `TempoWheel` becomes its own `sonataPlayerPane.Actions` contribution
  (id `speed`), rendered `collapsible`.
- **The live BPM readout moves into the metronome popover** (§4). Hoist
  `bpmAtBeat` from `playback-controls.tsx` to `score/core` beside
  `beatToSeconds`, its source of truth. The metronome plugin can then use it
  without importing `transport-bar`.
- The play/pause button moves to the strip (§6). It becomes a
  `SonataPlayer.Transport` contribution, id `play`, and keeps today's count-in
  semantics (`togglePlay`; a pending count-in reads as playing).

The `playback` Actions contribution disappears.

### 3. Zoom (`SONATA/piano-roll/web/components/spread-wheel.tsx`)

`SpreadWheel` renders `collapsible`. Nothing else changes; persistence to
`pianoRollConfig.spread` is untouched.

### 4. Metronome popover (`SONATA/audio/plugins/metronome`)

Keep `MetronomeButton` and its `ControlPanelPopover` as they are: on/off,
subdivision, count-in, click volume, accent. Add one band at the top: the live
tempo in large type with "follows speed · N%". It is read with
`useCursorSelector` + `bpmAtBeat`, the same way `PlaybackControls` reads it
today, so the bar no longer needs a "60 bpm" label.

The button already reads filled when the metronome is on; keep that.

### 5. Transpose popover (`SONATA/transpose`)

Replace the inline `TransposeControl` stepper with:

- **Trigger:** an `IconButton` with the `swap-vert` icon. It shows a small `+N`
  / `−N` badge when the offset is not 0, is disabled with no score, and is
  hidden for a file document (as today).
- **Panel:** a `ControlPanelPopover` (same primitive as the metronome), aligned
  to the end. It holds:
  - **Stepper band:** large `−` / `+` around the signed `N st` readout, with
    "B major → C major" underneath. The key is the song's opening key from
    `collectKeyEntries(score)` in `score/core/key-context.ts`, the same source
    `KeyChip` uses. The line is omitted when the score has no key.
  - **"Play in" band:** a grid of the 12 tonics from −5 to +6 around the
    original. The original is marked and the current one selected; a click sets
    the offset.
  - **Reset** returns the offset to 0.
- **Behaviour:** pending / failed / settled handling stays as today, and so does
  writing (`useWriteSongSetting(transposeSetting)` + `saveTranspose`).

### 6. Volume (`SONATA/audio/plugins/engine/web/components/volume-control.tsx`)

The mute `IconButton` stays and the `Slider` sits after it. The slider's wrapper
is width-0 / transparent at rest and opens on hover or focus-within. While the
slider is being dragged it stays open, so a drag that leaves the control does
not collapse it.

This uses the same open/close rule as the wheel. If the two copies would end up
identical, extract the rule as a small `useHoverExpand` / CSS group helper in
`SONATA/primitives/plugins/toolbar-control` and let both consume it. Do not
re-spell it.

### 7. View switcher (`SONATA/library/web/components/player-toolbar-items.tsx`, `display-picker.tsx`)

- `DisplayPicker` drops the `<SectionLabel>Display</SectionLabel>`.
- `Picker` renders as a segmented icon switcher: every display shows its icon
  (from the `SonataPlayer.Display` contribution's `icon`) with its `label` as
  tooltip and aria-label. Only the active one also shows its label.
- No menu, no new behaviour. Selection is `usePlayerView().displayId` as today.

### 8. Strip: play · scrubber · loop (`SONATA/player`, `SONATA/progress`)

- `PlayerTransport` (`player/web/components/parts.tsx`) becomes the strip's
  row. It owns the `border-b` + padding, renders each `Transport` contribution
  in a `Stack direction="row" align="center"`, and lets the progress bar grow.
  `ProgressBar` drops its own outer border/padding and becomes the growing cell.
  Its time text stays inside it, so the imperative cursor painting is unchanged.
- `LoopToggle` moves from `sonataPlayerPane.Actions` to
  `SonataPlayer.Transport` (`progress/plugins/loop/web/index.ts`).
- Strip order is `play`, `progress-bar`, `loop-toggle`. `Transport` is a
  reorderable render slot, so the order goes in its reorder config, written the
  same way the actions config is. The slot is listed in
  `reorder/shared/reorderable-slots.generated.ts`, so `./equin build`
  regenerates the file.

### 9. Remove the sustain chip

Delete the `pedal/plugins/indicator` sub-plugin. Its only job is the
`pedal-indicator` header chip. The build regenerates the registry, and the
plugin's config key leaves the actions config.

### 10. Header order (`config/apps/sonata/library/sonata-player.actions.jsonc`)

Rewrite the items, and update the prose comment in the file to explain the new
order:

```jsonc
"items": [
  "apps.sonata.library:back",
  "primitives.pane:title",
  { "type": "spacer", "id": "spacer-1" },
  "apps.sonata.transport-bar:speed",        // time: how fast…
  "apps.sonata.audio.metronome:metronome",  // …and the beat that goes with it
  "apps.sonata.transpose:transpose",        // pitch
  "apps.sonata.audio.engine:volume",        // output
  "apps.sonata.piano-roll:spread",          // view: zoom
  "apps.sonata.library:display-picker"      // which view — far right
]
```

There is no divider node for a row; the `ToolbarControl` borders already
separate the wheels. Also update the `panes.tsx` / `library/CLAUDE.md` prose that
names the bar's contents ("display picker, transport, volume, the jog wheel").

## Not changing

- The piano roll's Key / View / FX HUD chips and the other displays' HUDs.
- Keyboard shortcuts: Space, ←/→ seek-and-hold, ↑/↓ tempo.
- The progress bar's markers (keys, bars, sections, loop region).
- The shared `PaneChrome` / `AdaptiveBar`. Its overflow menu still catches
  items when the header is narrow; collapsed wheels make that rarer.

## Verification

1. `./equin build` (backgrounded). Then `./equin check` for
   boundaries, the docs in sync, the registry in sync and type-check.
2. Screenshot the player on a song:
   `./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --path /sonata/song/<id> --out /tmp/sonata-bar`
   - The header matches the target row: no seek buttons, no Ped., no "Display"
     label, view switcher far right.
   - The strip shows play · timeline · loop.
3. Same script with `--click "Transpose"` and `--click "Metronome"`: the
   popovers open. Stepping changes the readout, the badge and the key line, and
   the Play-in grid sets the offset.
4. Hover and drag, by hand or in a small e2e under `SONATA/transport-bar/e2e/`:
   - Hovering speed / zoom / volume opens each control.
   - A flick on a wheel keeps it open until it settles.
   - The ↑/↓ keys still move the speed readout.
   - ←/→ still seek with the seek buttons gone.
5. Re-run the existing scripts that touch these items:
   - `primitives/plugins/pane/e2e/header-reorder.ts` (Sonata header reorder)
   - `SONATA/e2e/song-switch.ts` (transpose readout across song switches —
     update its selector for the popover trigger)
   - `SONATA/progress/plugins/loop/e2e/loop-drag.ts`
   - `SONATA/view-options/e2e/view-vs-fx.ts`
6. Compare against the mock with
   `plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1791407620-ij8o`
   as a visual sanity check. It is not a pixel gate; the mock's drum wheel is
   intentionally replaced by the app's `JogWheel`.
