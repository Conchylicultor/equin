# Sonata — extended/altered chord grammar

## Context

Users type chord symbols into Sonata's chord authoring sources (the **chord-grid**
`<textarea>` and imported **Ultimate-Guitar** tabs). These are parsed by
`parseChordSymbol` (`plugins/apps/plugins/sonata/plugins/theory/core/parse.ts`),
which matches the whole post-root remainder against a **flat exact-suffix table**.
Anything it doesn't recognise returns `null`; the chord-grid then shows it under a
red `Unrecognised: …` line and drops it from the song entirely.

Three common families currently fail to parse, each exposing a distinct gap:

- **`Gsus4(♭9)`** — suspended chords (`sus2`/`sus4`) are absent from the vocabulary.
- **`G7(♯5)`** — there is no grammar for parenthetical alterations
  (`(♯5)`, `(♭9)`, `(♯9)`, `(♭5)`, `(♯11)`, `(♭13)`, `add9`, `no3`, …).
- **`Eb6/9`** — 6/9 chords are missing **and** the `/9` is mis-read as a slash-bass
  (the bass parse fails on `9`, so the whole symbol is rejected).

The exact-match table cannot scale to alterations (they stack combinatorially:
`7(♭9♯5)`, `7(♯9♭13)`…). The clean fix is a small **chord grammar** that decomposes
a symbol into `root → base head → modifier list` and realises an **interval set**,
so every present and future alteration combo works with no new table rows.

