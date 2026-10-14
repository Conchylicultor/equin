# Sonata: one shared playback timeline

## Context

Slowing down while looping, the cursor and the sound drift apart. Root cause:
the "where are we" mapping (audio time → beat) exists **three times**, kept in
lock-step only by convention:

| Copy | Anchor | Loop fold | Tempo change |
|---|---|---|---|
| Cursor — `session/web/session.tsx` | `anchorRef {startClockSec, startBeat, startScoreSec}` | `score/core/loop-fold.ts` `foldLoopTime` | `useLayoutEffect → reanchor(cursor.getBeat())` |
| Synth — `audio/engine/web/scheduler.ts` (via `audio-engine.tsx`) | `anchorWhen / anchorC / anchorPathSec` | own `pathSec` / `pathSecInverse` | `handle.retime(score, ctx.currentTime)` |
| Metronome — `audio/metronome/web/components/metronome-engine.tsx` | a second `startScheduling` instance | same as synth | its own `retime` effect |

On a tempo change the synth re-derives its position exactly from its own
anchor, but the cursor re-anchors on `cursor.getBeat()` — the beat of the
**last rAF frame** — pinned to the **current** clock. Each change loses
`now − lastTick` (≤ 16 ms); a speed-wheel drag is ~60 changes/s, so the cursor
falls behind by up to ~1 s. Nothing heals it: only a seek rebuilds both, and an
A–B wrap is seamless by design. Driven mode adds a fourth piece
(`useDriftCorrection`, run separately by engine and metronome).

**Goal (ladder rung 1 — inexpressible):** one immutable `PlaybackTimeline`
value, owned by the session, is the only audio-time ↔ beat mapping. The cursor
is `timeline.beatAt(clock.now())`; every scheduler places note `c` at
`timeline.timeAt(c)`. A tempo change derives the new timeline *from the old one
at `now`* — no sampled cursor is ever an input — so cursor and sound cannot
disagree.

## Design

### 1. `PlaybackTimeline` — pure, in `score/core/timeline.ts`

Next to `tempo-index.ts` / `loop-fold.ts` (session already imports only
`score/core`; engine and metronome import it too). Immutable value:

```ts
/** The beat sequence being played: head [fromBeat, loop?.end) then loop iterations. Tempo-invariant. */
interface PlaybackPath { fromBeat: number; loop: LoopWindowBeats | null }

interface PlaybackTimeline {
  readonly path: PlaybackPath;          // identity = "same notes in same order"
  readonly tempo: TempoIndex;           // the scaled score's index
  // anchor: path coordinate c0 sounds at clock time t0
  timeAt(c: number): number;            // c → clock seconds   (was scheduler whenFor)
  cAt(t: number): number;               // clock seconds → c   (was scheduler cAt)
  beatOf(c: number): number;            // c → score beat, loop folded
  beatAt(t: number): number;            // beatOf(cAt(t))      — the cursor
  iterAt(t: number): number;            // loop iteration      — wrap detection for the cursor's `seek` flag
  cOfBeatNear(beat: number, near: number): number;
}

startTimeline(path, tempo, t): PlaybackTimeline     // c=0 at t
retempo(tl, tempo, t): PlaybackTimeline             // same path; c0 = tl.cAt(t), t0 = t
resync(tl, beat, t): PlaybackTimeline               // same path; c0 = cOfBeatNear(beat, tl.cAt(t)), t0 = t
rebaseClock(tl, oldNow, newNow): PlaybackTimeline   // clock swap: same c at newNow
```

The math moves verbatim out of `scheduler.ts` (`pathSec`, `pathSecInverse`,
`beatOf`, `cOfBeatNear`), which already handles varying tempo inside the loop.
`foldLoopTime` is deleted (its tests are folded into `timeline.test.ts`).

### 2. Session owns it — a `TimelineStore`

Session state: `timelineRef` holding
`{ kind: "stopped" } | { kind: "stalled" } | { kind: "running"; timeline; generation }`,
exposed on `useSession()` as a **stable** store (`getTimeline()`, `subscribe(fn)`),
not React state — it changes ~60×/s during a drag and must not re-render
consumers (same reasoning as the cursor store).

Each change has a kind, published to subscribers:
- **continuous** (`retempo`, `resync`, `rebaseClock`) — same `path`, so a scheduler keeps its generator and only re-times what it has not dispatched;
- **restart** (play, seek, loop toggle/bounds, driver wrap/stall/resume, content reset) — new `path` → `generation++`; schedulers rebuild.

Session call sites:
- `play` / the `isPlaying` effect: `startTimeline({fromBeat: cursor, loop}, tempoIndex, clock.now())` — the cursor is read only when paused, where it *is* the truth.
- `seekTo`, `setLoop` (when playing), content reset with play-on-load: restart.
- the tempo `useLayoutEffect`: `retempo(current, newTempoIndex, clock.now())` — **replaces `reanchor(cursor.getBeat())`** (the bug).
- `registerClock` swap: `rebaseClock`.
- `reanchor`, `anchorRef`, `loopIterRef`'s reset-on-anchor go away; the tick becomes
  `beat = tl.beatAt(now); wrapped = tl.iterAt(now) !== lastIter` (end-of-song stop unchanged, unlooped only).
