# Sonata: bounded, timer-free audio scheduling

## Context

When Sonata plays a Score, the audio engine schedules **every** note up front in a
single synchronous pass. `scheduleNotes` (in
`plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/scheduler.ts`)
iterates the whole `score.notes` array on the `isPlaying → true` transition and
hands each future note to the instrument's voice pool
(`smplr`'s `SplendidGrandPiano`) at once.

For large MIDI files this allocates a Web Audio voice per note all at once —
wasteful, and it can stall the start of playback while thousands of voices are
created. We want audio scheduling to stay **bounded regardless of Score size**
while remaining **timer-free** (no `setInterval` / polling, per the project's
no-polling rule).

`requestAnimationFrame` is *not* a valid driver here: rAF is throttled/paused
when the tab is backgrounded, but audio must keep playing. The clean, push-based
driver is **Web Audio's own clock**, via the `onended` event of a scheduled
silent source node.

**Out of scope (filed separately):** the visual cursor (rAF / `performance.now()`)
and audio (`AudioContext.currentTime`) run on two unsynchronized clocks and drift
apart on long pieces. That is tracked in task `task-1780488199450-5nk01a` and is
not addressed here.

## Approach

Replace the one-pass `scheduleNotes` with a stateful, look-ahead-window
scheduler that schedules only the notes falling inside a short horizon, then
wakes itself — driven entirely by the audio clock — to refill the window until
the Score is exhausted.

### The look-ahead loop (timer-free)

- Define two constants (audio seconds):
  - `LOOKAHEAD_SEC = 1.5` — how far ahead of `ctx.currentTime` we schedule.
  - `REFILL_SEC = 0.75` — when to wake to refill (≈ half the window, so ≥0.75s of
    already-scheduled audio always remains as a safety margin against event latency).
- On each **pump**:
  1. `horizon = ctx.currentTime + LOOKAHEAD_SEC`.
  2. Schedule all pending notes with `when <= horizon`, advancing an index.
  3. If notes remain, arm the next wake-up; otherwise stop (no more pumps).
- **The wake-up is a Web Audio event, not a JS timer.** Create a
  `ConstantSourceNode` with `offset = 0` (silent — DC zero), connect it to
  `ctx.destination`, `start()` it now and `stop(ctx.currentTime + REFILL_SEC)`.
  Its `onended` fires on the audio clock when that time is reached and calls
  `pump()` again. `ConstantSourceNode` is supported in all modern browsers
  (Chromium included) and keeps firing while the tab is backgrounded, unlike rAF.

This bounds the work per pump to the notes within a ~0.75s sliding window
(plus the initial 1.5s) — bounded by tempo/density, never by total Score length.
A short clip that fits entirely within `LOOKAHEAD_SEC` schedules in the first
pump and arms no ticker, so there is **no behavior change for small scores**.

### Note ordering

The window needs notes sorted by onset. `score.notes` is in compiler/onset order
per track but not guaranteed globally sorted, so build a sorted play-list **once**
at play start: filter out notes fully in the past, map each to its absolute audio
`when`/`duration` (reusing `beatToSeconds`, exactly as today), and `sort` by `when`.
This is cheap pure-JS work (O(n log n) on plain numbers, milliseconds even for
tens of thousands of notes) — the expensive thing being avoided is up-front Web
Audio voice allocation, not the array sort.

### Cancellation

The scheduler returns a handle with `cancel()` that sets a `cancelled` flag
(guarded at the top of `pump`), clears the pending ticker's `onended`, stops and
disconnects it. The `AudioPanel` scheduling effect calls `handle.cancel()`
alongside `voices.allOff()` in its cleanup, so stop / score-change / instrument-change
tears the loop down cleanly.

## Files to modify

### `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/scheduler.ts`

Replace `scheduleNotes(...)` with `startScheduling(...)` returning a
`ScheduleHandle`. Sketch:

```ts
import { beatToSeconds, type Score } from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { InstrumentVoices } from "@plugins/apps/plugins/sonata/plugins/shell/web";

export interface ScheduleHandle {
  cancel(): void;
}

const LOOKAHEAD_SEC = 1.5; // schedule this far ahead of the audio clock
const REFILL_SEC = 0.75;   // wake to refill when ~half the window remains

/**
 * Bounded, timer-free playback scheduler. Builds the future-note play-list once
 * (sorted by absolute audio time), then schedules only the notes inside a short
 * look-ahead window. It re-arms itself via the `onended` of a silent
 * ConstantSourceNode — the audio clock drives every wake-up, so work per pump
 * stays bounded by tempo (never by Score size) and scheduling keeps running even
 * when the tab is backgrounded (unlike rAF). No setInterval / polling.
 */
export function startScheduling(
  score: Score,
  fromBeat: number,
  audioAnchor: number,
  voices: InstrumentVoices,
  ctx: AudioContext,
): ScheduleHandle {
  const t0 = beatToSeconds(score, fromBeat);
  const pending = score.notes
    .filter((n) => n.start + n.duration > fromBeat) // drop notes fully in the past
    .map((n) => {
      const startSec = beatToSeconds(score, n.start);
      return {
        pitch: n.pitch,
        velocity: n.velocity,
        when: audioAnchor + startSec - t0,
        duration: beatToSeconds(score, n.start + n.duration) - startSec,
      };
    })
    .sort((a, b) => a.when - b.when);

  let i = 0;
  let ticker: ConstantSourceNode | null = null;
  let cancelled = false;

  const pump = (): void => {
    if (cancelled) return;
    const horizon = ctx.currentTime + LOOKAHEAD_SEC;
    while (i < pending.length && pending[i].when <= horizon) {
      voices.schedule(pending[i]);
      i++;
    }
    if (i >= pending.length) return; // everything scheduled; arm no further wake-ups

    const node = new ConstantSourceNode(ctx, { offset: 0 }); // silent (DC 0)
    node.connect(ctx.destination);
    node.onended = () => {
      node.disconnect();
      if (ticker === node) ticker = null;
      pump();
    };
    node.start();
    node.stop(ctx.currentTime + REFILL_SEC); // onended fires here, on the audio clock
    ticker = node;
  };

  pump();

  return {
    cancel(): void {
      cancelled = true;
      if (ticker) {
        ticker.onended = null;
        ticker.stop(); // safe: always started; a second stop() is a no-op per spec
        ticker.disconnect();
        ticker = null;
      }
    },
  };
}
```

Notes:
- No empty `catch` / silenced errors (per CLAUDE.md). `stop()` is only ever called
  after `start()`, so it cannot throw `InvalidStateError`; a redundant `stop()`
  after `onended` is a defined no-op.
- The per-note mapping is byte-for-byte the same math as today's `scheduleNotes`
  (reuses `beatToSeconds`), so timing semantics are unchanged.

### `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/components/audio-panel.tsx`

- Update the import from `scheduleNotes` to `startScheduling` (+ `ScheduleHandle` type).
- In the scheduling effect (currently lines 105–132), hold the handle and cancel it
  in cleanup, passing `ctx` through:

```ts
let handle: ScheduleHandle | null = null;
let cancelled = false;
void (async () => {
  await voices.loaded;
  if (cancelled) return;
  handle = startScheduling(score, fromBeat, audioAnchor, voices, ctx);
})();

return () => {
  cancelled = true;
  handle?.cancel();
  voices.allOff();
};
```

- Update the component's doc comment (lines 12–20) — it currently says it
  "schedules every upcoming note up front"; change to describe the bounded
  look-ahead window.

No other files import `scheduler.ts` (it is engine-internal, imported only by
`audio-panel.tsx` via relative path — not re-exported from the engine barrel), so
the rename is fully contained. No barrel/slot changes needed.

## Verification

1. `./equin build` from the worktree; fix any type/lint errors.
2. `./equin check` (eslint, boundaries) passes.
3. Open `http://<worktree>.localhost:9000`, go to the Sonata app.
4. Load a **large** MIDI file via the MIDI source, press Play:
   - Playback **starts promptly** (no multi-second stall while the whole score is
     allocated).
   - Audio **continues past the first 1.5s window** and stays seamless for a long
     stretch — this confirms the `onended`-driven refill loop is firing (a broken
     refill would cut out after ~1.5s).
   - Press Stop mid-playback: sound stops immediately and does not resume
     (confirms `cancel()` + `allOff()` tear-down).
   - Switch instrument / reload score during playback: no stuck/leaked notes.
5. Small clip (shorter than ~1.5s of audio) still plays identically — confirms the
   no-ticker fast path.
6. Optional sanity check via DevTools while paused on a large score: scheduling
   should not block the main thread on Play (Performance panel shows no long task).
