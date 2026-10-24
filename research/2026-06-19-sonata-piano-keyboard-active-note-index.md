# PianoKeyboard active-note index + bailout re-render

## Context

`PianoKeyboard` (`plugins/apps/plugins/sonata/plugins/piano-keyboard/web/components/piano-keyboard.tsx`)
computes which pitches are sounding at the playback cursor by **linearly scanning
every note in `score.notes`** inside a `useMemo` keyed on `cursorBeat`:

```ts
const sounding = useMemo(() => {
  const m = new Map<number, string>();
  for (const n of score.notes) {
    if (hiddenIds.has(n.track) || mutedIds.has(n.track)) continue;
    if (n.start <= cursorBeat && cursorBeat < n.start + n.duration && !m.has(n.pitch))
      m.set(n.pitch, colorMap.get(n.track) ?? "");
  }
  return m;
}, [score.notes, cursorBeat, colorMap, hiddenIds, mutedIds]);
```

`cursorBeat` comes from `useCursorBeat()`, which re-renders the component on
**every** rAF tick during playback (~60×/s). So this is **O(notes) per frame**.
On a dense 22-track / 17-minute MIDI that is thousands of notes scanned every
frame. Two compounding costs:

1. **The scan itself** is O(total notes) when the answer only depends on the
   handful of notes sounding *right now* (local polyphony).
2. **The re-render fires every frame even when the lit set didn't change.** A
   note sounds for many consecutive frames; the sounding pitch set only changes
   when a note crosses an on/off boundary. Today the component reconciles and
   hands `<Keyboard>` a fresh `Map` identity every single frame regardless.

Currently masked by fast hardware, but it scales with score size. The fix
addresses both costs and introduces a reusable primitive.

## Approach

Two independent, composable changes:

### 1. New primitive: `buildActiveNoteIndex` in `score/core`

Add `plugins/apps/plugins/sonata/plugins/score/core/active-note-index.ts`, a
pure, framework-free interval-stabbing index, mirroring the shape and prose
style of the existing `tempo-index.ts` (`buildTempoIndex` → `TempoIndex` with
allocation-light query methods, precompute-once, thorough doc comment).

```ts
export interface ActiveNoteIndex {
  /** Notes sounding at `beat`: start <= beat < start + duration.
   *  Returned in the original `notes` array order (stable winner per pitch). */
  at(beat: number): Note[];
}
export function buildActiveNoteIndex(
  notes: readonly Note[],
  opts?: { bucketBeats?: number },
): ActiveNoteIndex;
```

**Structure — bucketed-by-beat grid** (default bucket = 1 beat):

- Anchor at `minStart = min(note.start)`; bucket `i` covers
  `[minStart + i*B, minStart + (i+1)*B)`.
- **Membership = overlap, not onset.** Each note is appended to **every** bucket
  its `[start, start+duration)` span touches
  (`lo = floor((start-minStart)/B)`, `hi = floor((end-ε-minStart)/B)`). A note
  longer than one beat therefore lives in all the buckets it spans, so a long
  sustained note that started long ago is still found in the bucket under the
  cursor — multi-beat notes are correct *by construction*, not an edge case.
- Notes are inserted in original array order, so within a bucket they stay in
  `score.notes` order → `at()` preserves the "first eligible note per pitch wins
  the tint" semantics of the current code exactly.
- `at(beat)`: compute `idx = floor((beat-minStart)/B)`; out of range → `[]`;
  else scan `buckets[idx]` and keep notes where `start <= beat < start+duration`.
  Cost is **O(local polyphony)**, not O(total notes).
- Stateless (no sweep cursor), so it composes with the stateless
  `useCursorSelector(beat)` call below and with arbitrary seeks.

Memory ≈ `Σ ceil(durationᵢ / B)` references — dominated by short notes (~1
bucket each); a few sustained/pedal notes add a bounded tail. `bucketBeats` is a
free knob if sustained notes ever dominate (coarser buckets = less duplication,
slightly larger per-bucket scans). Empty `notes` → `at()` always returns `[]`.

Export `buildActiveNoteIndex` + `ActiveNoteIndex` from
`plugins/apps/plugins/sonata/plugins/score/core/index.ts` (alongside the
`buildTempoIndex` / `TempoIndex` export pair).