- **Driven mode:** the drift check moves *into the session's driven tick* (once,
  for every consumer): `|tempo.beatToSeconds(tl.beatAt(now)) − tempo.beatToSeconds(driverBeat)| > DRIFT_TOLERANCE_SEC → resync`.
  Stalled → `{kind:"stalled"}`; advancing again / driver A–B wrap → restart at the driver's beat.
  The cursor still shows the driver's beat (the medium is the truth); the timeline is what the synth sounds.
  `readDriver`, `syncEpoch`, `scheduleOrigin` and `useDriftCorrection` become internal or are deleted.

`seekEpoch` stays only if a non-audio consumer needs it (grep shows only the
engine, metronome and `onset-tracker.test.ts`; the piano-roll FX use the cursor
store's `seek` flag) — expected: deleted.

### 3. Scheduler reads the timeline — `audio/engine/web/scheduler.ts`

```ts
startScheduling(notes, sustainSource, timelines: TimelineStore, resolveVoices, ctx): { cancel(): void }
```

- Subscribes to the store. On **restart** (new `generation`): reset the
  generator from `timeline.path` (head then loop iterations — today's
  `nextEvent`, unchanged) and drop events whose `timeAt(c)` is more than
  `RESYNC_LATE_SEC` behind `ctx.currentTime` (covers the instrument-load wait
  and driver jumps — one rule instead of `dropBefore` + `playAnchor`).
  On **continuous**: re-time the peeked event and `pump()` now (today's `retime` behaviour).
  On **stopped/stalled**: arm nothing.
- `when = timeline.timeAt(c)`, `duration` from `timeline.tempo` + pedal sustain (unchanged).
- `retime`, `resync`, `beatAt` and `ScheduleHandle`'s extra methods are deleted.
- Committed notes (handed to smplr) stay committed — same 40 ms look-ahead trade-off as today.

### 4. Engine + metronome become thin

- `audio-engine.tsx`: the rebuild effect keeps only *note-set* changes
  (`audibleNotes`, `inUseKey`) → recreate the scheduler against the same store;
  play/seek/loop/driver deps (`isPlaying` still gates `allOff`), the retime
  effect and `useDriftCorrection` are removed. `allOff` on restart stays (today a
  seek cuts ringing notes; keep that behaviour).
- `metronome-engine.tsx`: same — its click notes scheduled against the same
  store. Count-in stays on its own clock-only path (`countIn.startedAtClockSec`),
  unchanged.
- `transport-sync.ts` deleted; engine barrel stops exporting
  `scheduleOrigin`/`useDriftCorrection`/`ScheduleHandle`.

### Not in scope

Output-latency compensation (`ctx.outputLatency`, Bluetooth) — a constant
offset, separate concern; can be one field on the clock later.

## Critical files

- new `plugins/apps/plugins/sonata/plugins/score/core/timeline.ts` (+ `timeline.test.ts`), export from `score/core/index.ts`; delete `loop-fold.ts`(+test)
- `plugins/apps/plugins/sonata/plugins/session/web/session.tsx` (timeline store, tick, driven drift check), `session/web/index.ts`, `session/CLAUDE.md`
- `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/scheduler.ts`, `components/audio-engine.tsx`, delete `transport-sync.ts`, `engine/CLAUDE.md`
- `plugins/apps/plugins/sonata/plugins/audio/plugins/metronome/web/components/metronome-engine.tsx`

## Verification

1. `./singularity test plugins/apps/plugins/sonata/plugins/score` — `timeline.test.ts`:
   `retempo` keeps `beatAt(t)` continuous at `t`; round-trips `timeAt∘cAt`; loop
   iterations with a tempo map that changes inside the loop; `resync` picks the nearest iteration.
2. `./singularity test plugins/apps/plugins/sonata/plugins/audio/plugins/engine` — port `scheduler.test.ts` to drive a store; **regression test**: loop A–B, 200 `retempo`s at random clock times between "frames", then assert every dispatched note's `when` equals the time the session cursor reaches that note's beat (`beatAt`) — exact, not within tolerance.
3. `./singularity test plugins/apps/plugins/sonata/plugins/session` — `session.test.tsx` / `transport-driver.test.tsx` updated; new test: tick, advance clock 10 ms, change tempo, tick → cursor equals `timeline.beatAt(now)` (fails on today's code by the lost 10 ms).
4. `./singularity build`, then by ear on `http://<worktree>.localhost:9000/sonata/song/song-1791906309-k4zovl`: set an A–B loop, drag the speed wheel back and forth for several seconds, let it loop 5+ times — the cursor and the notes stay together. Also check: plain playback, seek while playing, metronome on, a song with a recording (driven mode).
