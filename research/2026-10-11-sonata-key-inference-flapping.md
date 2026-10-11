# Sonata: one song, one key — stop key inference flapping, give the chord list a song key

## Context

On *Là-bas* (song-1791710976-b16ii1, an Ultimate Guitar sheet aligned to a recording) the
**Current key** section says *D major (Auto-detected)* while the **Chord list** numbers its
rows against B minor (Bm7 = i⁷, G = VI, A = VII, D = III) and colours them that way too.

**Where each reads its key.** Both use the same resolver, `score/core/key-context.ts`
(`collectKeyEntries` / `effectiveKeyAt`), but at different beats:

- `rich/key-readout` → the key entry in force **at the playhead**.
- `rich/chord-list` → for each distinct chord, `effectiveKeyAt(score, firstOccurrence.start)`.
  So every row can be read in a different key, and a chord's colour depends on where it
  happens to appear first.

They only disagree because the score holds **many** key entries. The sheet has no key
(`key: null`), so `theory/core/key-detect.ts` `inferKeys` derives them from the chord notes
with a **per-bar** Krumhansl–Schmuckler window. Replaying this song's aligned chords
through it gives:

```
0 D major · 100 G major · 116 D major · 188 D major · 208 B minor · 224 B minor ·
240 F# minor · 256 F# minor · 272 D major · 376 B minor · 456 D major · 484 F# minor ·
500 F# minor · 516 D major · 544 F# minor · 608 F# minor
```

**Which is right:** D major. The song is I–vi–IV–V in D (D Bm7 G A) throughout, with a
borrowed ♭VI (B♭) in the bridge; it never modulates. A one-bar window holding mostly
Bm7 or G scores best as B minor / G major / F♯ minor because those share D major's pitch
set — the relative/neighbour keys are near-ties, and the 2-bar smoothing cannot absorb them.
Side bug: smoothing merges short regions without re-coalescing, so equal neighbours remain
(`116 D major`, `188 D major`; `208/224 B minor`) — redundant key flags on the progress bar.

So there are two defects, and fixing only one leaves the other:

1. **Inference** invents modulations (wrong for every key consumer: chord-chart,
   chord-overlay, progression, spelling, key flags, key readout).
2. **Chord list** is a whole-song aggregate with no beat of its own, yet borrows a
   per-beat key — even with perfect inference, a song that really modulates would get a
   list whose rows are numbered in different keys.

## Plan

### 1. `theory/core/key-detect.ts` — modulations must be earned

Keep Krumhansl–Schmuckler and the output shape (derived `key` annotations), change how
regions are decided:

- **Home key first.** The global best (`globalBest`, already computed) is the incumbent.
- **Wider evidence.** Score each bar on a centred window of several bars
  (`MODULATION_WINDOW_BARS`, e.g. 4) rather than the bar alone, so one Bm7 bar is not a
  histogram.
- **Hysteresis.** A window switches away from the incumbent only when the challenger beats
  the *incumbent key's own correlation on that window* by a margin
  (`MODULATION_MARGIN`, e.g. 0.1) — not merely when it is the argmax. Relative / one-
  accidental neighbours are near-ties, so they never clear it; a real modulation does.
- **Minimum region** raised to a phrase (`MIN_REGION_BARS` 2 → 4), and a final
  **re-coalesce pass** after smoothing so equal adjacent regions become one (fixes the
  duplicate entries).

Constants stay named and documented at the top of the file. No consumer changes.

### 2. `score/core/key-context.ts` — a `songKey(score)` resolver

Add `songKey(score): KeyEntry | undefined` — the song's home key: the key entry covering
the **most beats** (ties → earliest), using the same `collectKeyEntries` so it agrees with
everything else by construction. For an authored single key it is that key; for a keyless
score, `undefined`. Exported from the `score/core` barrel next to `effectiveKeyAt`.

(Derived from entries rather than stored, so there is no second source of truth for
"the key".)

### 3. `rich/chord-list` — one key for the whole list

`distinctChords` takes `songKey(score)?.key ?? null` once and passes it to every
`chordBoxFace`, replacing the per-first-occurrence `effectiveKeyAt`. Update the component
doc comment (rows are numbered and coloured in the song's key). Per-beat views
(chord-chart, chord-overlay, chord-progression, chord-readout) keep `effectiveKeyAt` — a
timeline cell *should* follow a real modulation.

Not changed: `key-readout` keeps showing the key at the playhead (with a fixed inference
that is the home key for this song; in a genuinely modulating song it correctly tracks).

### 4. Tests

- New `theory/core/key-detect.test.ts` (pure, bun):
  - I–vi–IV–V loop in D, chords on varied durations (incl. bars dominated by Bm7 / G) →
    exactly one key entry, D major.
  - A clear modulation (8 bars C major → 8 bars E♭ major) → two entries, boundary at bar 8.
  - Borrowed ♭VI bridge (the *Là-bas* bridge shape) inside D → still one entry.
  - No equal adjacent regions in any output.
- `score/core` test for `songKey`: picks the longest-covering entry; authored key wins;
  `undefined` for keyless.

## Critical files

- `plugins/apps/plugins/sonata/plugins/theory/core/key-detect.ts`
- `plugins/apps/plugins/sonata/plugins/score/core/key-context.ts` (+ `score/core/index.ts` barrel)
- `plugins/apps/plugins/sonata/plugins/rich/plugins/chord-list/web/components/chord-list.tsx`

## Verification

1. `./singularity test plugins/apps/plugins/sonata/plugins/theory plugins/apps/plugins/sonata/plugins/score`
2. `./singularity build`, open *Là-bas* in this worktree's deploy: Current key = D major;
   chord list reads D = I, Bm7 = vi⁷, G = IV, A = V with matching colours; the progress
   bar shows no key flags past the start.
3. Screenshot both sections with `e2e-harness/e2e/screenshot.ts --path <song route>`.
4. Spot-check a MIDI song with an authored key and one known modulating song: unchanged
   key, and the modulation still detected.
