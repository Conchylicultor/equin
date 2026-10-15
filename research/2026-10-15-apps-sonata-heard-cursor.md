# Sonata: the cursor shows what is heard, not what is rendered

## Context

The session's rAF tick draws the cursor at `timeline.positionAt(clock.now())`, and the
registered clock is `AudioContext.currentTime`, which is when a sample is rendered. The sample
reaches the ears later, by the output latency (`baseLatency + outputLatency`): about 10–40 ms on
built-in speakers and 150–250 ms on Bluetooth. Every visual follower (piano roll, notation, lit
keys, FX, scrubber, songsheet and the rest) reads the cursor store, and the session's tick is the
cursor's only writer during playback. So the whole UI leads the sound by a constant offset that
depends on the device, and the offset changes when the output device changes.

What we want: the schedulers keep placing notes on the raw context clock (`timeline.timeAt(c)`,
unchanged), and only what the user sees follows what they hear.

Grep confirms that nothing visual reads the `PlaybackTimeline` directly. Its readers are the
session tick, `livePosition`, `followDriver` and the audio schedulers. The fix therefore sits at
one seam: the session's tick. The count-in overlay is the one other visual that reads the audio
clock.

## Model

- **Render time** `t`: the clock's `now()`. Timelines, `startAt` and the schedulers keep using it,
  unchanged.
- **Heard time** `h = now() − latency()`: the render instant whose sound reaches the ears now.
  The cursor shows the music at `h`.
- **A driver's medium position counts as heard time.** The browser's media clock (YouTube
  `<video>.currentTime`) already accounts for output delay so that picture and sound stay in sync.
  So a medium beat `b` heard now is the synth's `b` rendered at `h`, and the timeline is anchored
  there.

## Design

### 1. `TransportClock.latency()` (session/web/session.tsx)

```ts
export interface TransportClock {
  now(): number;
  /** Seconds from rendering a sample at `now()` to hearing it (≥ 0). */
  latency(): number;
}
```

- The field is required, so tsc forces every clock to state its latency.
- `wallClock` returns `latency: () => 0`.
- Tests that use `{ now }` fakes gain `latency: () => 0`, or a nonzero value in the new tests.

### 2. The engine's clock reports the device latency (audio/engine/web)

- Add a new `output-latency.ts` with `outputLatencySec(ctx)`: `ctx.baseLatency + (ctx.outputLatency ?? 0)`.
  - Safari has no `outputLatency`; there it falls back to `baseLatency` alone, and the comment
    will say so.
  - It applies a small hysteresis (keep the last value unless the new reading differs by more
    than 5 ms). Chrome's value jitters by a few ms per read, and that jitter would otherwise shake
    the cursor. A device switch moves the value by tens to hundreds of ms and passes through
    immediately.
- Register the clock as `registerClock({ now: () => ctx.currentTime, latency: () => latency.read() })`.
- Device changes need no listener and no polling. `outputLatency` is a live property, and the
  tick already reads the clock every frame at render cadence.
- Export `outputLatencySec` (or a `heardTime(ctx)` helper) from the engine barrel, so that the
  count-in overlay (`metronome/web/components/count-in-overlay.tsx`) computes `elapsed` from heard
  time. The countdown digit then flips when the click is heard, not when it is rendered.

### 3. The heard reader (new, pure: `session/web/heard-timeline.ts` + `.test.ts`)

Reading the current timeline at `h` is wrong right after a timeline is replaced. Between
`h` and the new timeline's anchor, the user still hears music that was scheduled under the
previous timeline. A small bounded history fixes this.

```ts
type HeardEntry = { timeline: PlaybackTimeline; from: number /* render t it took over */ };
createHeardReader(): {
  push(timeline, from, kind: "continue" | "jump"): void;
  clear(): void;
  cAt(h: number): number;
}
```

- **`continue`** keeps the earlier entries. Reading at `h` uses the newest entry with `from ≤ h`.
  Entries older than that one are pruned, so the history covers at most `latency` seconds.
  Use `continue` for:
  - a retempo (the speed wheel)
  - a drift resync
  - a continuity restart: `restartHere` / `livePosition` (a loop edit, a driver unregistering)

  The cursor then follows the old tempo or path until the change is actually heard. There is no
  jump of L × tempo.
- **`jump`** drops the history. Before `from`, it reads the new timeline clamped to `c = 0`: the
  cursor holds at the target until its first sound arrives. Use `jump` for:
  - play
  - a seek
  - content load
  - a driven wrap or seek

  A user's seek shows the target at once and never flicks back to the old position.
