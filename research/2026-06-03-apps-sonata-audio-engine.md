# Sonata Audio Engine — sounding the Score during playback

> Phase-2 follow-up to [`2026-06-02-apps-sonata-pipeline-architecture.md`](./2026-06-02-apps-sonata-pipeline-architecture.md)
> (§ Shared state & playback). That doc scoped `audio/engine` + `Sonata.Instrument`
> as "carried over, polished later" and never built them. This builds them.

## Context

Sonata renders a piano roll and advances a playback cursor, but **produces no
sound**. The `Sonata.Instrument` slot exists only as a placeholder
(`synth: SynthSpec = Record<string, unknown>` in
`plugins/apps/plugins/sonata/plugins/shell/web/slots.ts:23,81`) with **no
consumer and no contributors**. There is zero audio code in the tree —
`@tonejs/midi` is used purely as a MIDI *parser*, never for synthesis.

A Synthesia-like app must **sound the notes of the loaded `Score` as the
transport advances**, with at least one playable instrument. We will:

1. Turn `Sonata.Instrument` into a real contract (a voice manager bound to a
   Web Audio `AudioContext`).
2. Ship one instrument: a **sampled acoustic piano** (via the `smplr` library's
   `SplendidGrandPiano`).
3. Add an **audio engine** that, on play, schedules every upcoming note against
   the Web Audio clock so it sounds in sync with the visual cursor.

Decisions confirmed with the user: **sampled acoustic piano** (not a synth);
**only the piano instrument for now** (the picker is built to take more later).

## Key design decision: schedule-upfront against the Web Audio clock

The textbook Web Audio playback pattern is a *lookahead scheduler* driven by
`setInterval` — but the project **forbids polling/`setInterval` loops**
(CLAUDE.md "No polling"). The clean, compliant alternative is to **schedule all
upcoming notes up front against `AudioContext.currentTime`** and let Web Audio's
own internal scheduler fire them sample-accurately. No JS timer, no second
running loop.

The existing visual transport (`shell/web/context.tsx`) keeps owning
`cursorBeat` via its `requestAnimationFrame` loop (unchanged). On each
`isPlaying → true` transition the engine captures one shared anchor —
`audioAnchor = ctx.currentTime` and `fromBeat = cursorBeat` at that instant —
and maps every note's beat-onset to an absolute audio time:

```
when     = audioAnchor + beatToSeconds(score, note.start)            - beatToSeconds(score, fromBeat)
duration = beatToSeconds(score, note.start + note.duration) - beatToSeconds(score, note.start)
```

Because the visual rAF loop and the audio schedule both anchor at the **same
play instant** and both derive time from `beatToSeconds()` (which already
integrates the tempo map — `score/core/helpers.ts`), cursor and sound stay in
sync, including through tempo changes. Re-anchoring happens on every play, so
seek-then-play composes for free. This mirrors the transport's own
"anchor only on play/stop, read `cursorBeat` via a ref" pattern, so the engine
effect depends on `[isPlaying, score, activeInstrumentId, voices]` — **never on
`cursorBeat`** (read via a ref).

Trade-off / known limitation: a very large MIDI file schedules all its notes at
once. Fine for an MVP; the scale path (an rAF-based windowed scheduler, still
timer-free) is noted but not built.

## The `Sonata.Instrument` contract

Replace the `SynthSpec` placeholder in
`plugins/apps/plugins/sonata/plugins/shell/web/slots.ts` with a real contract,
exported from the shell barrel (the slot owner — keeps the contract where the
slot lives, no new cross-plugin edges, `AudioContext`/`AudioNode` are DOM
globals so `score/core` stays a pure music IR and is untouched):

```ts
/** One note to sound, timed against the AudioContext clock (absolute seconds). */
export interface ScheduledNote {
  pitch: number;     // MIDI 0-127
  velocity: number;  // MIDI 0-127
  when: number;      // absolute AudioContext.currentTime-based start
  duration: number;  // seconds
}

/** A live, audio-context-bound voice manager produced by an Instrument. */
export interface InstrumentVoices {
  loaded: Promise<void>;          // resolves when samples are ready to sound
  schedule(note: ScheduledNote): void;
  allOff(): void;                 // cancel everything scheduled/sounding (stop/seek)
  dispose(): void;                // release audio resources
}

Instrument: defineSlot<{
  id: string;
  label: string;
  icon?: IconType;
  /** Create a voice manager bound to `ctx`, routed into `destination`. */
  createVoices: (ctx: AudioContext, destination: AudioNode) => InstrumentVoices;
}>("sonata.instrument", { docLabel: (p) => p.label }),
```

