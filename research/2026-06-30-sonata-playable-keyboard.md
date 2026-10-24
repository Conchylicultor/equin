# Sonata — make the on-screen piano keyboard playable

## Problem

The 88-key piano keyboard (`PianoKeyboard`, a `Sonata.PitchAxis` decorator drawn
below the piano-roll) is purely a visual pitch axis. Its keys are plain `<div>`s
with no pointer/touch handlers, so the user cannot click/tap/drag them to make
sound. There is no way to hand-play notes or use Sonata as an actual instrument.

The audio engine and the keyboard's pitch projection already exist; we only need
to (1) add a live note-on/note-off path to the audio layer, and (2) make the
keyboard primitive emit press/release events wired to it.

## Existing pieces (verified)

- **`InstrumentVoices`** (`shell/web/slots.ts`) — the only note-trigger API:
  `schedule({pitch,velocity,when,duration})`, `allOff()`, `dispose()`. **No**
  per-note note-on/note-off. Both instruments wrap smplr (`SplendidGrandPiano`,
  `Soundfont`).
- **smplr** `inst.start({note, velocity})` (no `duration`) **returns a stopper
  fn** that releases that one note (verified against smplr README). So live
  note-on/note-off is a trivial wrapper.
- **Audio engine** (`audio/engine`) — headless always-mounted `Sonata.Effect`
  owning the one `AudioContext` + master `GainNode`. Publishes the live graph
  (`{ctx}`) to a **per-surface** `audio-store` (scoped-store, provided via
  `Sonata.SurfaceProvider`). The metronome reuses the published `ctx`.
- **Default instrument** = the `Sonata.Instrument` with `default: true` →
  Acoustic Piano (the sampled grand). Resolved generically via
  `Sonata.Instrument.useContributions()` — never named.
- **Keyboard primitive** (`primitives/keyboard`) — stateless; renders each key as
  an absolutely-positioned `<div>` carrying `k.pitch`. Reused by the full roll
  keyboard, the chord readout, and the key readout (so playability must be
  **opt-in**, not always-on). Root is `<Clip>` which spreads `...rest` (so it
  forwards `onPointerDown`/`style`/etc.).
- **Playback key highlight** — `PianoKeyboard` builds a `sounding` pitch→color
  `Map` via `useCursorSelector` and passes it as `lit`. The primitive already
  renders a lit key with a pressed depression (`translateY(1px)`) + tint/fill.

## Design

Four coordinated changes. Net new plugin edges form a DAG (no cycles):
`audio/live-play → {shell, audio/engine}`, `piano-keyboard → audio/live-play`.

### 1. `InstrumentVoices.play` — optional live note-on (shell + both instruments)

Add to the interface in `shell/web/slots.ts`:

```ts
export interface InstrumentVoices {
  loaded: Promise<void>;
  schedule(note: ScheduledNote): void;
  allOff(): void;
  dispose(): void;
  /** Live, interactive note-on for hand-played keys: starts a sustaining voice
   *  immediately (no scheduled `when`/`duration`) and returns a note-off fn that
   *  releases it (applying the sample's natural release). Optional — an
   *  instrument that cannot sustain on demand omits it (the keyboard then can't
   *  play through it). Both smplr instruments implement it. */
  play?(pitch: number, velocity: number): () => void;
}
```

Implement in `audio/piano/web/voices.ts` and `audio/soundfont/web/voices.ts`,
mirroring their existing `disposed`-guard idiom:

```ts
play(pitch, velocity) {
  if (disposed) return () => {};
  const stop = piano.start({ note: pitch, velocity }); // no duration → sustains
  return () => { if (!disposed) stop(); };
}
```

(`sf.start` for the soundfont wrapper.)

### 2. Publish the master gain (`audio/engine`)

The live player must route through master so the master-volume slider governs
hand-played notes too. Extend `AudioGraph` in `audio/engine/web/audio-store.ts`:

```ts
export interface AudioGraph { ctx: AudioContext; master: GainNode; }
```

and in `audio-engine.tsx` publish `setGraph({ ctx, master })`. The metronome only
reads `graph.ctx`, so it is unaffected.

### 3. New plugin `audio/live-play` — the live interactive player

`plugins/apps/plugins/sonata/plugins/audio/plugins/live-play/` (sibling of
engine/metronome/piano/soundfont). Keeps live play isolated from the scheduled-
playback engine, while reusing the engine's `ctx` + master and the default
instrument's `createVoices`.

Files:

- **`web/live-store.ts`** — a per-surface scoped store holding the published
  imperative API (mirrors how `audio-store` publishes `graph`):
  ```ts
  export interface LivePlayApi {
    warmup(): void;                                  // create voices + start sample load
    press(pitch: number, velocity?: number): void;   // note-on (default velocity ~90)
    release(pitch: number): void;                     // note-off
    releaseAll(): void;                               // panic / cleanup
  }
  // store state: { api: LivePlayApi | null }
  export const LivePlayStoreProvider = store.Provider;
  export function useLivePlay(): LivePlayApi | null { return store.useStore().api; }
  export function useLivePlayControls() { /* setApi */ }
  ```
- **`web/components/live-play-provider.tsx`** — `{children}=>` `<LivePlayStoreProvider>`,
  contributed via `Sonata.SurfaceProvider` (so the engine effect + the keyboard,
  in different slot branches, share one per-surface store — same pattern as the
  audio provider).