- A clock swap (`rebaseTimeline`) clears the history and pushes a `continue` entry. The history's
  times belong to the old clock's domain, and a swap only happens around engine mount.

The session owns one reader. It writes to it everywhere it calls `timelineStore.set({kind:"running"})`
and calls `clear()` on idle. The `kind` comes from the call site: `startAt` gains a
`kind` parameter, `restartHere` passes `continue`, and `seekTo`/`play`/the content reset pass
`jump`. The reader stays session-private. The published `TimelineStore` and the schedulers do not
change.

### 4. The tick reads heard time (session.tsx tick, ~L1167)

- Internal path: `c = heard.cAt(clock.now() − clock.latency())`. The wrap detection
  (`iterationOf`) and the end-of-song stop use that heard `c`, so the transport stops when the
  last note is *heard*, not rendered.
- `livePosition()` stays on render time, because it is the audio continuity point for restarts.

### 5. Driven playback (`drivenTick` / `followDriver`)

- The cursor still shows the medium's beat directly, since that position is heard time.
- `followDriver` compares the slip and calls `resyncTimeline(timeline, beat, h)` with `h = now − latency`
  instead of `now`. A first start from the medium is anchored at `h` too, through a new optional
  anchor time on `startAt`. That puts the synth's note for beat `b` at render time `h`, so it is
  heard together with the medium's `b`.
- The first ≤ L of synth notes after the medium starts already lie in the past. The scheduler's
  `LATE_DROP_SEC` drops them, which is correct: playing them late would put them off the beat.
- Caveat for the user: the mix's sync offset (`recording` `offsetSec`) may have been hand-tuned to
  cover for this very lag. Once the fix lands, a song tuned on Bluetooth may need retuning by
  about L. No migration, because the old value is device-specific anyway.

### 6. Pause/resume (no change, noted)

- On pause, the cursor parks at the last heard frame.
- On resume, playback restarts from the cursor, so it replays at most L of audio that had been
  rendered but not yet heard. That is musically fine and truthful to what was heard.

## Files

- `plugins/apps/plugins/sonata/plugins/session/web/session.tsx`: changes to `TransportClock`,
  `wallClock`, the tick, `startAt(kind, at?)`, `registerClock`, `followDriver` and the docs
  (`TransportClock`, `SessionValue.timeline`: "the cursor is the timeline at *heard* time").
- `plugins/apps/plugins/sonata/plugins/session/web/heard-timeline.ts` (+ `.test.ts`): new.
- `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/components/audio-engine.tsx`:
  registers `latency`.
- `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/output-latency.ts`: new, exported
  from the engine barrel.
- `plugins/apps/plugins/sonata/plugins/audio/plugins/metronome/web/components/count-in-overlay.tsx`:
  computes the countdown from heard time.
- `plugins/apps/plugins/sonata/plugins/score/core/timeline.ts`: no API change. Update the header
  comment ("the visual cursor reads `positionAt(now − latency)`").
- `plugins/apps/plugins/sonata/plugins/session/web/__tests__/transport-driver.test.tsx`: fake
  clocks gain `latency`.

## Verification

- **`heard-timeline.test.ts`** covers:
  - after a jump, the reader holds at the origin until `from`, then advances
  - after a continue (retempo, loop restart), it reads the old timeline until `from`, then the
    new one, with no discontinuity at `from` for a retempo
  - pruning keeps the history bounded
- **`transport-driver.test.tsx` / `session.test.tsx`**, with a fake clock where `latency = 0.2`:
  - the cursor equals `positionAt(t − 0.2)` while playing
  - after a seek, the cursor holds at the target for 0.2 s
  - a loop edit mid-play does not jump the cursor
  - a driven resync is anchored at heard time: `timeline.positionAt(now − L)` equals the medium's
    beat
  - the end-of-song stop fires L later
- **Run:** `./singularity test plugins/apps/plugins/sonata`.
- **Manual:** after `./singularity build`, on Bluetooth headphones, play a song with sharp onsets.
  The lit keys and the piano-roll strike should land on the sound. Switching the output device
  mid-play should step the cursor and keep it in sync. Built-in speakers should look unchanged
  (a lag of about 10–30 ms).

## Follow-up (not in scope)

- A per-device manual latency calibration nudge, for devices whose reported `outputLatency` is
  wrong (some Bluetooth stacks under-report it).