Export `InstrumentVoices` + `ScheduledNote` from `shell/web/index.ts`. Remove
`SynthSpec` (only referenced in `slots.ts`). The slot stays a `defineSlot` read
generically via `useContributions()` — collection-consumer clean; the engine
never names the piano.

## Plugin tree (new, under a new `audio` umbrella)

```
plugins/apps/plugins/sonata/plugins/audio/         # umbrella (2+ children)
  package.json, CLAUDE.md
  plugins/
    engine/                                         # the scheduler + audio panel
      package.json, CLAUDE.md
      web/
        index.ts                                    # contributes Sonata.Section (area "player")
        components/audio-panel.tsx                  # instrument picker + volume + load status; hosts the scheduling effect
        scheduler.ts                                # pure: (score, fromBeat, audioAnchor, voices) -> schedule() calls
    piano/                                          # the one instrument
      package.json, CLAUDE.md
      web/
        index.ts                                    # contributes Sonata.Instrument({ id:"piano", label:"Acoustic Piano", createVoices })
        voices.ts                                   # wraps smplr SplendidGrandPiano into InstrumentVoices
```

Only one instrument today, so `piano` is a direct child of `audio` (no
`instruments/` umbrella yet — add it when a 2nd instrument lands). New web
plugins are auto-discovered by `./equin build` codegen; `dependsOn` the
shell. Both depend only on legal barrels (shell `web`, score `core`).

## The audio engine (`audio/engine`)

A single cohesive "Audio" panel contributed as a `Sonata.Section`
(`area: "player"`) — the same mounting path `chord-readout` already uses, so the
shell needs **no mount point**. It is always mounted while `/sonata` is open, so
its effect is always live. It renders the instrument picker + a master-volume
slider + a sample-load status line, and hosts the scheduling effect.

`components/audio-panel.tsx`:

- `const { score, isPlaying } = useSonata();` and a `cursorBeatRef` kept current
  each render (so the effect reads the latest cursor without depending on it).
- `const instruments = Sonata.Instrument.useContributions();` +
  `activeInstrumentId` local state (defaults to the first contribution — piano).
- **AudioContext + master gain**, owned in refs, created lazily/eagerly on mount
  (suspended until a gesture). One `pointerdown`-once listener calls
  `ctx.resume()` to satisfy the browser autoplay gate (the play button is a
  gesture; the listener is belt-and-suspenders). Master `GainNode.gain.value`
  driven by a volume slider (local state). Closed on unmount (StrictMode-guarded).
- **Voices**: when `ctx` + `activeInstrumentId` are ready, call the active
  instrument's `createVoices(ctx, masterGain)`, store in a ref, eagerly trigger
  sample loading (`voices.loaded`), and show "Loading piano…/Ready". Dispose the
  previous voices on instrument change / unmount.
- **Scheduling effect**, deps `[isPlaying, score, activeInstrumentId, voices]`:
  - `!isPlaying` → `voices.allOff()`; return.
  - `isPlaying` → `ctx.resume()`; capture `audioAnchor = ctx.currentTime` and
    `fromBeat = cursorBeatRef.current` **synchronously**; then in an async IIFE
    (with a `cancelled` flag set by cleanup) `await voices.loaded` and call
    `scheduleNotes(...)`. Notes whose computed `when` is already in the past
    (only possible if samples were still loading on first play) are clamped to
    `ctx.currentTime` / skipped — self-correcting, bounded by load time, never
    on subsequent plays.
  - cleanup → set `cancelled`, `voices.allOff()`.

`scheduler.ts` (pure, testable):

```ts
export function scheduleNotes(
  score: Score, fromBeat: number, audioAnchor: number, voices: InstrumentVoices,
): void {
  const t0 = beatToSeconds(score, fromBeat);
  for (const n of score.notes) {
    if (n.start + n.duration <= fromBeat) continue;           // fully in the past
    const startSec = beatToSeconds(score, n.start);
    const when = audioAnchor + startSec - t0;
    const duration = beatToSeconds(score, n.start + n.duration) - startSec;
    voices.schedule({ pitch: n.pitch, velocity: n.velocity, when, duration });
  }
}
```

