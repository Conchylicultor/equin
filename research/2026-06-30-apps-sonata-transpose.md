# Sonata — Global Song Transpose

## Context

Sonata can load a song (MIDI, chord-grid, or Ultimate Guitar tab) and render it
through several lenses (piano-roll, songsheet, chord overlay, key chip/readout),
play it through a sampled audio engine, and re-voice authored chords. But there
is **no way to shift the whole song up/down by semitones**. Singers who need a
different key, and learners who want an easier key, are stuck with the original
pitch.

Everything downstream already reads pitch off one canonical `Score` (`Note.pitch`
in MIDI numbers; `ChordData.root`/`bass` in pitch-classes; `meta.key.tonic` as a
name string). A re-voicing pass (`reVoiceChords`), key inference (`inferKeys`),
and spelling (`spellScore`) already compose into one pipeline in
`shell/web/context.tsx`. The clean fix is a **single pure `transposeScore(score,
semitones)` transform injected early in that pipeline**, plus a persisted
per-song offset and a toolbar control. Done right, every lens and the audio
engine transpose for free — they need zero awareness of transpose.

**Goal:** a per-song transpose offset (in semitones), surfaced as a compact
toolbar stepper, that shifts notes, voiced chords, chord labels, the songsheet
chord text, and the displayed key — consistently across audio and all lenses,
and remembered per song.

## Design decisions

- **One pure transform, injected early.** Add `transposeScore(score, semitones)`
  and apply it in `SonataProvider`'s `baseScore` memo **right after
  `mergeScores`, before `reVoiceChords`**. Because it runs before re-voicing /
  key-inference / spelling / chord-analysis, all of those operate on the shifted
  pitches and every consumer (audio scheduler, piano-roll geometry, piano
  keyboard, overlays) stays untouched. This mirrors the existing pure
  `scaleTempo` precedent.
- **The transform lives in `theory/core`, not `score/core`.** Transposition is a
  music-theory operation: it must re-spell chord symbols and rename the key,
  which needs `parseChordSymbol`/`formatSpelledChordSymbol`/chord vocabulary —
  all in `theory`. `score/core` is a DAG leaf that cannot import `theory`. The
  shell already imports `inferKeys` from `theory/core`; `transposeScore` sits
  beside it as a peer Score→Score theory transform.
- **State is per-song persisted**, mirroring the **key-mode** plugin exactly —
  not ephemeral like `tempoScale`. A singer's preferred key for a song is a
  stable property of how *they* sing *that song*; it should survive reload and
  differ per song. (Tempo resets per session because it's a transient practice
  aid; transpose is not.)
- **The shell owns the in-memory offset** (a per-surface scoped store), because
  the load-bearing shell can't import a feature plugin (cycle). A new top-level
  `transpose` feature plugin owns DB persistence + a headless observer that
  writes the store on song open + the toolbar control — identical topology to
  `key-mode`.
- **Toolbar control, not a side panel.** Transpose is a primary, always-visible
  performance control (relevant to both piano-roll and songsheet), so it belongs
  in `SonataToolbar.End` next to the speed wheel — a compact `[ −  +N  + ]`
  semitone stepper. The live (transposed) key is already shown by the existing
  key-chip/key-readout, so the control stays focused on the semitone delta.

## Implementation

### 1. The pure transform — `theory/core/transpose.ts` (new)

`transposeScore(score: Score, semitones: number): Score` — pure, returns a new
Score, **no-op when `semitones === 0`** (note: a ±12 octave shift is NOT a no-op
— it moves audio + roll position even though pitch-classes are unchanged).

