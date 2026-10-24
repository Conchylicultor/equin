# Sonata: metronome click track + count-in

## Context

Sonata is a Synthesia-style practice player. It has tempo (BPM), a full
time-signature system, and a sample-accurate audio engine — but **no metronome
click** and **no count-in**. A learner practicing along has nothing to keep time
to, and playback begins on beat one with no lead-in. This adds:

1. **Metronome** — an audible click on every notated beat (downbeat accented),
   toggled on/off, that follows tempo changes and the A–B loop seamlessly.
2. **Count-in** — an optional 1- or 2-bar click lead-in before playback starts,
   with an on-screen countdown, so the player can prepare.

## Key design decisions

### Reuse the engine's scheduler — clicks are "notes"

The audio engine's `startScheduling()` (`audio/engine/web/scheduler.ts`) already
solves the two hard problems: **seamless A–B loop wrap** (pre-schedules loop
iterations on a cumulative-beat path, no teardown) and **tempo retime** (re-times
the undispatched tail without cutting ringing notes), all driven by the audio
clock (no `setInterval`). Rather than duplicate that, the metronome builds a
synthetic note list (one note per beat, `pitch` encodes accent) and feeds it
through the **same** `startScheduling` with a click voice. It inherits loop +
retime correctness for free.

→ Export `startScheduling`, `LoopWindowBeats`, `ScheduleHandle` from the engine
barrel (already the natural owner of the scheduler).

### Share the AudioContext via the audio-store (engine stays the sole owner)

Clicks must be sample-accurately aligned to playback, which is scheduled on the
engine's `AudioContext` (also the registered transport clock). A second
`AudioContext` would have a different time origin and could never align — so the
metronome must use the engine's ctx. The engine remains the **single owner** (its
lifecycle must not be tied to mountable UI; see engine `CLAUDE.md`); it simply
**publishes** the live ctx through the existing per-surface `audio-store` — the
same sanctioned engine↔control channel already used for volume/status.

- Add `graph: { ctx: AudioContext } | null` to `AudioState`; engine writes it on
  ctx create/teardown; new `useAudioGraph()` read hook exported from the engine
  barrel. The metronome guards `graph == null` (one-frame gap on mount).
- The metronome routes its click gain to **`ctx.destination` directly** (NOT the
  music master gain), with its own volume — so muting the music keeps the click
  audible (mute-music-keep-click is a real practice mode).

### Count-in needs **zero** transport anchor/tick changes

During the lead-in, keep `isPlaying = false`: the rAF transport isn't running, so
the cursor **parks at the start beat naturally**. The metronome plays the lead-in
clicks against the audio clock and, via a single `ConstantSourceNode.onended`
fired at the lead-in's end (audio-clock driven, no timer), calls back to start
real playback. The engine is **completely untouched** by count-in.

Small transport state machine added to `SonataProvider`
(`shell/web/context.tsx`):

- `countIn: { startBeat; beats; startedAtClockSec; durationSec } | null` state,
  exposed on `SonataContextValue`.
- `registerCountIn(provider: () => number)` → unregister (mirrors
  `registerClock`). The metronome registers a provider returning the lead-in
  length **in quarter-beats** (0 = disabled), computed from its config + the
  meter at the live cursor.
- `playWithCountIn()`: if already playing → no-op; read `lead = provider()`; if
  `lead <= 0` → `play()`; else compute `durationSec = lead × secPerQuarter` (from
  the live `tempoIndex` at the cursor) and `setCountIn({...})` **without** setting
  `isPlaying` (cursor stays parked).
- `finishCountIn()`: `setCountIn(null); play()` — begins normal playback from the
  parked start beat (engine anchors at `ctx.currentTime` as today).
- `cancelCountIn()`: `setCountIn(null)` — called from `stop()`, `seekTo()`, and
  the score-change reset effect so a seek/stop/new-song aborts a pending lead-in.
- Wire `togglePlay()` (the play button + Space shortcut) to call
  `playWithCountIn()` instead of `play()`. The internal resume paths
  (`endScrub`, auto-play-on-load) keep calling `play()` directly → **no count-in
  on scrub-release or background auto-play**, only on a deliberate play toggle.

## Implementation

New plugin **`plugins/apps/plugins/sonata/plugins/audio/plugins/metronome/`**
(sibling of `engine`/`piano`/`soundfont` under the `audio` umbrella — it is an
audio feature and imports the engine barrel for the shared ctx + scheduler).

