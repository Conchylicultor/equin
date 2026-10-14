# engine

Owns the Web Audio graph (one `AudioContext` + master gain) and the playback
scheduler for the Sonata player. On each `isPlaying → true` transition it
captures a single anchor (`ctx.currentTime` + the cursor beat) and schedules
notes against the audio clock in a bounded, timer-free look-ahead window.

## Engine ↔ control split

The graph is split across two contributions so the volume control's visibility
never touches playback:

- **`AudioEngine`** (`SonataSession.Effect`, `components/audio-engine.tsx`) —
  headless, mounted **once** per playback session (`SonataPlayerScope`) and
  therefore always mounted while a song can play. Owns the `AudioContext`, master
  gain, the per-track channel strips, the `registerClock` registration, and all
  scheduling.
- **`VolumeControl`** (`sonataPlayerPane.Actions`, `components/volume-control.tsx`)
  — the master-volume control pinned into the Sonata player pane's header: the
  speaker (mute) at rest, its slider folded away and opening on hover / focus
  (and held open while dragged) through `primitives/toolbar-control`'s
  hover-expand rule, the one the jog wheels use. Owns **no** audio.

They communicate through a **per-surface** `audio-store` (`audio-store.ts`, built
on the `scoped-store` primitive): the control writes `volume`, the engine reads
it to drive master gain; the engine also publishes `status` / `loadError` here.
The store's `<Provider>` (`components/audio-provider.tsx`) is folded above the
whole session subtree via the `SonataSession.Provider` wrapper slot — an ancestor
of both the effect and the toolbar control, which live in different slot branches
— so two open Sonata surfaces have independent volume/status/mute instead of one
module-level singleton bleeding across them.

This is deliberate: the `AudioContext` lifecycle must **not** be tied to any
piece of mountable UI. If the graph lived inside a control that could unmount,
React's cleanup would `ctx.close()` mid-playback and kill all sound. Keeping it
in the always-mounted effect makes the control purely cosmetic.

## Per-track channel strips (instrument + volume)

There is **no global instrument picker** here — the instrument choice and the
fader both live per-track, in the Tracks panel (`track-mixer`). The engine turns
that into audio by keeping **one channel strip per audible track**:

```
track's notes → its InstrumentVoices → its GainNode (the fader) → master → out
```

A strip is `{ gain, voices, instrumentId }` in `channelsRef`, keyed by track id.

**Why per track and not per instrument.** The engine used to keep one voice
manager per *distinct in-use instrument*, shared by every track resolving to it.
That sharing is exactly what made a per-track fader impossible: a shared voice
manager has a single output node, so two piano tracks had one place to put a
level between them, not two. Per-track strips cost N instances of the same
instrument, which is paid for by handing every smplr instrument a shared
`SampleLoader` — it caches decoded buffers by resolved URL, so N instances of
one instrument are still one download and one decode.

**The strip set** is one sorted fingerprint of the `(trackId → instrumentId)`
pairs over tracks that still have audible notes — and the fingerprint is also
the payload, so the reconcile effect reads the pairs back out of it instead of
depending on a Map. That matters because every hook derived from the persisted
track rows (`useTrackInstrumentMap`, `useMutedTrackIds`, `useTrackVolumeMap`)
re-mints its Map or Set whenever *any* field of *any* track row changes — a
fader move included. Keying on identity would rebuild the schedule on every
drag; keying on content changes only when the strip set really does.

**An instrument change re-voices the strip in place.** The old voices are
disposed and the new ones are built into the *same* `GainNode`, because the
fader belongs to the track, not to the instrument. The level — and any glide
still running on it — survives the new timbre. The scheduling rebuild effect
runs in the same commit: it awaits the new instrument's `loaded` promise and
gives a clean `allOff` → dispose → create → re-attack cutover. Reconcile is
declared *before* the rebuild effect, so React runs the rebuild's cleanup
(`allOff`) before reconcile's setup (`dispose`), an ordering the instrument
wrappers' `disposed` guard explicitly tolerates.

**Volume is applied by its own effect, deliberately.** Creating a strip writes
`gain.gain.value` directly — nothing has played through the node yet, so a jump
cannot click. Every later change goes through a separate effect that calls
`setTargetAtTime(target, ctx.currentTime, 0.03)` on the live strips: a short
glide, so a fader moved across a sounding note doesn't step discontinuously.

It is separate because the reconcile effect creates and destroys audio nodes and
the rebuild effect cancels and re-attacks every ringing note — and a level move
is not a reason to do either. **The volume map must never reach either one's
dependency list**: dragging one track's fader would then cut every other track's
sound, the same hazard the tempo jog-wheel fix exists for. Outside its own
effect the map is read through a `useLatestRef`. The fader effect is keyed on a
content fingerprint of the levels *and* on the strip fingerprint, so a strip
created mid-session picks up its current position on the next commit.

