# Sonata: subscription/ref-based cursor read path (kill per-frame re-renders)

## Context

During playback the transport's `requestAnimationFrame` loop in `SonataProvider`
calls `setCursorBeat(beat)` ~60×/sec. `cursorBeat` is plain `useState` **inside
the `SonataContextValue` `useMemo` deps**
(`shell/web/context.tsx:248,661,696`), so every frame mints a new context object
and **every `useSonata()` consumer re-renders** — `useSonata()` is plain
`useContext` with no selector (`context.tsx:220`).

That's wasteful three ways:

1. **Imperative-only consumers** forward the cursor to an imperative handle and
   need no React render at all: the GPU piano roll pushes it to the Pixi scene
   via `scene.setScroll()` (`piano-roll/web/internal/pixi/app.tsx:150`); the
   audio engine only mirrors it into a ref read at schedule time
   (`audio/.../audio-engine.tsx:80,233`).
2. **Frame-invariant consumers** reconcile every frame to produce output that
   changes only at region boundaries — the current-key HUD chip, key/chord
   readouts, and the live-BPM label (`rich/.../key-chip.tsx`,
   `key-readout.tsx`, `chord-readout.tsx`, `transport-bar/.../playback-controls.tsx`).
3. **Non-readers** (`record-play-observer.tsx`, `track-mixer/web/hooks.ts`) and
   the dispatch site (`library/web/panes.tsx` `SonataPlayerSurface`) re-render
   purely because the context identity churned — the dispatch site re-renders
   every frame just to re-pass `cursorBeat` as a prop into the whole piano-roll
   subtree.