Steps:
1. **Notes**: `{ ...n, pitch: n.pitch + semitones, spelling: undefined }` for
   every note. Clearing `spelling` lets the downstream `spellScore` re-derive the
   staff spelling against the *transposed* key (authored spelling, if any, is
   invalidated by the shift). No per-note clamping — collapsing distinct pitches
   would create wrong notes; a handful of extreme notes falling outside
   `[0,127]`/`[21,108]` degrade gracefully (piano-roll already clamps; audio
   simply doesn't sound them). The toolbar range (±12) keeps essentially all
   notes in range.
2. **`meta.key`**: `transposeKey(key, semitones)` (below).
3. **Annotations** (all are `source:"authored"` at this point — analyzers/inferKeys
   run later):
   - `type:"key"` → `data` via `transposeKey`.
   - `type:"chord"` → shift `root`/`bass` by `semitones` mod-12, regenerate
     `symbol` via `formatChordSymbol` and `spelledSymbol` via
     `formatSpelledChordSymbol(data, speller)` where `speller =
     makeKeySpeller(effectiveKeyAt(keyedScore, ann.start))` over the
     already-key-transposed score (so flat keys read "B♭m", not "A#m").
   - `type:"lyric"` → map `data.chords[].symbol` through `transposeChordText`
     (below). This is the **only lens whose chord display is authored text**, so
     it needs explicit handling or the songsheet shows stale chords.
   - other types (`section`) unchanged.

Helpers in the same file:
- `transposeKey(key, semitones)`: parse `key.tonic` → pitch-class, add semitones
  (mod 12), re-name via `tonicName(pc, mode)` (export the existing private
  `tonicName` from `theory/core/key-detect.ts` so the fewest-accidental table has
  one home, reused by both `inferKeys` and transpose).
- `transposeChordText(symbol, semitones, speller)`: regex the **leading root
  token** (`/^([A-Ga-g][#b♯♭]*)/`) and an optional trailing `/<bass>`, shift each
  note token by semitones, re-name through the `speller` (key-correct
  enharmonics), and **preserve the suffix verbatim**. Returns the input unchanged
  when there's no leading note token (e.g. `"N.C."`, `"%"`). This is more
  faithful than parse→canonicalize for arbitrary UG chord text (it transposes
  `"Cadd9"` → `"Dadd9"` without needing to recognise `add9`).

Export `transposeScore` (and `transposeKey`) from
`theory/core/index.ts`; export `tonicName` from `key-detect.ts`.

### 2. Shell store — `shell/web/transpose-store.ts` (new)

Copy `key-mode-store.ts` shape: `defineScopedStore<{ semitones: number }>({
semitones: 0 })`, exporting `TransposeStoreProvider`,
`useTransposeSemitones()`, `useSetTransposeSemitones()`.

- Mount `<TransposeStoreProvider>` in `shell/web/components/sonata-layout.tsx`,
  nested beside `<KeyModeStoreProvider>` (wrapping `SonataProvider`).
- Re-export the three symbols from `shell/web/index.ts`.

### 3. Wire into the pipeline — `shell/web/context.tsx`

- `const transposeSemitones = useTransposeSemitones();`
- In `baseScore` (after `mergeScores`, before `reVoiceChords`):
  `const transposed = transposeScore(merged, transposeSemitones);` then
  `reVoiceChords(transposed, voicing)`. Add `transposeSemitones` to the memo deps.
- Import `transposeScore` from `theory/core`.

This composes correctly with the key-auto-detect toggle: with `force` on,
`inferKeys` strips `meta.key` and re-infers from the shifted notes (gets the
shifted key naturally); with `force` off, it sees our transposed authored
`meta.key` and keeps it. Either path yields the correct transposed key.

### 4. Feature plugin — `plugins/apps/plugins/sonata/plugins/transpose/` (new, top-level)

Mirror **key-mode** end-to-end (it's the proven precedent):

- `server/internal/tables.ts`: `defineExtension(_songs, "transpose", { semitones:
  integer("semitones").notNull().default(0) })` → `sonata_songs_ext_transpose`.
- `shared/resources.ts`: `TransposeRow = { songId, semitones }` + push
  `resourceDescriptor("sonata-transpose", …, [])`.
- `server/internal/resource.ts`: `defineResource` selecting all rows →
  `{ songId: r.parentId, semitones: r.semitones }`.
- `shared/endpoints.ts`: `POST /api/sonata/songs/:id/transpose` body
  `{ semitones: z.number().int().min(-12).max(12) }`.
- `server/internal/routes.ts`: `implement(...)` upsert via `songTranspose.upsert`.
- `server/index.ts`: declare resource + route.
- `web/actions.ts`: `saveTranspose(songId, semitones)` (fire-and-forget
  `fetchEndpoint`, mirroring `saveKeyAutoDetect`).
- `web/components/transpose-observer.tsx`: headless `Sonata.Effect` — reads the
  open song's persisted `semitones` from the resource (0 when no song / pending
  guard) and writes the shell store via `useSetTransposeSemitones()`. Exact copy
  of `KeyModeObserver`.
- `web/components/transpose-control.tsx`: the toolbar UI (below).
- `web/index.ts`: export `saveTranspose`; contribute
  `Sonata.Effect({ id: "transpose-sync", component: TransposeObserver })` and
  `SonataToolbar.End({ id: "transpose", component: TransposeControl })`.

### 5. Toolbar control — `TransposeControl`

Compact stepper matching the toolbar's visual language (mirror `TempoWheel`'s
bordered `Stack` + `Text` readout and `VolumeControl`'s `IconButton` usage):

```
[ MdSwapVert ] [ − ]  +2 st  [ + ]
```

- Reads `useTransposeSemitones()` + `currentSongId`/`score` from `useSonata()`.
- `−`/`+` `IconButton`s call `setTranspose(clamp(±1))` where `setTranspose`:
  (a) writes the shell store optimistically via `useSetTransposeSemitones()` for
  instant re-render, and (b) persists via `saveTranspose(currentSongId, next)`.
  Clamp to `[-12, 12]`; disable the buttons at the bounds.
- Center readout: `0` (muted) / `+N` / `−N`, with `st` unit; `tabular-nums`.
  Clicking the readout resets to `0` (only interactive when non-zero) — the quick
  "back to original key" affordance.
- Disabled (whole control dimmed) when `scoreEndBeat(score) <= 0` (no song),
  matching how `PlaybackControls` gates on `hasScore`.
- `WithTooltip`: "Transpose — shift the whole song by semitones".
- Use `react-icons/md` only (lint: no `lucide-react`), `control-*` sizing /
  spacing primitives (no ad-hoc spacing/radius), `IconButton` for the steppers.

### Files

| Concern | File |
|---|---|
| Pure transform + helpers | `theory/core/transpose.ts` (new), `theory/core/index.ts`, `theory/core/key-detect.ts` (export `tonicName`) |
| In-memory offset store | `shell/web/transpose-store.ts` (new), `shell/web/index.ts`, `shell/web/components/sonata-layout.tsx` |
| Pipeline injection | `shell/web/context.tsx` (`baseScore` memo) |
| Persistence + observer + control | `plugins/apps/plugins/sonata/plugins/transpose/**` (new plugin, mirrors `rich/plugins/key-mode`) |

## Reused functions (do not reinvent)

- `formatChordSymbol`, `formatSpelledChordSymbol`, `parseChordSymbol`, `PC_NAMES`
  — `theory/core/chords.ts` / `parse.ts`.
- `makeKeySpeller`, `effectiveKeyAt`, `accidentalGlyph` — `score/core`.
- `tonicName` (to be exported), `inferKeys` — `theory/core/key-detect.ts`.
- `defineScopedStore` — `primitives/scoped-store/web` (store).
- `defineExtension` (side-table), `defineResource`/`resourceDescriptor`,
  `defineEndpoint`/`implement`/`fetchEndpoint` — exact key-mode stack.
- `IconButton`, `Stack`, `Text`, `WithTooltip`, `cn` — toolbar control.

## Out of scope (intentional)

- **Live-play** (hand-played keys) is the user's own input, not the score —
  transposing it would mean "press C, hear D" (surprising). Untouched.
- **Metronome** clicks are synthetic, pitch-free. Untouched.
- Notes pushed outside MIDI/keyboard range at extreme transpose degrade
  gracefully (clamped on the roll, silent in audio); the ±12 range keeps this a
  non-issue in practice.

## Verification

1. `./equin build`, open `http://att-1782850139-ypgu.localhost:9000/sonata`.
2. **MIDI song** (piano-roll): open a starter, note the key-chip key. Press `+`
   a few times — falling notes shift right/up, the key-chip key follows, and
   playback **sounds** higher. `−` lowers it. Reset readout → original.
3. **UG / chord-grid song** (songsheet): the printed chord symbols transpose
   (e.g. `C G/B Am` → `D A/C# Bm` at +2), unparseable tokens like `N.C.` stay
   verbatim, and the chord overlay + key-chip agree. Audio (voiced chords) sounds
   transposed.
4. **Persistence**: set +3, reload the player — the offset and rendered key are
   restored. Open a different song — it shows its own offset (0 by default), not
   the previous song's.
5. **Compose with key-auto-detect**: toggle auto-detect on a transposed song —
   the detected key matches the transposed pitches; spelling stays correct.
6. **Unit tests** (bun:test, co-located `theory/core/transpose.test.ts`):
   note-pitch shift; `meta.key` rename (`C`→`D` at +2; flats preserved sensibly);
   chord-annotation root/bass shift + spelled symbol; `transposeChordText` for
   plain, slash, extended, and unrecognised symbols; `semitones === 0` identity.
   Run: `bun test plugins/apps/plugins/sonata/plugins/theory/core/transpose.test.ts`.

## Follow-ups to file

- `key-readout`'s local `tonicPc` duplicates name→pitch-class logic that
  `transposeKey` will also need; a future pass could DRY a shared `tonicPc` into
  `theory/core` (kept out of scope here to avoid touching key-readout).