- **`web/components/live-play-engine.tsx`** — headless `Sonata.Effect`,
  always-mounted. It:
  - reads `useAudioGraph()` (`{ctx, master}|null`) and
    `Sonata.Instrument.useContributions()` (picks `i.default ?? first`), both via
    `useLatestRef` so the published API stays a stable identity;
  - keeps refs: `voicesRef: InstrumentVoices|null`, `heldRef: Map<number, ()=>void>`;
  - `ensureVoices()` — lazily `createVoices(ctx, master)` for the default
    instrument when the graph is ready; `void voices.loaded.then(...)` to start
    the sample load; recreated by an effect when `graph.ctx` changes (dispose old);
  - `press(pitch, vel=90)` — `void ctx.resume()`; `ensureVoices()`; if a release
    fn already held for that pitch, call it first (retrigger); `heldRef.set(pitch,
    voices.play?.(pitch, vel) ?? noop)`;
  - `release(pitch)` — call + delete the held release fn;
  - `releaseAll()` — call all + clear;
  - publishes a single stable `api` object via `setApi` on mount; on unmount
    `releaseAll()`, dispose voices, `setApi(null)`.
- **`web/index.ts`** — contributes `Sonata.SurfaceProvider(LivePlayProvider)` +
  `Sonata.Effect("live-play", LivePlayEngine)`; exports `useLivePlay`, `LivePlayApi`.

Velocity from pointer position is deferred (follow-up); v1 uses a constant.

### 4. Opt-in playability in the keyboard primitive + wire it in `PianoKeyboard`

**Primitive (`primitives/keyboard/web/internal/keyboard.tsx`)** — add an optional
prop:

```ts
interaction?: {
  onPress(pitch: number): void;
  onRelease(pitch: number): void;
};
```

When present:
- add `data-pitch={k.pitch}` to each key `<div>`; mark the felt `<Pin>` and the
  black-face div `pointer-events-none` (the face already is) so hit-tests land on
  keys; keep labels `select-none`;
- on the `<Clip>` root set `style={{ touchAction: "none", cursor: "pointer" }}`
  (merged with the existing `borderRadius`) and `select-none`, plus pointer
  handlers from a self-contained internal hook `usePlayableKeyboard(interaction)`:
  - `onPointerDown` — `e.currentTarget.setPointerCapture(e.pointerId)`; hit-test
    the pitch under the pointer; `onPress`; track `Map<pointerId, pitch>`;
  - `onPointerMove` — for an active pointer, re-hit-test via
    `document.elementFromPoint(clientX, clientY)?.closest("[data-pitch]")`
    (correctly returns the topmost = black key, and supports glissando across
    keys); if the pitch changed: `onRelease(old)` + `onPress(new)`; if slid off
    all keys: `onRelease(old)` and clear that pointer's pitch;
  - `onPointerUp` / `onPointerCancel` / `lostpointercapture` — `onRelease` the
    pointer's note and delete it.
  Multi-touch falls out naturally (per-`pointerId` tracking). The hit-test reads
  `data-pitch` so black-over-white stacking is correct for free.

The primitive stays **presentational** for lit state — it does not store which
keys are pressed; the consumer merges held pitches into `lit`.

**Consumer (`piano-keyboard/web/components/piano-keyboard.tsx`)**:
- `const live = useLivePlay();` (null-safe — keyboard simply stays non-playable
  if absent); call `live?.warmup()` on mount (and `live?.releaseAll()` on unmount);
- own `const [held, setHeld] = useState<ReadonlySet<number>>(EMPTY)`;
- `interaction = live ? { onPress: p => { live.press(p); setHeld(add); },
  onRelease: p => { live.release(p); setHeld(remove); } } : undefined`;
- merge held into the `sounding` map for `lit`: held pitches light in the accent
  (empty-string color) unless already sounding (keep the playback color). Pass the
  merged map + `interaction` to `<Keyboard>`.

This reuses the existing lit→pressed-depression styling, so a hand-pressed key
depresses and glows exactly like a played note.

## Why this shape

- **Reuses** the one `AudioContext` + master gain (no second context), the
  `InstrumentVoices` contract, the default-instrument resolution, the scoped-store
  per-surface pattern, and the existing lit/press visuals.
- **Modular**: live play is its own plugin, isolated from the scheduled-playback
  engine; the keyboard primitive gains a clean opt-in interaction surface reusable
  by any future playable keyboard.
- **Collection-clean**: the live player picks the default instrument generically
  (`useContributions` + `default`), never naming the piano plugin.
- **Multi-surface safe**: per-surface store ⇒ two Sonata windows play
  independently.

## Out of scope (follow-up tasks to file)

1. **Standalone "free play" keyboard** on the Sonata landing (play with no song
   loaded) — the keyboard currently renders only inside the player (pitch-plane
   display). This is a separate surface/feature.
2. **Velocity from vertical pointer position** on the key (expressive dynamics).
3. **Computer-keyboard (QWERTY) mapping** to play notes for desktop users.

## Verification

`./equin build`, then a scripted Playwright run on a loaded song:
pointer-down a key → assert audio path invoked + key shows lit/pressed; drag
across keys (glissando); multi-touch; release. Screenshot before/after.