```
metronome/
  shared/config.ts      defineConfig "sonata.metronome":
                          continuous: boolean = false   (click through the song)
                          countInBars: 0 | 1 | 2 = 0    (lead-in length)
                          volume: number = 0.6          (click level, independent)
                          accentDownbeat: boolean = true
  core/                 (only if a type needs sharing web↔server; likely none)
  server/index.ts       ConfigV2 server registration (mirror audio/.../fx-comets/server)
  web/click-voice.ts    createClickVoices(ctx, destination, opts): InstrumentVoices
                          — short osc+gain click; accent (pitch>=ACCENT) = higher
                            freq/level; allOff/dispose are ~no-ops (clicks are <60ms)
  web/click-notes.ts    buildClickNotes(score, accent): Note[]
                          — beatGrid(score,1) positions; mark a note accented when
                            its beat is a bars(score) downbeat; pitch encodes accent
  web/count-in.ts       computeCountInPlan(score, atBeat, bars):
                          { totalQuarters, clicks: { offsetQuarters; accent }[] }
                          — `bars × numerator` clicks at the meter in force at atBeat;
                            first click of each bar accented
  web/components/metronome-engine.tsx   Sonata.Effect (headless):
                          - reads useAudioGraph() ctx, useSonata() (isPlaying, score,
                            seekEpoch, loop, countIn, registerCountIn), config
                          - registers the count-in provider (config + live meter)
                          - CONTINUOUS: mirror engine's rebuild+retime effects with a
                            click voice + buildClickNotes via startScheduling (loop +
                            tempo inherited). Gated on config.continuous && isPlaying.
                          - COUNT-IN: on countIn != null, schedule the plan's clicks at
                            startedAtClockSec + offsetQuarters×secPerQuarter, and arm a
                            ConstantSourceNode.onended at +durationSec → finishCountIn().
                            Cleanup cancels clicks + the pending node if countIn clears.
  web/components/metronome-button.tsx   SonataToolbar.End:
                          - icon button; primary click toggles config.continuous
                            (active/filled when on)
                          - popover: Count-in segmented (Off / 1 bar / 2 bars),
                            volume slider, accent toggle
  web/components/count-in-overlay.tsx   Sonata.Hud:
                          - when countIn != null, a large centered countdown number,
                            pulsing per beat; current beat from
                            ceil(beats − (ctx.currentTime − startedAtClockSec)/secPerQuarter)
                            (ctx via useAudioGraph; rAF only for render cadence)
  web/index.ts          definePlugin: Sonata.Effect, SonataToolbar.End, Sonata.Hud,
                          ConfigV2.WebRegister
```

### Engine plugin edits (`audio/plugins/engine`)

- `web/audio-store.ts`: add `graph` to `AudioState` (default `null`); add
  `setGraph` to `useAudioControls`; add+export `useAudioGraph()`.
- `web/components/audio-engine.tsx`: in the ctx-create effect `setGraph({ ctx })`;
  on teardown `setGraph(null)`.
- `web/index.ts`: export `useAudioGraph`, `startScheduling`, `LoopWindowBeats`,
  `ScheduleHandle`.

### Transport edits (`shell/web/context.tsx` + barrel)

Add `CountInState`, `countIn` state, `registerCountIn`, `playWithCountIn`,
`finishCountIn`, internal `cancelCountIn`; clear count-in in `stop`/`seekTo`/the
score-reset effect; route `togglePlay` through `playWithCountIn`. Export
`CountInState` from `shell/web`.

## Files to modify / create

- **Create**: the whole `audio/plugins/metronome/` tree above.
- **Edit**: `audio/plugins/engine/web/audio-store.ts`,
  `audio/plugins/engine/web/components/audio-engine.tsx`,
  `audio/plugins/engine/web/index.ts`,
  `shell/web/context.tsx`, `shell/web/index.ts` (export `CountInState`).
- Reuse (no edit): `score/core` `bars`, `beatGrid`, `beatToSeconds`,
  `buildTempoIndex`, `scoreEndBeat`; `config_v2`; `primitives/popover`,
  `toggle-chip` (SegmentedControl), `icon-button`, css/spacing/text.

## Verification

1. `./equin build`; open `http://<worktree>.localhost:9000/sonata`, load a
   song (e.g. a MIDI or chord-grid source).
2. **Continuous metronome**: toggle the metronome button on, press Play → a click
   on every beat, accented on each bar's downbeat. Drag the speed wheel → clicks
   track tempo with no buzz. Set an A–B loop → clicks wrap seamlessly at B→A.
   Mute the music volume → clicks still audible.
3. **Count-in**: set Count-in = 1 bar in the popover, press Play (or Space) → N
   clicks play with an on-screen countdown while the cursor sits still, then the
   song + cursor start exactly on the downbeat. Set 2 bars → twice as long. Press
   Stop / seek during the count-in → it aborts cleanly.
4. Use a 3/4 and a 6/8 song to confirm the click count per bar follows the meter.
5. Scripted check via `e2e/screenshot.mjs` clicking the metronome button +
   asserting `aria-pressed`.

## Caveats / follow-ups

- The metronome's continuous rebuild/retime effects **mirror** the engine's
  (per "mirror working precedent"). A future refactor could extract a shared
  `useScheduledClock` hook used by both — file as a follow-up rather than
  destabilize the load-bearing engine now.
- Tempo change *during* a count-in is not retimed (a 1–2 bar lead-in); for
  predictability a tempo/seek/stop during count-in **cancels** it.
</content>
</invoke>