This was logged as a follow-up in
`research/2026-06-12-plugins-sonata-pixi-piano-roll.md` ("Ref-based
`subscribeCursor` on `SonataContextValue` so displays can consume the cursor
without per-frame React renders").

**Outcome:** the cursor leaves React context entirely and lives in a module-level
store with a subscription + imperative read. Imperative consumers subscribe and
update handles directly (zero renders); frame-invariant consumers opt into a
derived-with-bailout hook (render only when their value changes); non-readers
stop re-rendering for free because the context value is now stable during
playback.

## Design

### 1. The cursor store (new) — `shell/web/cursor-store.ts`

A module-level store mirroring the existing `audio-store.ts` /
`transport-store.ts` precedent (single Sonata instance per app, same as those):

```ts
let cursorBeat = 0;
const listeners = new Set<() => void>();

export function getCursorBeat(): number { return cursorBeat; }

/** Writer — only the provider calls this (rAF loop, seek, scrub, resets). */
export function setCursorBeat(beat: number): void {
  if (beat === cursorBeat) return;        // identity stability for getSnapshot
  cursorBeat = beat;
  for (const l of listeners) l();
}

/** Raw subscription — for useSyncExternalStore AND imperative consumers. */
export function subscribeCursor(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Reactive raw read — re-renders the caller every time the beat changes. */
export function useCursorBeat(): number {
  return useSyncExternalStore(subscribeCursor, getCursorBeat);
}

/**
 * Derived read with bailout: re-renders ONLY when `selector(beat)` changes.
 * `deps` invalidate the cache when the selector closes over new data (score,
 * tempoScale, …) — same contract as useMemo's deps. `isEqual` (default
 * Object.is) decides frame-to-frame equality, so a value/ref that's stable
 * within a region (a KeySignature from a memoized list, a constant BPM number)
 * bails and the component never reconciles mid-region.
 */
export function useCursorSelector<T>(
  selector: (beat: number) => T,
  deps: DependencyList,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T;
```

`useCursorSelector` is a hand-rolled `useSyncExternalStoreWithSelector`: cache
`{ beat, value }` in a ref; on each `getSnapshot`, return the cached value when
the beat is unchanged, else recompute and — when `isEqual(prev, next)` — keep the
**previous reference** so `useSyncExternalStore` bails. Reset the cache when
`deps` shallow-change (selector now closes over new data, so the same beat can
map to a new value). This keeps it correct across score/tempo changes while
delivering the per-frame bailout.

Export all five from the shell web barrel (`shell/web/index.ts`), next to the
existing `getSonataTransport`/`publishSonataTransport` re-exports.

### 2. Provider — `shell/web/context.tsx`

- **Drop** the `useState` `cursorBeat`/`setCursorBeat` (`:248`) and the
  `cursorBeatRef` mirror (`:358`). The store is the single source of truth.
- The rAF tick writes `cursorStore.setCursorBeat(beat)` instead of the setter
  (`:602,606`); end-of-song still `setCursorBeat(endBeat); setIsPlaying(false)`.
- Internal reads of `cursorBeatRef.current` (`seekBy:439`, `seekBar:450`,
  scrub loop `:513`, `registerClock:380,384`, the freeze/tempo re-anchor effects
  `:563,583`) become `getCursorBeat()`. Writes (`seekTo:427`, scrub `:520-522`,
  the score-change reset `:331`) become `setCursorBeat(...)`.
- **Remove `cursorBeat` from `SonataContextValue`** (the field at `:107`, the
  value entry `:661`, and the dep at `:696`). The stable writer verbs
  (`setCursorBeat`, `seekTo`, `seekBy`, `seekBar`, `startScrub`, `endScrub`)
  stay on the context — only the per-frame *value* leaves. During playback the
  context object is now identity-stable.
- Keep `setCursorBeat` exposed on the context (it's a stable callback that now
  delegates to the store) so existing external callers are unaffected.

### 3. Display dispatch contract — `shell/web/slots.ts` + `library/web/panes.tsx`

- Remove `cursorBeat` from the `Sonata.Display` dispatch props
  (`slots.ts:68-83`). Displays now read the cursor themselves via the store.
- `SonataPlayerSurface` (`panes.tsx:103-213`): drop `cursorBeat` from the
  `useSonata()` destructure and from the `<Sonata.Display.Dispatch>` props
  (`:109,207`). This is the single biggest win — the dispatch site no longer
  re-renders per frame.

### 4. Consumer migration

| Consumer | File | New read path |
|---|---|---|
| **Piano roll (Pixi + DOM ScrollLayer)** | `piano-roll/web/components/piano-roll.tsx` | **Imperative** — one `subscribeCursor` effect drives both targets via refs (below) |
| Pixi bridge | `piano-roll/web/internal/pixi/app.tsx` | Drop `scrollSec`/`cursorBeat` props + their layout effect (`:40-44,150-153`); parent owns `setScroll` |
| Audio engine | `audio/.../audio-engine.tsx` | Drop `cursorBeat` from `useSonata()` + the `cursorBeatRef` mirror (`:50,80-81`); read `getCursorBeat()` at schedule time (`:233`) |
| Progress bar | `progress/.../progress-bar.tsx` | `useCursorBeat()` (fill %, ARIA, time readout genuinely change per frame) |
| Piano keyboard | `piano-keyboard/.../piano-keyboard.tsx` | `useCursorBeat()` (sounding-keys map genuinely changes per frame) |
| Key chip (HUD) | `rich/.../key-chip.tsx` | `useCursorSelector(b => …, [entries])` |
| Key readout | `rich/.../key-readout.tsx` | `useCursorSelector(b => effectiveKeyAt(score,b)…, [score], byKeyValue)` — pass value-equality isEqual if `effectiveKeyAt` returns a fresh object |
| Chord readout | `rich/.../chord-readout.tsx` | `useCursorSelector(b => chords.find(…), [chords])` (Annotation ref stable within span → Object.is bails) |
| BPM label | `transport-bar/.../playback-controls.tsx` | `useCursorSelector(b => …bpmAtBeat…, [hasScore,tempoScale,score])` (number → Object.is bails on constant tempo) |

Non-readers (`record-play-observer.tsx`, `track-mixer/web/hooks.ts`) need **no
change** — they stop re-rendering once the context value is stable.

### 5. The imperative piano-roll path (the delicate part)

`PianoRollInner` (`piano-roll.tsx:124`) currently receives `cursorBeat` as a prop
and re-renders every frame, relying on `useMemo`'d `content` to bail the subtree.
After the change it no longer reads the cursor reactively, so it renders only on
real input changes (score, lane size, tempo, track view). One effect bridges the
cursor imperatively:

- Mirror the reactive inputs the per-frame formula needs into refs (the file
  already does this for FX: `projectionRef`, `laneSizeRef`): `sceneRef`
  (`pixi.scene`), `tempoRef`, `tempoScaleRef`, `laneHeightRef`, plus a
  `scrollLayerRef` on the ScrollLayer div.
- A stable `applyCursor(beat)` reads those refs and (a) calls
  `scene.setScroll(authoredSecondsOf(tempo, ts, beat), beat)`; (b) sets
  `scrollLayerRef.current.style.transform = translateY(laneHeight +
  tempo.beatToSeconds(beat) * PX_PER_SECOND * ts)` — the exact existing formulas
  (`app.tsx` setScroll + `ScrollLayer:112`), now applied imperatively so canvas
  and DOM overlays stay glued in the same tick.
- `useEffect(() => subscribeCursor(() => applyCursor(getCursorBeat())), [applyCursor])`
  drives it per frame with **no React render**.
- A `useLayoutEffect` re-runs `applyCursor(getCursorBeat())` on `[pixi, lane.height,
  tempo, tempoScale]` so a resize / tempo change / scene-ready re-syncs the view
  immediately (covers the paused state, where no cursor tick fires).
- `ScrollLayer` becomes a plain `forwardRef` div (drop its `cursorBeat`/`tempo`
  props and the inline offset). The `seekEpoch → scene.reset()` effect stays in
  the canvas (`app.tsx:145-148`); the drag `origin` callback (`piano-roll.tsx:178`)
  becomes `() => tempo.beatToSeconds(getCursorBeat())`.

Result: during playback the entire piano-roll display performs **zero React
renders** — one `scene.setScroll` + one `style.transform` write per frame.

## Files to modify

- `plugins/apps/plugins/sonata/plugins/shell/web/cursor-store.ts` — **new** store + hooks
- `plugins/apps/plugins/sonata/plugins/shell/web/index.ts` — re-export the store API
- `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx` — store-backed transport; remove `cursorBeat` from context
- `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts` — drop `cursorBeat` from `Sonata.Display` props
- `plugins/apps/plugins/sonata/plugins/library/web/panes.tsx` — drop `cursorBeat` from dispatch
- `plugins/apps/plugins/sonata/plugins/piano-roll/web/components/piano-roll.tsx` — imperative subscription path; ScrollLayer → forwardRef
- `plugins/apps/plugins/sonata/plugins/piano-roll/web/internal/pixi/app.tsx` — drop per-frame props
- `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/components/audio-engine.tsx` — `getCursorBeat()` at schedule time
- `plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web/components/progress-bar.tsx` — `useCursorBeat()`
- `plugins/apps/plugins/sonata/plugins/piano-keyboard/web/components/piano-keyboard.tsx` — `useCursorBeat()`
- `plugins/apps/plugins/sonata/plugins/rich/plugins/{key-chip,key-readout,chord-readout}/web/components/*.tsx` — `useCursorSelector`
- `plugins/apps/plugins/sonata/plugins/transport-bar/web/components/playback-controls.tsx` — `useCursorSelector`

Reuse: `useSyncExternalStore` (audio-store pattern), `authoredSecondsOf`/
`PX_PER_SECOND` (`piano-roll/web/components/geometry.ts`), the existing
ref-mirroring idiom in `piano-roll.tsx` (FX `projectionRef`/`laneSizeRef`).

## Edge cases & risks

- **`getSnapshot` stability** — `setCursorBeat` early-returns on an unchanged
  beat, and `useCursorSelector` caches by beat, so React's tearing checks never
  see a fresh value when the store hasn't moved (no `useSyncExternalStore` loop).
- **Selector returning fresh objects** (`effectiveKeyAt` in key-readout) — would
  defeat Object.is bailout; pass a value-equality `isEqual` (compare tonic+mode)
  or select a primitive key. Verify `effectiveKeyAt`'s return identity when
  implementing.
- **Store lifecycle** — reset to `0` on score change (already happens via the
  provider's `baseScore` effect → now `setCursorBeat(0)`). The module singleton
  matches `audio-store`/`transport-store`; no multi-instance concern (one Sonata
  app mount).
- **Seek/scrub ordering** — `seekTo` writes the store then bumps `seekEpoch`;
  the audio engine's `seekEpoch` effect reads `getCursorBeat()` after commit, so
  it sees the new cursor. Confirm by ear (seek while playing stays glued).
- **Boundary rules** — the store lives in the shell barrel and is imported via
  `@plugins/apps/plugins/sonata/plugins/shell/web` like `useSonata`; no new
  cross-plugin edges (`./equin check plugin-boundaries`).
- **No-floating-promises / rAF** — unchanged; the subscription returns its
  unsubscribe from the effect.

## Verification

1. `./equin check type-check` + `plugin-boundaries` (Display dispatch
   prop-type change must propagate to the one display + `NoDisplay` fallback).
2. `bun test plugins/apps/plugins/sonata/plugins/piano-roll` (geometry/onset
   unaffected; add a `cursor-store.test.ts` covering `setCursorBeat` dedup,
   subscribe/unsubscribe, and `useCursorSelector` bailout via a fake store).
3. `./equin build` → `http://<worktree>.localhost:9000/sonata`. Open a
   dense library song, **Play**, and via React DevTools Profiler (or a temporary
   `clientLog` render counter) confirm during playback: `SonataPlayerSurface`,
   `PianoRollInner`, `AudioEngine`, `KeyChip`, `KeyReadout`, `ChordReadout`, and
   the BPM label render **0×/sec**; `ProgressBar` + `PianoKeyboard` render
   per-frame (expected — output changes); the playhead, falling notes, lit keys,
   progress fill, and chord/key panels still track correctly.
4. Functional regressions: drag-to-scrub on the roll, scrubber click/drag,
   ←/→ tap + press-and-hold, tempo change mid-play, seek while playing (audio
   stays glued), score reset on source change. Headed Chrome for the WebGPU path
   (headless rasterizes on CPU — see the prior plan's measurement caveat).

## Follow-ups (out of scope)

- Make `PianoKeyboard` light keys imperatively (ref per key) so it too renders
  0×/sec — larger change to the shared keyboard primitive.
- Promote the cursor store to a generic "animated scalar" primitive if a second
  app needs the same per-frame-scalar pattern.
