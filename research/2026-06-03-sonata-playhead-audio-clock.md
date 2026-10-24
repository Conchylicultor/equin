# Sonata: lock the visual playhead to the audio clock

## Context

In Sonata, two independent clocks drive playback:

- The **visual playhead** (`plugins/apps/plugins/sonata/plugins/shell/web/context.tsx`)
  advances `cursorBeat` on a `requestAnimationFrame` loop anchored at
  `performance.now()` (wall clock), inverting `beatToSeconds` to map elapsed
  seconds back to a beat.
- The **audio** (`plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/scheduler.ts`)
  schedules notes against `AudioContext.currentTime`, anchored at `ctx.currentTime`
  captured at the play instant.

Both already share the tempo map (`beatToSeconds`), so the *only* source of
divergence is the **clock origin**: `performance.now()` vs `ctx.currentTime`.
Two real-world consequences:

1. **Drift on long pieces** — the two clocks tick at subtly different rates
   (and the rAF inversion accumulates `STEP` quantization error), so the falling
   notes gradually slide out of sync with the sound.
2. **Background-tab snap/desync** — rAF is throttled/paused when the tab is
   backgrounded while `ctx.currentTime` keeps running. On return, the cursor
   snaps to catch up against wall-clock, momentarily landing at a position that
   doesn't match what's actually sounding.

**Goal:** the cursor must read time from the **same clock the audio uses**, so it
stays locked to the sound regardless of elapsed time or tab visibility. After the
fix, a background-return snap lands the cursor *exactly* where the audio is (no
desync), and there is no long-piece drift because there is only one clock.

## Approach

Make the transport's time source **pluggable**, defaulting to a wall clock and
upgraded to the AudioContext clock when the audio engine registers it. The audio
engine owns the `AudioContext`, so it is the natural authority — it pushes its
clock into the shell-owned transport. This keeps plugin boundaries intact (the
shell never imports the engine) and matches the existing data flow where
`AudioPanel` already consumes `useSonata()`.

### 1. Shell: a pluggable transport clock

`plugins/apps/plugins/sonata/plugins/shell/web/context.tsx`

- Define and export a tiny clock interface (also exported from the web barrel so
  the engine can type it):
  ```ts
  /** A monotonic time source in seconds, shared by the cursor and audio. */
  export interface TransportClock {
    /** Current time in seconds. Same units/origin the audio scheduler uses. */
    now(): number;
  }
  ```
- Hold the active clock in a ref, defaulting to a wall clock:
  ```ts
  const wallClock: TransportClock = { now: () => performance.now() / 1000 };
  const clockRef = useRef<TransportClock>(wallClock);
  ```
- Add a stable `registerClock(clock)` (via `useCallback([])`, reading refs only)
  to the context value. It sets `clockRef.current = clock` and returns an
  unregister that restores `wallClock`. **On both register and unregister, if
  playback is in progress, re-anchor** so the cursor continues smoothly across a
  clock swap (the new clock has a different origin):
  ```ts
  function reanchor(clock: TransportClock) {
    anchorRef.current = {
      startClockSec: clock.now(),
      startBeat: cursorBeatRef.current,
      startScoreSec: beatToSeconds(scoreRef.current, cursorBeatRef.current),
    };
  }
  ```
  (Add a `cursorBeatRef` mirror of `cursorBeat`, like `scoreRef`, so the stable
  callback reads the live cursor without re-anchoring on every cursor change.)
- Rework the rAF `tick` to read the **clock** instead of `performance.now()`:
  ```ts
  const anchor = anchorRef.current;
  const elapsedSeconds =
    clockRef.current.now() - anchor.startClockSec + anchor.startScoreSec;
  ```
  Keep the existing monotone `beatToSeconds` inversion (the `STEP`-walk) — only
  the *time source* changes. rAF stays as the **render cadence** (correct use:
  schedule a repaint per frame); it no longer supplies the *time value*.
- In the play effect, set the anchor via the same `reanchor(clockRef.current)`
  helper instead of `performance.now()`/`startBeat` inline, so play and
  clock-swap share one anchoring path.

Add `registerClock` to `SonataContextValue` and the `value` memo.

### 2. Engine: register the AudioContext clock

`plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/components/audio-panel.tsx`

- In the existing **mount effect** that creates the `AudioContext` (the `[]`
  effect), register the clock immediately after the ctx exists and unregister in
  its cleanup:
  ```ts
  const unregister = registerClock({ now: () => ctx.currentTime });
  // ...cleanup:
  unregister();
  ```
  Registering at mount (not at play) keeps the clock stable for the whole
  session and sidesteps any ordering race with the play effect. `ctx.currentTime`
  is frozen while suspended and only advances after `ctx.resume()` (called on
  play) — which is exactly when the cursor starts reading it, so the cursor and
  audio anchor at the same `currentTime` value and advance together.
- Pull `registerClock` from `useSonata()`. It is a stable callback, so listing it
  in the mount effect's deps keeps the effect single-run.

No change to `scheduler.ts` — it already anchors at `ctx.currentTime` and maps
through `beatToSeconds`; once the cursor reads the *same* `ctx.currentTime`, the
two are locked by construction.

### Why this is the clean design

- **One clock, one tempo map.** Audio and cursor now derive position from the
  identical `(ctx.currentTime, beatToSeconds)` pair. Drift is eliminated
  structurally, not tuned away.
- **Boundary-respecting inversion.** The shell owns the transport and exposes a
  generic `registerClock` primitive; the engine (clock authority) pushes into it.
  The shell never names or imports the engine — consistent with the
  collection-consumer separation rule. If audio is absent, the wall-clock default
  drives silent playback exactly as today.
- **Background tab is correct by construction.** While backgrounded, rAF pauses
  (no repaints needed — nobody's looking) but `ctx.currentTime` keeps advancing.
  On return, the first frame reads the live audio clock and places the cursor at
  the genuinely-correct position, matching the sound.

## Files to modify

- `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx` — pluggable clock,
  `registerClock`, anchor-on-clock-source, rAF reads `clockRef.current.now()`.
- `plugins/apps/plugins/sonata/plugins/shell/web/index.ts` — export `TransportClock`.
- `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/components/audio-panel.tsx`
  — register `{ now: () => ctx.currentTime }` at ctx creation.

## Verification

1. `./equin build` from the worktree; open `http://<worktree>.localhost:9000/sonata`.
2. Load a source (e.g. the MIDI source) and press play; confirm falling notes hit
   the keyboard exactly as the sound plays.
3. **Long-piece drift:** let a multi-minute piece play and watch the cursor vs.
   the audio near the end — they should remain aligned (previously drifted).
4. **Background snap:** during playback, switch to another tab for ~20–30s, then
   return. The cursor should jump straight to the position that matches the sound
   currently playing, with no audible/visible desync after the jump.
5. Scrub/seek while stopped and resume — playback re-anchors from the new cursor
   and stays locked (the `reanchor` path on play).
6. Sanity: with the audio panel mounted, the cursor advances on the audio clock;
   removing/avoiding audio still advances the cursor via the wall-clock fallback.

A scripted Playwright run (`e2e/screenshot.mjs`) can capture before/after cursor
positions, but the drift/visibility behavior is best confirmed by watching a real
play-through.
