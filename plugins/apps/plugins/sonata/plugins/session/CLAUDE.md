# session

The playback session: what plays a song, with no idea where the song came from
or which app shows it. It imports no Sonata plugin but `score/core`, so any host
can mount it (the Sonata app, a file preview) — usually through the player's
`SonataPlayerScope`, which composes it with a song document.

`<PlaybackSession content={…}>` takes the document's content as a structural
`SessionContent` (`empty | pending | failed | ready{score}`, each carrying a
`contentKey`) and provides `useSession()`: the tempo-scaled `score`, the
`timelineBeats`, play state, `tempoScale` (clamped to `[0, 4]`; 0 freezes the
transport), the A–B `loop`, the `countIn`, `seekEpoch`, `syncEpoch`, and the
stable verbs (play / stop / seek / scrub / loop / count-in / `registerClock` /
`registerTransportDriver`). The playhead
lives in the per-surface cursor store (`CursorStoreProvider`, `useCursorApi`,
`useCursorSelector`) so a ~60 fps advance never re-renders a `useSession()`
consumer; the session must be mounted inside a `CursorStoreProvider`.

## The A–B loop and the play position

The cursor holds a `PlayPosition` (score/core), not just a beat: `beat`, plus
the loop `rest` still to go and whether this is a `repeat` pass. `getBeat()` /
`setBeat()` stay the everyday reads/writes; `getPosition()` / `setPosition()`
carry the whole position, and `useCursorSelector`'s selector gets it as a second
argument.

`loop` is the user's range (`LoopRange`); `loopOptions` (`rest`, `ahead`) are
the user's repeat preferences, pushed in by the loop UI (`setLoopOptions`; a bare
session has both off). From them the session derives `loopCycle` — THE
definition of what plays after B that the tick's fold, the audio and metronome
schedulers and the piano roll all read: `null` unless a loop is enabled, else
`{ start, end, rest }` where `rest` is one bar at A's meter (`barBeatsAt`) when
the rest option is on. Every repeat iteration is `[A - rest, B)`; during the
rest the cursor reads `beat = A` with `rest > 0` counting down — score readers
park on A, and readers of what is BEING PLAYED (lit keys, highlighted
noteheads) show nothing. `reanchor` anchors at the position's fold time
(`timeOfPosition`), so a pause inside a rest or a repeat resumes there instead of
replaying the song before A.

With a transport driver the cycle's rest is `0`: a medium cannot fold, its wrap
stays a seek back to A, and a rest would only freeze the picture while the
recording plays on. (Pausing the medium for a bar would need a wall-clock timer
against an external player — not worth the drift.) `ahead` still applies — the
roll shows the copies, just without rests.

## The content reset

The transport resets (park at the lead-in, drop the loop and count-in, stop)
when `contentKey` changes — the identity of the loaded TIMELINE, not of the
composed score — so a view transform (transpose, voicing, key detection) applies
live without rewinding. New content that is `pending` stops the transport at
once and defers the reset until it composes. Two one-shot load intents ride the
reset: `requestPlayOnLoad()` (start playing) and `requestSeekOnLoad(beat)` (park
at `beat`, clamped to the new timeline, instead of the lead-in).

## Clocks and transport drivers

The anchored transport reads a `TransportClock` (`registerClock`; the audio
engine registers `ctx.currentTime`). Clocks stack: unregistering the active one
restores the one below, the wall clock at the bottom.

A `TransportDriver` (`registerTransportDriver`, also a stack) is an external
medium that OWNS the position — a recording the score is timed on. It speaks
MEDIA seconds (score seconds at tempo scale 1), converted through the unscaled
tempo map, so a driver never knows the tempo scale. While one is registered:

- the rAF tick reads `position()` (no anchor arithmetic); `null` freezes the
  cursor;
- `isPlaying` stays the session's intent and is forwarded (play / pause); on
  play the driver is first sought to the cursor when the two disagree (> 50 ms —
  a scrub moves only the cursor). `seekTo` seeks it; a new driver is sought to
  the cursor on register;
- an A–B wrap is a seek back to A (a medium cannot fold), guarded so a medium
  still reporting the old position does not wrap twice; the loop's rest is not
  applied (`loopCycle.rest` is 0 while driven);
- `setTempoScale` asks `setRate` and adopts the rate the medium took (only the
  latest request); 0 stays the session's freeze and pauses it;
- the driver's state is followed one way: a pause after moving, or `failed`,
  stops the transport; an advance while stopped is paused again — the medium
  never starts the transport, so the two cannot ping-pong;
- the count-in is skipped (it is clicked on the audio clock, which the medium
  does not follow).

`syncEpoch` bumps on every driver-relation change that is not a user seek
(register / unregister, advancing ↔ not, the session's own driver seeks), and
`readDriver()` says where a schedule built now starts (`internal` / `stalled` /
`advancing{beat}`) — anchored consumers rebuild from it on `syncEpoch` as they
do from the cursor on `seekEpoch` (see `audio/engine`'s `scheduleOrigin`).
Unregistering the last driver carries on from the cursor on the clock,
without stopping.

## Slots

- `SonataSession.Provider` (wrapper) — per-session React providers folded around
  the session's subtree (the audio and live-play stores).
- `SonataSession.Effect` (mount) — headless per-session effects mounted by the
  player scope (the audio engine, the live player, the metronome). App-only
  effects belong in the shell's `Sonata.Effect`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Sonata playback session: plays a song's composed content — the tempo-scaled score, the rAF transport over a per-surface cursor store, the A–B loop, the count-in, seek / scrub verbs, the play- and seek-on-load intents, a stack of clocks, and a stack of transport drivers (an external medium — a recording — that owns the position while registered). Mountable by any host (useSession); defines the per-session SonataSession.{Provider,Effect} slots the audio plugins contribute to.
- Web:
  - Slots:
    - `SonataSession.Provider`
    - `SonataSession.Effect`
  - Slot contributors:
    - `SonataSession.Provider` ← `apps.sonata.audio.engine`
    - `SonataSession.Provider` ← `apps.sonata.audio.live-play`
    - `SonataSession.Provider` ← `apps.sonata.recording`
    - `SonataSession.Effect` ← `apps.sonata.audio.engine`
    - `SonataSession.Effect` ← `apps.sonata.audio.live-play`
    - `SonataSession.Effect` ← `apps.sonata.audio.metronome`
  - Uses:
    - `primitives/latest-ref.useLatestRef`
    - `primitives/scope/scoped-store.defineScopedStore`
    - `primitives/scope/scoped-store.ScopedStore`
    - `primitives/slot-render.defineMountSlot`
    - `primitives/slot-render.defineWrapperSlot`
  - Exports (types):
    - `CountInState`
    - `CursorApi`
    - `CursorStore`
    - `DriverReading`
    - `DriverState`
    - `LoopOptions`
    - `LoopRange`
    - `SessionContent`
    - `SessionValue`
    - `TransportClock`
    - `TransportDriver`
  - Exports (values):
    - `cursorApiFor`
    - `CursorStoreProvider`
    - `PlaybackSession`
    - `SonataSession`
    - `TEMPO_MATH_FLOOR`
    - `useCursorApi`
    - `useCursorSelector`
    - `useSession`
- Cross-plugin:
  - Imported by: 30 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×30

<!-- AUTOGENERATED:END -->