**Scope:** authoring only (parsing typed symbols). Note-based **detection**
(`detect.ts`, notes → label) is intentionally left unchanged. **Display:** the
parser emits a **canonical** symbol string (canonical quality/modifier suffix,
user's root spelling preserved).

## Key facts established during exploration

- **Chords are never persisted structurally.** Chord-grid stores raw text
  (`chord-grid/server/internal/tables.ts` — single `chordText` column) and
  re-parses on every render/compile (`chord-grid/web/parse-grid.ts:133`,
  `compile.ts:63`). UG stores raw markup. So `ChordData` is fully ephemeral and
  **adding a field is non-breaking** — no migration, no back-compat on quality ids.
- **Authoring interval source** is `chordPitches(data)` →
  `qualityToIntervals(data.quality)` (`theory/core/voicing.ts:22`), which **throws**
  on an unknown quality (`chords.ts:80`). This is the one place the realised pitch
  set is derived for playback/voicing.
- **Display trusts the stored `symbol`/`spelledSymbol` verbatim** for authored
  chords (songsheet, notation, chord-overlay/-progression/-readout, circle-of-fifths).
  `parseChordSymbol` is the sole producer of `symbol` for typed chords
  (`parse.ts:135-139`) — it does **not** go through `formatChordSymbol`.
- **`block-triad` voicing** does `chordPitches(...).slice(0,3)`
  (`voicing/core/voicing.ts:142`). This relies on the interval set being **ascending
  with the 3rd-substitute then the 5th first** — a sorted degree-map naturally
  satisfies this (root prepended, then `intervals[0]=3rd`, `intervals[1]=5th`).
- **Transpose rebuilds the chord symbol from `quality`**
  (`transpose.ts:173-174`, `formatChordSymbol`/`formatSpelledChordSymbol`), which
  would **drop an alteration suffix** on transpose. There is already a
  suffix-preserving re-rooter, `transposeChordText` (`transpose.ts:80-106`, used for
  lyric chords — its doc even lists `sus4`), to reuse.
- **Two UI sites read `.quality` directly:** `chord-readout.tsx:108` prints it
  verbatim as a caption, and `circle-of-fifths.tsx:149` does
  `MINOR_QUALITIES.has(quality)`. Both keep working because altered chords retain
  their **base** quality (`dom7`/`min7`/`maj`…) and `sus`/`6-9` are simply not in
  the minor set (→ major ring). No change required there (minor cosmetic note below).

## Design

### 1. `ChordData` gains an optional realised interval set

`plugins/apps/plugins/sonata/plugins/score/core/types.ts`:

```ts
export type ChordData = {
  symbol: string;
  root: number;
  quality: string;
  bass?: number;
  spelledSymbol?: string;
  /** Realised semitones above the root (root excluded, ascending). Set by the
   *  parser only when the chord is altered beyond its base `quality` (parenthetical
   *  alterations / add / omit). Absent for plain qualities, which derive their
   *  intervals from `quality`. */
  intervals?: readonly number[];
};
```

`quality` stays the **coarse base category** (used by detection round-trip,
circle-of-fifths, readout). `intervals`, when present, is the authoritative pitch
set for authoring.

### 2. `chordPitches` prefers `intervals`

`plugins/apps/plugins/sonata/plugins/theory/core/voicing.ts`:

```ts
export function chordPitches(
  data: { root: number; quality: string; intervals?: readonly number[] },
  octave = 4,
): number[] {
  const base = 12 * (octave + 1) + pc12(data.root);
  const intervals = data.intervals ?? qualityToIntervals(data.quality);
  return [base, ...intervals.map((i) => base + i)];
}
```

Detected chords (no `intervals`) fall back to the quality template — unchanged.

### 3. Register `sus2`, `sus4`, `6/9` as first-class qualities

`plugins/apps/plugins/sonata/plugins/theory/core/chords.ts` — add to
`CHORD_TEMPLATES` (in the "Added-tone & extended" section, so `qualityToIntervals`
/`qualitySymbol` never throw on them):

```ts
{ quality: "sus2", symbol: "sus2",  intervals: [2, 7] },
{ quality: "sus4", symbol: "sus4",  intervals: [5, 7] },
{ quality: "six9", symbol: "6/9",   intervals: [4, 7, 9, 14] },
```

These are authoring-only, so exclude them from detection's vocabulary in
`detect.ts` `BASE_TEMPLATES` (`detect.ts:94-99`) alongside `maj6`/`min6`
(`six9` is already excluded by the `intervals < 12` guard; `sus2`/`sus4` are **not**
and must be excluded explicitly, or detection would begin labelling bare `{0,2,7}`/
`{0,5,7}` dyads as sus).

### 4. Rewrite `parse.ts` as a grammar

Replace the exact-suffix match with `root → slash-bass → base head → modifier tail`:

**a. Root** — unchanged (`[A-G]` + accidentals → pitch class; preserve spelling).

**b. Slash-bass split (fixes `6/9`)** — split on the **last** `/`; treat the tail
as a bass **only if it parses as a bare note**. `Eb6/9` → tail `9` is not a note →
no bass, body `6/9`. `Eb6/G` → tail `G` is a note → bass `G`, body `6`. `Am7/G` →
bass `G`, body `Am7`. Reuses the existing `parseNotePc`.

**c. Base head (longest-prefix match)** — match the longest recognised quality
*prefix* of the body (not the whole remainder), against the current alias set
**plus** `sus`/`sus2`/`sus4` and `6/9`. The head seeds a **degree→semitone map**
and records the base quality + canonical head suffix. The empty head `""` (major
triad) matches as a fallback, so unrecognised tails still route to modifier parsing
(and to `null` if invalid) — preserving today's "typo → null" behaviour.

**d. Modifier tail** — tokenise the remainder into modifiers; every token must be
recognised or the whole symbol is `null`. Modifiers mutate the degree map
(replacement is unambiguous because it is keyed by scale degree):

| Token(s) | Effect on degree map |
|---|---|
| `sus2` | delete 3, set `2→2` |
| `sus`, `sus4` | delete 3, set `4→5` |
| `♭5`/`b5`, `♯5`/`#5`/`+5` | set `5→6` / `5→8` |
| `♭9`/`b9`, `9`/`add9`, `♯9`/`#9` | set `9→13` / `9→14` / `9→15` |
| `11`/`add11`, `♯11`/`#11` | set `11→17` / `11→18` |
| `♭13`/`b13`, `13`/`add13` | set `13→20` / `13→21` |
| `6`/`add6` | set `6→9` |
| `no3`/`omit3`, `no5`/`omit5` | delete 3 / delete 5 |

Tokens may be wrapped in `(...)` (one or more groups, e.g. `(♯5)`, `(♭9♯5)`,
`(#5,b9)`) or appear bare (e.g. `7sus4`, `add9`). Separators (spaces, commas)
inside groups are ignored. Accept both ASCII (`#`/`b`) and glyph (`♯`/`♭`) accidentals.

**e. Outputs:**
- `intervals` = sorted unique degree-map values — **only** when at least one
  modifier was applied (a plain head keeps `intervals` absent).
- `quality` = the base head's registered quality (`dom7`, `min7`, `sus4`, `six9`, …).
- `symbol` = **canonical**: `rootText` + canonical head suffix + `formatModifiers(...)`,
  then re-append `/bass`.

**f. Canonical modifier rendering** (`formatModifiers`): suspension modifiers on a
7th head render as `sus2`/`sus4` appended to the head suffix; altered tones
(`♭5 ♯5 ♭9 ♯9 ♯11 ♭13` and tension-adds) are collected, **sorted by degree
ascending**, rendered with `♯`/`♭` glyphs, and wrapped in a single `(...)`;
`addN` and `(noN)` follow. Verified against the three examples:
`Eb6/9`, `G7(♯5)`, `Gsus4(♭9)` all round-trip to themselves.

### 5. Fix transpose to preserve the (canonical) suffix

`plugins/apps/plugins/sonata/plugins/theory/core/transpose.ts` — the chord branch
(`:161-177`) currently rebuilds `symbol`/`spelledSymbol` from `quality` via
`formatChordSymbol`/`formatSpelledChordSymbol`, dropping any alteration. Change it to
**re-root the existing symbol strings while preserving the suffix** (the interval set
is root-relative and already carried through the `...data` spread — unchanged by
transposition):

- Extract the root+bass re-rooting from `transposeChordText` into a helper
  parameterised by a `spell: (pc: number) => string` function.
- `symbol` uses `PC_NAMES` (sharps-normalised) as the speller; `spelledSymbol` uses
  the key-aware `makeKeySpeller(effectiveKeyAt(...))`.

This is behaviour-identical for existing plain chords (root shifts, canonical suffix
unchanged) and correct for altered chords. `formatChordSymbol`/`formatSpelledChordSymbol`
remain in use by **detection** only (base qualities), so they need no alteration logic.

## Files to modify

| File | Change |
|---|---|
| `…/score/core/types.ts` | Add `intervals?: readonly number[]` to `ChordData`. |
| `…/theory/core/chords.ts` | Add `sus2`/`sus4`/`six9` to `CHORD_TEMPLATES`. |
| `…/theory/core/parse.ts` | Rewrite as the grammar above (root → last-slash bass-if-note → head prefix → modifier tail → degree map → intervals + canonical symbol). |
| `…/theory/core/voicing.ts` | `chordPitches`: prefer `data.intervals`. |
| `…/theory/core/detect.ts` | Exclude `sus2`/`sus4` (and `six9`) from `BASE_TEMPLATES`. |
| `…/theory/core/transpose.ts` | Chord branch: re-root symbol/spelledSymbol preserving suffix (shared helper); drop the `formatChordSymbol`-from-quality rebuild for chords. |

No barrel changes (the public surface — `parseChordSymbol`, `chordPitches` — is
unchanged). No changes to the chord-grid/UG sources: they call `parseChordSymbol` and
benefit automatically (UG's `collectUnrecognisedChords` bucket shrinks).

### Minor cosmetic note (not addressed)
`chord-readout.tsx:108` prints the raw `quality` id as a caption (a pre-existing
"leak" — it already shows `maj7` etc.). Altered chords will show their base quality
there (e.g. `dom7` under a `G7(♯5)` symbol) and `six9` for 6/9 chords. Left as-is;
a friendly-label pass on the readout is a separate concern.

## Tests

New/extended `bun:test` co-located suites (framework/style per `parse.test.ts`:
`import { describe, expect, it } from "bun:test"`, relative `./parse` import,
`toEqual` for exact shape, `toMatchObject` for partial, grouped `toBeNull` for typos):

- `…/theory/core/parse.test.ts` — add a `describe("parseChordSymbol — sus / 6-9 / altered")`:
  - `Gsus4` → `{ root:7, quality:"sus4", symbol:"Gsus4" }` (no `intervals`).
  - `Csus2` → `{ quality:"sus2", symbol:"Csus2" }`.
  - `Eb6/9` → `{ quality:"six9", symbol:"Eb6/9" }` (no `intervals`, no `bass`).
  - `G7(♯5)` → `{ quality:"dom7", symbol:"G7(♯5)", intervals:[4,8,10] }`.
  - `Gsus4(♭9)` → `{ quality:"sus4", symbol:"Gsus4(♭9)", intervals:[5,7,13] }`.
  - `C7(♭9)`/`C7#9`/`C7b5`/`Cadd9`/`C7sus4` → correct intervals + canonical symbol.
  - Slash-bass still works: `Am7/G`, `C6/E`; and `Eb6/9` is **not** treated as a bass.
  - Typos still `null`: `Cxyz`, `C7(`, `Gsus5`.
- `…/theory/core/voicing.test.ts` — `chordPitches` for an altered chord uses `intervals`
  (e.g. `G7(♯5)` → `[…, +4, +8, +10]`), and `block-triad`'s `slice(0,3)` yields the
  intended core triad for `sus4`/`6-9`/`7(♯5)`.
- `…/theory/core/transpose.test.ts` — transposing `G7(♯5)` up 2 → `A7(♯5)` (suffix
  preserved), and a plain chord transposes exactly as before (regression).

Run: `bun test plugins/apps/plugins/sonata/plugins/theory/core`.

## End-to-end verification

1. `./equin build` (from the worktree). Regenerates nothing schema-wise (no DB
   change), rebuilds web + server.
2. Open a Sonata song with a chord-grid source at
   `http://att-1782924335-livs.localhost:9000/sonata`, and type
   `Eb6/9  G7(♯5)  Gsus4(♭9)` into the grid. Confirm the red `Unrecognised:` line is
   gone and each chord renders with its canonical symbol.
3. Press play (or use the audio engine) to confirm the chords **sound** the altered
   pitches (e.g. `G7(♯5)` sounds the D♯, not D).
4. Toggle the transpose stepper (transpose plugin) and confirm the altered suffix is
   preserved (e.g. `G7(♯5)` → `A7(♯5)`), not reduced to `A7`.
5. Scripted check with `e2e/screenshot.mjs` against the chord-grid editor to capture
   before/after of the `Unrecognised` line clearing.
