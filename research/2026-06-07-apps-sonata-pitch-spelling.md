# Sonata Pitch Spelling (enharmonic spelling from key context)

> Builds on [`2026-06-02-apps-sonata-pipeline-architecture.md`](./2026-06-02-apps-sonata-pipeline-architecture.md)
> (§ Full IR — `PitchSpelling`, the optional `Note.spelling`, key model).

## Context

Sonata notes carry only a MIDI number, so the app cannot tell C♯ from D♭. Two
things suffer:

1. **Chord names.** `detectChord` names roots from a sharps-only `PC_NAMES`
   table, so a B♭ minor chord always renders **`A#m`**, regardless of key.
2. **Note spelling.** The IR has an optional `Note.spelling: PitchSpelling`
   field (`{ step, alter, octave }`) that **nothing populates** — both note
   sources (MIDI compile, chord-grid voicings) emit `pitch` only. Displays spell
   *lazily* at render via `makeKeySpeller(score.meta.key).spell(pitch)`, and the
   field stays `undefined`. A future staff renderer needs it populated.

Correct spelling must be **inferred from key/harmonic context**, because most
MIDI files don't carry a key header (`score.meta.key` is usually empty).

The key-aware speller primitive already exists and is good
(`score/core/spelling.ts` → `makeKeySpeller`); the gaps are (a) **inferring the
key** when none is declared, (b) **populating `Note.spelling`** from it, and
(c) **spelling chord roots** from it — with the **normalized (sharps) name
staying primary and the enharmonic spelling as an optional refinement**.

### Decisions (confirmed with user)
- **Infer the key from the notes** (not header-only) — Krumhansl–Schmuckler.
- **Populate `Note.spelling`** as well as chord naming (foundation for staff).
- **Chord UI: show both, normalized first**; spelled name as a muted secondary
  when it differs.

### How this answers "key changes?" and "weird/obscure keys?"
- **Key changes (modulation).** The IR already models key as `meta.key` (start)
  + `type:"key"` annotations (changes), and `KeyFlags` already renders those on
  the progress bar. Inference runs **windowed** (per-bar K–S, coalesced +
  smoothed) and emits a `source:"derived"` `key` annotation at each modulation
  boundary. A single new resolver `effectiveKeyAt(score, beat)` returns the key
  in force at any beat; note-spelling and chord-spelling both go through it, so a
  note/chord in a modulated section is spelled in *that* section's key. Because
  every consumer reads the resolver, the inference can be improved later with
  zero consumer changes. *Caveat:* short/ambiguous windows are smoothed
  (min-segment length + switch margin) to avoid flapping; very rapid/subtle
  modulations won't be perfectly tracked in v1.
- **Weird / obscure keys.** K–S always resolves to one of the 24 major/minor
  keys. We map each `(pitch-class, mode)` to its **conventional key name with
  the fewest accidentals** (so pc 6 major → G♭/F♯ by rule, pc 1 major → D♭, pc
  11 major → B — never nonsense like B♯ or G♯ major). `makeKeySpeller` already
  consumes a spelled tonic string and derives the signature from it. Modal /
  exotic scales (Dorian, pentatonic, blues) collapse to the nearest major/minor
  — fine, since only the **signature** drives spelling. **Atonal / ambiguous /
  percussive** content is guarded by a **confidence floor**: if the best
  correlation is weak or barely beats the runner-up, infer **no key** → fall
  back to today's normalized-sharps behavior (no `spelledSymbol`, no
  `Note.spelling`). Obscure content degrades gracefully instead of producing
  garbage spellings.

## Design

One primitive (`makeKeySpeller`) feeds three consumers, all routed through one
key resolver. The derivation pipeline gains two pure steps before analyzers run.

### 1. `score/core` — resolver + note-spelling pass (pure, the leaf)

**`spelling.ts` / new `key-context.ts`:**
- `effectiveKeyAt(score, beat): KeySignature | undefined` — the canonical "key
  in force at this beat": latest of `meta.key` (beat 0) + all `type:"key"`
  annotations at/before `beat`. This is the **single seam** for every consumer.
  Move `KeyFlags`' `collectKeyEntries` / `asKeySignature` here as the shared
  home (KeyFlags then consumes it — dedup, collection-consumer clean).
- `spellScore(score): Score` — returns a Score with each `note.spelling` filled
  via `makeKeySpeller(effectiveKeyAt(score, note.start)).spell(note.pitch)`.
  **Preserves** any pre-existing `spelling` (authored sheet). Memoize one
  speller per distinct in-effect key (key changes are sparse) — not one per
  note.

Export both from `score/core/index.ts`.

### 2. `theory/core` — key inference + chord-root spelling

**New `key-detect.ts`:**
- `inferKeys(score): Score` — if the score has **no authored key** (`meta.key`
  unset *and* no authored `key` annotations): build a **duration-weighted
  pitch-class histogram per bar** (`bars()` from score/core gives boundaries),
  correlate each window against the Krumhansl–Kessler major/minor profiles, pick
  the best key per window, coalesce consecutive same-key bars into regions, drop
  sub-`minBars` regions into neighbors, and emit one `source:"derived"`
  `key` annotation per region (including beat 0). Below the confidence floor,
  emit nothing. If authored key exists, return the score unchanged (v1 trusts
  authored truth; modulation inference over header-keyed files is a later
  improvement). Uses the conventional `(pc,mode) → key name` table described
  above.