**Mute and volume 0 are different mechanisms, on purpose.** Mute removes the
track's notes upstream (`useMutedTrackIds` → `audibleNotes`), so a muted track
has no strip at all: no sample load, no scheduling cost. Volume 0 is just a
fader position on a strip that keeps existing and keeps being scheduled, so
raising it again is instant. Folding volume 0 into the audible set would put the
levels back into the rebuild effect's inputs, which is the one thing this design
is arranged to prevent.

`startScheduling(score, from, audioAnchor, resolveVoices, ctx, loop, opts)` takes
a per-track resolver, not a single voice manager, and calls
`resolveVoices(note.track)?.schedule(note)`. That resolver is now simply
`channelsRef.current.get(trackId)?.voices` — the scheduler's contract did not
change when the strips did.

## The A–B loop

`loop` is the session's `loopCycle` (score/core `LoopCycle`: A, B and the rest
before each repeat) — the same object the transport folds the cursor with, so
the two agree on every iteration's length by construction. The scheduler lays
the first pass `[from, B)` and then iterations of `[A - rest, B)` end to end on
one cumulative-beat path timed through the tempo index: the rest is real time on
the path (timed by the tempo over the bar it replaces), and only the body's
notes `[A, B)` sound in it. `from` is the cursor's `{ beat, rest }` — a cursor
paused inside a rest resumes with the rest's remainder of silence. The
metronome passes `{ restSounds: true }`, so its clicks keep counting through a
rest like a one-bar count-in to every repeat. The rebuild effect depends on the
identity-stable `loopCycle` directly: toggling, moving the bounds or switching
the rest rebuilds; a plain wrap never does.

## Slaved to a transport driver

When the session has a `TransportDriver` (a recording owns the position), the
synth stays a look-ahead scheduler on `ctx` — the only sample-accurate clock —
and only its anchor comes from the driver (`transport-sync.ts`, exported for
the metronome too):

- **Rebuild.** `scheduleOrigin(readDriver(), cursor, now)` says where a
  schedule built now starts: the cursor's position on the session's own clock, the
  driver's beat when it advances, nothing while it is `stalled`. The rebuild
  effect also keys on `syncEpoch` (a stall, a resume, the session's own
  driver seeks, a driver coming or going). Driven, the origin is read AFTER the
  instruments' load wait, since the medium kept moving.
- **Drift.** `useDriftCorrection` compares, on every cursor write (render
  cadence, not a timer), `handle.beatAt(ctx.currentTime)` with the driver's
  beat; past ±40 ms at the playing tempo it calls `handle.resync(beat, now)` —
  `retime`'s sibling: moves the anchor, never cuts or re-triggers a note, and
  drops a skipped note only when it would sound more than 80 ms late.
- The sync offset is not here: it is the driver's (`recording`), so the cursor
  and the synth move together.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Sonata audio engine: schedules the Score's notes against the Web Audio clock on play, routing each note to its track's resolved instrument, with master volume in the player pane's header.
- Web:
  - Contributes:
    - `SonataSession.Provider` → `AudioProvider`
    - `SonataSession.Effect` "audio-engine" → `AudioEngine`
    - `sonataPlayerPane.Actions` "volume" → `VolumeControl`
  - Uses:
    - `apps/sonata/audio/instruments.InstrumentVoices`
    - `apps/sonata/audio/instruments.SonataAudio`
    - `apps/sonata/library.sonataPlayerPane`
    - `apps/sonata/primitives/toolbar-control.hoverExpandHost`
    - `apps/sonata/primitives/toolbar-control.HoverExpandPanel`
    - `apps/sonata/session.DriverReading`
    - `apps/sonata/session.SonataSession`
    - `apps/sonata/session.useCursorApi`
    - `apps/sonata/session.useSession`
    - `apps/sonata/track-mixer.useMutedTrackIds`
    - `apps/sonata/track-mixer.useTrackInstrumentMap`
    - `apps/sonata/track-mixer.useTrackVolumeMap`
    - `primitives/css/slider.Slider`
    - `primitives/css/spacing.Inset`
    - `primitives/css/spacing.Stack`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/scope/scoped-store.defineScopedStore`
  - Exports (types):
    - `AudioGraph`
    - `ScheduleHandle`
    - `ScheduleOrigin`
  - Exports (values):
    - `scheduleOrigin`
    - `startScheduling`
    - `useAudioGraph`
    - `useDriftCorrection`
- Cross-plugin:
  - Imported by:
    - `apps/sonata/audio/live-play`
    - `apps/sonata/audio/metronome`

<!-- AUTOGENERATED:END -->
