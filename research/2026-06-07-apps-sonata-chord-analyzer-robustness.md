# Sonata Chord Analyzer Robustness

> Pipeline context: [`2026-06-02-apps-sonata-pipeline-architecture.md`](./2026-06-02-apps-sonata-pipeline-architecture.md)
> (§ rich data — the `Sonata.Analyzer` axis). This doc redesigns the analyzer's
> detection core; the slot wiring and IR are unchanged.

## Context

Sonata's chord analyzer (`rich/chord-analyzer`) turns a `Score`'s notes into
`chord` annotations. Today it is **onset-windowed interval-set matching**: it
slices the score at every distinct note onset *and* offset, and for each micro-slice
runs a binary "are all of this template's intervals present?" subset match over all
12 roots. That works on clean block chords but degrades badly on real input:

- **Transient/flickering labels.** An arpeggio or any broken voicing produces a
  separate window (and often a separate label) per onset — `C E G C` over one beat
  becomes several windows, not one `C`.
- **Passing/non-chord tones corrupt the match.** A momentary passing note either
  breaks the strict subset (no label) or, combined with the chord tones, strict-matches
  a *different* template on a wrong root. There is no notion of "this note was only
  sounding for a 16th — it's not harmonic."
- **No bass/root awareness.** Among enharmonically ambiguous pitch-class sets the
  wrong root can win; inversions are invisible.
- **Extensions are inert.** The `dom9`/`dom13`/`maj9` templates use literal
  intervals (`9=14`, `13=21`) that can never appear in a mod-12 interval set, so they
  never match in detection.
- **No confidence floor or smoothing.** Low-confidence/ambiguous slices are emitted
  as labels; atonal clusters get spurious chords.

**Intended outcome:** stable, musically-correct chord labels on dense voicings,
arpeggios, and lines with passing tones — with inversion (slash-chord) and basic
extension (dom9/dom13) handling — by replacing the binary per-micro-slice matcher
with a **beat-quantized, duration-weighted, best-fit** detector.

### Design philosophy — mirror the `inferKeys` precedent

`theory/core/key-detect.ts` (`inferKeys`) already solved the structurally identical
problem for *keys*: beat/bar-quantized windows → duration-weighted pitch-class
histogram → continuous correlation scoring → confidence floor → region coalescing →
short-region smoothing to a fixed point. The chord detector should adopt the **same
shape** (scoring against chord templates with a bass bias instead of key profiles),
so passing-tone and fragmentation noise are suppressed by the same proven mechanism.
This is "mirror working precedent" — the redesign is not a new invention, it ports a
pattern that already lives next door in the same plugin.

## Current code map

| Concern | Location |
|---|---|
| Analyzer relay (`analyze`) | `rich/plugins/chord-analyzer/web/analyze.ts` — calls `detectChordWindows`, maps `ChordWindow → Annotation<"chord",ChordData>` |
| Detection core | `theory/core/detect.ts` — `detectChord`, `detectChordWindows` |
| Chord vocabulary + formatting | `theory/core/chords.ts` — `CHORD_TEMPLATES`, `PC_NAMES`, `formatChordSymbol`, `formatSpelledChordSymbol`, `qualitySymbol` |
| Key precedent to mirror | `theory/core/key-detect.ts` — `inferKeys` (windowed weighted histogram + smoothing) |
| Timing helpers | `score/core/helpers.ts` — `bars()`, `scoreEndBeat()` (no beat-grid helper yet) |
| IR types | `score/core/types.ts` — `ChordData`, `Note`, `Annotation` |
| Consumers (read `data.symbol`/`spelledSymbol`/`quality` only) | `rich/chord-overlay`, `rich/chord-readout` |

Pipeline order (`shell/web/context.tsx`): `mergeScores → inferKeys → spellScore →
analyzers.flatMap(analyze) → mergeAnnotations`. The analyzer always sees a keyed +
spelled score, so `effectiveKeyAt`/`makeKeySpeller` are available for enharmonic
spelling (unchanged).

## Approach

Replace the two detection functions with a weighted, beat-synchronous pipeline. All
new theory code stays in `theory/core` (imports only `score/core`; DAG preserved).

### 1. Beat-quantized windowing — `beatGrid()` helper

Add to `score/core/helpers.ts`, mirroring `bars()`:

```ts
/**
 * Beat-grid cell boundaries from timeSigMap + pickupBeats. Cell size is one
 * quarter-note beat by default; `subdivisions` (e.g. 2 → eighth grid) refines it.
 * Pure. Same pickup handling and runaway guard as bars().
 */
export function beatGrid(
  score: Score,
  subdivisions?: number, // default 1
): { index: number; startBeat: number }[];
```

Walk from beat 0 (pickup = cell 0, identical to `bars()`), advancing by
`cellLen = (4 / denominator) / subdivisions` for the time signature active at the
current beat, up to `scoreEndBeat(score)`. Reuse the `bars()` guard.

`detectChordWindows` slices on this grid instead of note onsets/offsets. **Default
`subdivisions = 1`** (one detection per quarter-beat) — coarse enough to collapse
arpeggios, fine enough for normal harmonic rhythm. Exposed as an opt for future
tuning.

### 2. Duration + velocity weighted PC profile

Private `windowChordProfile(score, start, end): number[]` in `detect.ts`, twin of
key-detect's `windowHistogram`:

```
overlap        = max(0, min(noteEnd, end) − max(noteStart, start))
velocityFactor = VELOCITY_FLOOR + (1 − VELOCITY_FLOOR) × (velocity / 127)
profile[pitch mod 12] += overlap × velocityFactor
```

`VELOCITY_FLOOR = 0.5` (named constant; set to `1.0` to disable velocity weighting).
Not normalized here — normalization happens in scoring. This is the mechanism that
makes a 16th-note passing tone contribute negligible weight.

### 3. Weighted best-fit scoring — replaces binary subset

New public entry point; `detectChord(pitches)` becomes an equal-weight wrapper that
preserves its current signature/contract.

```ts
export function detectChordWeighted(
  profile: ReadonlyArray<number>, // length-12 PC weight histogram
  bassPc?: number,                // window's lowest sounding pitch-class
): ChordMatch | null;
```

Score each `root ∈ 0..11` × base template (triads + 7ths only; extensions handled in
§5). With interval set `I` (incl. implicit root 0) and `total = Σ profile`:

```
chordWeight  = Σ profile[pc]  for pc with (pc − root) mod 12 ∈ I
extraWeight  = total − chordWeight
missingCount = # template intervals i with profile[(root+i) mod 12] == 0
rootPresent  = profile[root] > 0                     // hard gate (continue if false)

score = chordWeight/total
      − W_MISSING × (missingCount / |I|)
      − W_EXTRA   × (extraWeight / total)            // suppresses non-chord tones
      + W_BASS    × bassBonus(root, bassPc, I)
```

```
bassBonus = 0                      if bassPc undefined
          = +1.0                   if bassPc === root            (root position)
          = +0.4                   if (bassPc−root) mod 12 ∈ I   (inversion: chord tone bass)
          = −0.5                   otherwise                     (non-chord-tone bass: root suspect)
```

Coefficients (named constants, tunable): `W_MISSING = 0.30`, `W_EXTRA = 0.55`,
`W_BASS = 0.15`. Tie-break: iterate templates most-specific-first (7ths before
triads), keep first on equality (within `1e-9`), lower root last — preserves current
"prefer the richer chord" behavior.

```
confidence = clamp01( chordWeight/total − W_EXTRA × (extraWeight/total) )
```

Confidence deliberately excludes the bass bonus (bass affects *which* chord, not *how
sure* it is a chord). Why this fixes the failures: a momentary passing tone has tiny
`extraWeight` → tiny penalty → the real chord still wins (failure mode 2); a sustained
wrong note has large `extraWeight` → correctly rejected; the bass bonus breaks
enharmonic root ties (failure mode 3).

### 4. Bass tracking → inversion / slash chords

In `detectChordWindows`, the window bass = pitch-class of the lowest-pitched note
sounding in the window (prefer notes whose overlap ≥ half the window, fall back to the
absolute lowest). Pass as `bassPc` to `detectChordWeighted`.

**`ChordData` gains `bass?: number`** (`score/core/types.ts`):

```ts
export type ChordData = {
  symbol: string;
  root: number;
  quality: string;
  bass?: number;          // NEW — set only on a genuine inversion (bass ≠ root, bass is a chord tone)
  spelledSymbol?: string;
};
```

Optional field → no existing constructor breaks. `bass` is set only when
`bassPc !== root` and `bassPc` is a chord tone.