**`chords.ts`:**
- `formatSpelledChordSymbol(data: {root, quality}, speller: KeySpeller): string`
  — spelled root (`step` + `accidentalGlyph(alter)` via `speller.spell(root)`)
  + `qualitySymbol(quality)`. Reuses existing helpers; emits proper ♯/♭ glyphs.

**`detect.ts`:**
- Extend `ChordData` (in `score/core/types.ts`) with optional
  **`spelledSymbol?: string`**. `symbol` stays the normalized (sharps) primary.
- `detectChord` is unchanged (key-agnostic, normalized only).
- `detectChordWindows(score)` computes, per window, `effectiveKeyAt(score,
  start)`; if a key is present, sets `data.spelledSymbol =
  formatSpelledChordSymbol(...)` **only when it differs** from `symbol`
  (memoize spellers by key). No key ⇒ field omitted.

### 3. `shell` — wire the two steps into the derivation memo

`shell/web/context.tsx`, the `baseScore` memo (currently lines 241–249):
```ts
const merged  = mergeScores(compiled);
const keyed   = inferKeys(merged);     // theory/core — fills derived `key` annotations
const spelled = spellScore(keyed);     // score/core  — fills Note.spelling per effective key
const derived = analyzers.flatMap((a) => a.analyze(spelled)); // chord-analyzer sees the key
return mergeAnnotations(spelled, derived);
```
Order matters: inference first (so spelling + chord detection have key context),
then note-spelling, then analyzers. `KeyFlags` shows the inferred key/modulations
on the progress bar automatically (already reads `key` annotations).

### 4. Consumers

- **`rich/chord-readout`** (`chord-readout.tsx`): keep `data.symbol` as the big
  primary; when `data.spelledSymbol` is set, render it as the muted secondary
  line (alongside quality/confidence). Normalized always first.
- **`rich/chord-overlay`** (`chord-overlay.tsx`): show `symbol`; add
  `spelledSymbol` to the `title` tooltip (overlay is space-constrained).
- **`piano-roll`** (`piano-roll.tsx:201–207`): label from `n.spelling` when
  present (fallback to lazy `makeKeySpeller(score.meta.key).spell(n.pitch)`),
  so labels follow per-region spelling. No visible change when key absent.
- **`piano-keyboard`** (static pitch axis): switch `makeKeySpeller(score.meta.key)`
  → `makeKeySpeller(effectiveKeyAt(score, 0))` so it benefits from the inferred
  starting key. (Cursor-aware relabel on modulation is a later option.)

## Files

| File | Change |
|------|--------|
| `score/core/types.ts` | `ChordData.spelledSymbol?: string` |
| `score/core/key-context.ts` (new) | `effectiveKeyAt`, shared `collectKeyEntries`/`asKeySignature` |
| `score/core/spelling.ts` | `spellScore(score)` |
| `score/core/index.ts` | export `effectiveKeyAt`, `spellScore` |
| `theory/core/key-detect.ts` (new) | `inferKeys(score)` (K–S), `(pc,mode)→keyName` table |
| `theory/core/chords.ts` | `formatSpelledChordSymbol` |
| `theory/core/detect.ts` | `detectChordWindows` fills `spelledSymbol` |
| `theory/core/index.ts` | export `inferKeys`, `formatSpelledChordSymbol` |
| `shell/web/context.tsx` | insert `inferKeys` + `spellScore` in `baseScore` memo |
| `rich/chord-readout/.../chord-readout.tsx` | secondary spelled line |
| `rich/chord-overlay/.../chord-overlay.tsx` | spelled in tooltip |
| `piano-roll/.../piano-roll.tsx` | read `n.spelling` (fallback) |
| `piano-keyboard/.../piano-keyboard.tsx` | `effectiveKeyAt(score, 0)` |
| `progress/keys/.../key-flags.tsx` | consume shared resolver (dedup) |

**Reused as-is:** `makeKeySpeller`, `accidentalGlyph`, `KeySpeller`
(`score/core/spelling.ts`); `qualitySymbol`, `formatChordSymbol`, `PC_NAMES`,
`CHORD_TEMPLATES` (`theory/core/chords.ts`); `bars` (`score/core/helpers.ts`);
`mergeAnnotations` / `mergeScores`. No new deps.

**Boundaries:** all new code is pure `core`. `theory/core` may import
`score/core` (already does); `score/core` imports nothing (`spellScore` /
`effectiveKeyAt` use only sibling files). The shell orchestrates both — no cycle.

## Verification

1. `./equin build`; open `http://<worktree>.localhost:9000/sonata`.
2. **Keyless MIDI in a flat key** (e.g. an F-major / B♭-major piece): chord
   readout shows normalized primary (`A#m`) with a muted spelled secondary
   (`B♭m`); piano-roll note labels read with flats; a key flag appears on the
   progress bar (inference fired).
3. **MIDI with a key header**: header key used directly (no inference);
   spelling matches the header.
4. **A piece that modulates**: progress bar shows ≥2 key flags at the boundary;
   notes/chords each side are spelled in their local key (resolver works).
5. **Atonal / percussive / chromatic-cluster input**: no key flag, no
   `spelledSymbol`, `Note.spelling` left undefined — identical to today
   (confidence-floor guard).
6. `query_db` not needed (pure client transform); confirm via the UI + piano-roll
   labels. `./equin check` passes (boundaries, eslint, docs in sync).
```