Reuses `beatToSeconds` from
`@plugins/apps/plugins/sonata/plugins/score/core` — no time math re-implemented.

## The piano instrument (`audio/piano`)

`web/voices.ts` wraps `smplr`'s `SplendidGrandPiano` (high-quality sampled
grand) into `InstrumentVoices`:

- `const piano = new SplendidGrandPiano(ctx, { ...route output into destination })`
  — via the constructor `destination` option, or connect `piano.output` to the
  passed `destination` (master gain). (Verify exact `smplr` option name at impl.)
- `loaded` → `piano.loaded()` (Promise resolving when samples are downloaded).
- `schedule({pitch, velocity, when, duration})` →
  `piano.start({ note: pitch, velocity, time: when, duration })` (smplr accepts
  a MIDI number for `note`; `time`/`duration` are AudioContext seconds).
- `allOff()` → `piano.stop()` (stops all sounding/scheduled notes).
- `dispose()` → `piano.stop()` + disconnect.

`web/index.ts` contributes
`Sonata.Instrument({ id: "piano", label: "Acoustic Piano", icon: MdPiano, createVoices })`.

Add `smplr` (latest, ~`^0.16`) to `audio/piano/package.json`; `bun install` at
repo root. **Caveat:** `SplendidGrandPiano` streams its samples from `smplr`'s
default remote storage (CDN) — needs network at runtime; offline the piano won't
sound. Acceptable per the user's choice; self-hosting samples is a future
follow-up.

## Files

**Modify**
- `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts` — replace `SynthSpec`
  placeholder with `ScheduledNote` + `InstrumentVoices`; update `Sonata.Instrument`
  payload to `{ id, label, icon?, createVoices }`.
- `plugins/apps/plugins/sonata/plugins/shell/web/index.ts` — export
  `InstrumentVoices`, `ScheduledNote`.

**Create** (+ `package.json` + `CLAUDE.md` per plugin, following sibling plugins)
- `plugins/apps/plugins/sonata/plugins/audio/{package.json,CLAUDE.md}` (umbrella)
- `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/{index.ts,components/audio-panel.tsx,scheduler.ts}`
- `plugins/apps/plugins/sonata/plugins/audio/plugins/piano/web/{index.ts,voices.ts}`

**No change** to `score/core` (stays a pure music IR) or `shell/web/context.tsx`
(the visual transport is reused as-is via `useSonata()`).

## Boundary check (must hold)

- `audio/engine` imports `useSonata` + `Sonata` from the shell barrel and
  `beatToSeconds`/`Score` from `score/core` — both legal barrels.
- `audio/piano` imports `Sonata` + `InstrumentVoices`/`ScheduledNote` from the
  shell barrel; `smplr` is external. No cross-plugin re-exports.
- Instrument contract lives with its slot (shell), not in `score/core` — keeps
  the import graph a DAG and the music IR audio-free.
- Engine reads instruments only via `useContributions()` generic fields — never
  names the piano (collection-consumer clean).
- Run `./equin check --plugin-boundaries`.

## Verification (end-to-end)

1. `./equin build` — new `audio/engine` + `audio/piano` plugins discovered
   and compiled; `./equin check --plugin-boundaries` passes.
2. Open `http://<worktree>.localhost:9000/sonata`. The right "Audio" panel shows
   the instrument picker (Acoustic Piano) + volume + "Ready" once samples load.
3. Drop a `.mid` file → piano roll renders notes.
4. Press **Play** → **the piano sounds the notes** in time with the advancing
   cursor; press **Stop** → sound stops immediately (`allOff`).
5. Use a file **with a tempo change** → audio stays locked to the visual cursor
   through the tempo change (validates the shared `beatToSeconds` anchor).
6. Move the **volume slider** → loudness changes live (master gain).
7. Seek (scrub the cursor) while paused, then Play → audio starts from the new
   position (re-anchoring composes with seek).
8. Scripted check via `bun e2e/screenshot.mjs` (or Playwright) to click Play and
   confirm the panel state; audio itself is confirmed manually by the user.
```