`formatChordSymbol` / `formatSpelledChordSymbol` (`chords.ts`) append `"/" + bassName`
when `bass` is present and ≠ root (`formatSpelledChordSymbol` spells the bass through
the `KeySpeller` too, so `C/E` reads correctly in a flat key). `detectChordWindows`
must build `symbol` via `formatChordSymbol(match.data)` (it currently inlines
`rootName + tmpl.symbol`) so the slash lands in `symbol`. **Consumers (overlay,
readout) need no change** — they read `symbol`/`spelledSymbol`, which now carry the
slash. Gated behind a `slashChords` opt (default `true`) for easy disable.

`parseChordSymbol` (authoring) is **not** taught slash parsing in v1 (authoring
sources don't emit inversions); add a doc note. Round-trip is unaffected since
`formatChordSymbol` only emits a slash when `bass` is set, which the parser never
produces.

### 5. Extension handling (dom9 / dom13) without template explosion

Detection stays over base triads + 7ths. After a base match wins, a private
`upgradeExtension(base, profile, total)` **relabels** the symbol when a
strongly-weighted extension PC is present (extension PCs mod-12: 9th=2, 11th=5,
13th=9):

- Only upgrade a **dom7** base in v1.
- Require extension weight ≥ `EXT_WEIGHT_FRAC × total` (`EXT_WEIGHT_FRAC = 0.08`).
- 9th present → `dom9` (symbol "9"); 9th **and** 13th present → `dom13` ("13").
- The upgrade changes only `quality` (hence the suffix); `root`/`bass`/`confidence`
  unchanged. This finally gives the inert `dom9`/`dom13` templates a purpose: they're
  reused as relabel targets for their `symbol` strings.

`maj9`/`min9`/11ths/altered chords are **deferred** to a follow-up (rarer; the 11th
collides with sus/4 ambiguity).

### 6. Confidence floor + transient smoothing

Constants in `detect.ts` (mirror key-detect):

```ts
const CONFIDENCE_FLOOR = 0.5;   // window below this emits NO chord (atonal/cluster guard)
const MIN_REGION_BEATS = 1;     // shorter coalesced windows are smoothing-eligible
```

- **Floor:** `detectChordWeighted` returns `null` when `confidence < CONFIDENCE_FLOOR`
  → no label. An atonal cluster spreads weight across many PCs → `extraWeight`
  dominates every candidate → below floor → silent (failure mode 5 + atonal test).
- **Coalesce (keep):** consecutive windows with identical `symbol` merge into one span
  (contiguous grid guarantees adjacency); `Math.max` confidence, union noteIds. This
  collapses an arpeggio's per-beat `C` cells into a single `C` (failure mode 1).
- **Smoothing (new):** fixed-point pass — a window shorter than `MIN_REGION_BEATS`
  **flanked by two windows with the same symbol** is dropped and its neighbors merge.
  Iterate to a fixed point (mirrors key-detect region smoothing). Conservative: never
  merges *differing* neighbors (that would invent harmony). Removes single-beat junk
  wedged between two stable chords.

## File-by-file changes

All respect plugin-boundary rules (`theory/core` imports only `score/core`; barrels
re-export only the plugin's own internals).

| File | Change |
|---|---|
| `score/core/types.ts` | Add optional `bass?: number` to `ChordData`. |
| `score/core/helpers.ts` | Add `beatGrid(score, subdivisions?)` (mirror `bars()`). |
| `score/core/index.ts` | Export `beatGrid`. |
| `theory/core/chords.ts` | `formatChordSymbol` & `formatSpelledChordSymbol` accept optional `bass` and append the slash (spelled bass for the latter). |
| `theory/core/detect.ts` | Add constants (`CONFIDENCE_FLOOR`, `MIN_REGION_BEATS`, `W_MISSING`, `W_EXTRA`, `W_BASS`, `VELOCITY_FLOOR`, `EXT_WEIGHT_FRAC`); add `windowChordProfile`, `upgradeExtension`, public `detectChordWeighted`; rewrite `detectChord` as equal-weight wrapper; rewrite `detectChordWindows` (beatGrid boundaries, profile+bass per window, `formatChordSymbol` for symbol, coalesce + new smoothing pass; opts `{ skipSpans?, subdivisions?, slashChords? }`). |
| `theory/core/index.ts` | Export `detectChordWeighted`. |
| `theory/core/parse.ts` | Doc note only: slash parsing intentionally out of v1 scope. |
| `rich/chord-analyzer/web/analyze.ts` | No change required (relay; `data` now carries `bass` + slash symbol automatically). |
| `rich/chord-overlay`, `rich/chord-readout` | No change (read generic `data` fields). |
| `theory/core/detect.test.ts` | **New** — bun:test suite (below). |

## Tests — `theory/core/detect.test.ts` (bun:test)

Zero-config (`bun test` from repo root), beside the source (matches
`worktree-op.test.ts`). Inline fixtures from `emptyScore()`:

```ts
import { test, expect } from "bun:test";
import { emptyScore, type Note, type Score } from "@plugins/apps/plugins/sonata/plugins/score/core";

let nid = 0;
const note = (pitch: number, start: number, duration: number, velocity = 90): Note =>
  ({ id: `n${nid++}`, pitch, start, duration, velocity, track: "t" });
const scoreOf = (notes: Note[], ts = { beat: 0, numerator: 4, denominator: 4 }): Score =>
  ({ ...emptyScore(), timeSigMap: [ts], notes });
```

Cases:

**`detectChord` / `detectChordWeighted`**
1. Dense doubled voicing `C E G C E` → `{root:0, quality:"maj"}`, confidence ~1.
2. Passing tone suppressed: profile C/E/G heavy + D tiny → still C major.
3. Sustained wrong note: C/E/G + F# equal weight → **not** plain C major (confidence dips / different result) — validates `W_EXTRA`.
4. Bass bias breaks an enharmonically ambiguous PC set toward the `bassPc` root.
5. First inversion: C-E-G, bass pc = 4 → `{root:0, quality:"maj", bass:4}`; `formatChordSymbol` → `"C/E"`.
6. dom7 + 9 (G B D F A sustained) → quality `dom9`, symbol "G9".
7. Atonal cluster (C C# D D# E F equal weight) → `null` (below floor).

**`detectChordWindows`**
8. Arpeggio `C(0,1) E(1,1) G(2,1) C(3,1)` over a 4/4 bar → exactly one `C` window `[0,4)`.
9. Block-vs-broken parity: block C bar 1 + arpeggiated C bar 2 → same symbol both windows.
10. Transient junk: C-major bars 1–2, one-beat stray dyad on beat 3, C-major bars 3–4 → smoothing leaves one continuous `C`; junk window absent.
11. Passing tone in context: held C-E-G with a quarter-note D on beat 2 → single `C`, no flicker.
12. Inversion end-to-end: low E under held C-E-G across a bar → window symbol `C/E`.
13. `skipSpans` regression: authored chord span suppresses overlapping derived windows.
14. Empty score → `[]`.

**`beatGrid`** (same file)
15. 4/4 default → cells 0,1,2,3,…; last closes at `scoreEndBeat`.
16. 6/8 → quarter-beat cells of 0.5.
17. Pickup handling matches `bars()`.
18. `subdivisions = 2` halves cell length.

## Verification

1. `bun test plugins/apps/plugins/sonata/plugins/theory/core/detect.test.ts` (from
   repo root) — all cases green. This is the primary correctness gate.
2. `./equin build` — theory/core + score/core recompile; checks (boundaries,
   eslint, plugins-doc-in-sync) pass. `ChordData` change is additive (optional field),
   so no migration/codegen ripple.
3. Open `http://att-1780853651-1ojw.localhost:9000/sonata`, load a seed song
   (Für Elise / Ode to Joy — has arpeggios and passing tones):
   - Chord overlay labels are **stable** along the timeline (no per-note flicker);
     arpeggiated passages show one chord per harmonic unit.
   - The current-chord readout tracks the cursor without rapid relabeling.
   - An inverted voicing renders a slash (e.g. `C/E`); a dominant-with-9th reads "9".
4. Confirm an atonal/cluster passage produces **no** spurious label rather than junk.

## Tuning constants (defaults chosen; all named for easy adjustment)

`subdivisions = 1` · `VELOCITY_FLOOR = 0.5` · `W_MISSING = 0.30` · `W_EXTRA = 0.55`
· `W_BASS = 0.15` · `CONFIDENCE_FLOOR = 0.5` · `MIN_REGION_BEATS = 1`
· `EXT_WEIGHT_FRAC = 0.08` · `slashChords = true`.

## Deferred (follow-ups)

- Extended detection beyond dom9/dom13: `maj9`/`min9`/11ths/sus/altered.
- Slash-chord parsing in `parseChordSymbol` (only needed if an authoring source emits
  inversions).
- Exposing tuning constants via `config_v2` if users want per-song control.