Reusable future consumers (out of scope here, but the reason this lives in
`score/core` not the keyboard): chord-readout's "current notes", any other
"what's sounding now" surface.

### 2. Drive the keyboard's lit map via `useCursorSelector` with a value-equality bailout

In `piano-keyboard.tsx`:

- Memoize the index on the notes array:
  ```ts
  const noteIndex = useMemo(() => buildActiveNoteIndex(score.notes), [score.notes]);
  ```
- Replace the per-frame `useMemo([... cursorBeat])` (and drop the
  `useCursorBeat()` call) with `useCursorSelector` from
  `@plugins/apps/plugins/sonata/plugins/shell/web`:
  ```ts
  const sounding = useCursorSelector(
    (beat) => {
      const m = new Map<number, string>();
      for (const n of noteIndex.at(beat)) {
        if (hiddenIds.has(n.track) || mutedIds.has(n.track)) continue;
        if (!m.has(n.pitch)) m.set(n.pitch, colorMap.get(n.track) ?? "");
      }
      return m;
    },
    [noteIndex, colorMap, hiddenIds, mutedIds],
    sameLitMap, // value-equality: re-render only when the lit set changes
  );
  ```
- `sameLitMap(a, b)`: equal `size` and every `(pitch → color)` entry equal.

Why this is the intended tool: `cursor-store.ts` documents `useCursorSelector`
as the path for "consumers whose output changes only at region boundaries," and
explicitly says for selectors that build a fresh object each call (so `Object.is`
never matches) to pass an `isEqual` comparing by value. The selector still runs
every frame, but it is now O(local polyphony); the **re-render** (and the
`<Keyboard>` reconcile) only happens when a pitch actually turns on/off.

Net: per-frame work drops from O(total notes) + unconditional re-render to
O(local polyphony) + re-render only on a real change.

## Critical files

- **new** `plugins/apps/plugins/sonata/plugins/score/core/active-note-index.ts` — the primitive
- **new** `plugins/apps/plugins/sonata/plugins/score/core/active-note-index.test.ts` — bun:test (co-located, mirrors `piano-roll/web/internal/fx/onset-tracker.test.ts`)
- `plugins/apps/plugins/sonata/plugins/score/core/index.ts` — export the new symbols
- `plugins/apps/plugins/sonata/plugins/piano-keyboard/web/components/piano-keyboard.tsx` — swap scan → index + `useCursorSelector`; add `sameLitMap`

Patterns reused: `buildTempoIndex`/`TempoIndex` (`score/core/tempo-index.ts`) for
the index shape; `useCursorSelector` + bailout (`shell/web/cursor-store.ts`);
`createOnsetTracker` test (`onset-tracker.test.ts`) for the test idiom.

## Tests

`active-note-index.test.ts` (bun:test), covering:

- single note sounding only within `[start, start+duration)` (half-open: active
  at `start`, **not** at `start+duration`);
- **multi-beat note** found in every bucket across its span (the core
  correctness case — query at several beats inside a 4-beat note);
- a note spanning a bucket boundary still returned on both sides;
- dense chord (many notes, one onset) all returned together;
- result order follows the input array order (stable per-pitch winner);
- query before `minStart` / after the last note's end → `[]`;
- empty `notes` → `at()` always `[]`;
- zero-duration note never sounding (matches current `<` semantics).

Run: `bun test plugins/apps/plugins/sonata/plugins/score/core/active-note-index.test.ts`

## Verification

1. `./equin build` (regenerates docs/registry, type-checks, restarts server).
2. `bun test plugins/apps/plugins/sonata/plugins/score/core/active-note-index.test.ts` — index unit tests pass.
3. `./equin check type-check` — types/lint clean.
4. Manual (Playwright): open Sonata at `http://att-1781863713-9wd7.localhost:9000`,
   load a song, press Space to play, and confirm the keyboard still lights the
   correct keys in their per-track colors, that lit keys clear when notes end,
   and that mute/hide a track stops lighting its keys — i.e. **behavior is
   pixel-identical to before**, only cheaper. Use `e2e/screenshot.mjs` to capture
   a sounding frame before/after if a visual diff is wanted.

## Out of scope

- The piano-roll fx-core "active-note brighten" is **not** affected — it derives
  geometry imperatively from the Pixi projection, not a per-frame React scan, so
  it is not a second instance of this bug. It could adopt `buildActiveNoteIndex`
  later but is not touched here.
