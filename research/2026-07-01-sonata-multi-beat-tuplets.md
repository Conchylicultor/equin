# Sonata notation — multi-beat tuplets & 5/7/12 ratios

## Context

The notation lens engraves eighth-triplets (3) and sixteenth-sextuplets (6), but
only within a **single quarter-note beat window** and only for ratios 3 and 6.
Everything else is approximated to the binary 16th/32nd grid:

- **Multi-beat tuplets** — a quarter-note triplet over 2 beats, a half-note
  triplet over 4 beats — because the detector's window is hard-fixed at 1.0 beat.
- **Other ratios** — quintuplets (5), septuplets (7), 32nd-triplets (12) — because
  the ratio list is `[3, 6]`.

The adaptive-subdivision detector in
`plugins/apps/plugins/sonata/plugins/notation/web/internal/rhythm.ts` was built to
extend here: "its window set and tuplet-ratio list are the two knobs." This plan
turns those two knobs and fixes the one downstream formula that only happened to
be correct at `len === 1`.

Nested tuplets remain out of scope (a follow-up).

## Design

### Two knobs (`rhythm.ts`)

```ts
/** Candidate window lengths in real beats, LARGEST first. 1.0 is the base
 *  window (binary + sub-beat tuplets); >1 lengths only ever CLAIM a tuplet. */
const WINDOWS = [4, 2, 1] as const;

/** Tuplet ratios to probe (notes in the group), coarsest-ish first. */
const TUPLET = [3, 5, 6, 7, 12] as const;
```

`inSpace` (VexFlow `notes_occupied`) stays `largestPow2AtMost(num)`:
3→2, 5→4, 6→4, 7→4, 12→8 — the standard 3:2, 5:4, 6:4, 7:4, 12:8 conventions.

### Greedy largest-window scan (`planWindows`)

Replace the fixed `for (wStart += WINDOW)` loop with a greedy scan that, at each
beat-aligned position, tries multi-beat tuplet windows **largest-first** before
falling back to the existing 1-beat (or trailing-partial) decision:

```
pos = barStart
while pos < barEnd:
  for L in WINDOWS where L > 1, largest first:
    if pos + L <= barEnd and isAligned(pos, barStart, L):
      w = tryMultiBeatTuplet(pos, L, fracsFor(onsets, pos, L))
      if w: emit w; pos += L; continue outer
  # base case — full binary + sub-beat-tuplet logic (unchanged decideWindow)
  len = min(1, barEnd - pos)
  emit decideWindow(pos, len, fracsFor(onsets, pos, len))
  pos += len
```

- `isAligned(pos, barStart, L)` — `(pos - barStart) / L` is (near) integer, so a
  2-beat window sits on even beats and a 4-beat window on multiples of 4. Keeps a
  tuplet on a metric boundary and prevents straddling windows.
- Largest-first + "multi-beat windows only ever return a tuplet (never binary)"
  is what makes it conservative: a 2/4-beat window is *claimed* only when a real
  multi-beat tuplet lives there; otherwise it declines and the per-beat scan runs
  exactly as today.

### `tryMultiBeatTuplet(start, len, fracs)` → `RhythmWindow | undefined`

Mirrors `decideWindow`'s tuplet branch but returns a tuplet or nothing:

- `< 2` onsets → `undefined` (a tuplet needs ≥2 onsets to be defined).
- Compute `binErr = min(errFor(fracs,S16), errFor(fracs,S32))` at this window's
  scale (`S16 = round(len*4)`, `S32 = round(len*8)`).
- **Odd ratios only**: `TUPLET.filter(r => r % 2 === 1)` → `[3, 5, 7]`. An even
  ratio over a 2^k-beat window (6 over 2 beats, 12 over 2 beats) decomposes into
  two per-half-window tuplets (two eighth-triplets, two sextuplets) — the simpler
  reading the per-beat scan already produces — so it must not be claimed as one
  multi-beat group. Oddness is the exact "cannot split evenly" condition.
- Pick the first ratio that **both** fits *and* strictly beats binary by margin:
  `errFor(fracs,S) <= TOL*n + EPS && errFor(fracs,S) + MARGIN*n < binErr`.

### Base `decideWindow` (1-beat) — ratio list widens for free

`decideWindow` keeps its structure; it just reads the widened `TUPLET`
`[3,5,6,7,12]`, so quintuplets/septuplets/32nd-triplets in a single beat now
engrave too. Change its tuplet pick to the **combined predicate** (fits AND beats
margin) instead of `find(fits)` then a separate margin check — strictly more
correct (a coarse ratio that fits-but-fails-margin no longer masks a finer ratio
that would pass) and preserves every existing test. Keep the `len >= 1 - EPS`
gate so trailing partials stay binary.

Guard against 12 (a very fine grid) swallowing clean 16ths: clean sixteenths lie
exactly on the 12-grid (`0.25 = 3/12`) so `fits(12)` is true, but `binErr === 0`
so `MARGIN` blocks the claim. Verified. 32nds (`0.125`) sit `0.0417` off the
12-grid, just above `TOL = 0.04`, so they don't collapse either.

### One downstream formula fix (`convert.ts` `buildBarStaff`)

The tuplet notated-value math is only correct at `len === 1` today:

```ts
// BEFORE (correct only when groupWin.len === 1)
const baseNotatedBeats = tup ? 1 / tup.inSpace : 0;
const notatedScale     = tup ? (groupWin.len * tup.inSpace) / groupWin.cells : 1;
// AFTER (general; identical values when len === 1)
const baseNotatedBeats = tup ? groupWin.len / tup.inSpace : 0;
const notatedScale     = tup ? tup.inSpace / groupWin.cells : 1;
```

`realBeats = baseNotatedBeats * notatedScale = len/cells` for both, so playhead/
seek (which use REAL beats) are unaffected; only the *notated* duration token fed
to `decomposeDuration` changes. At `len===1` both forms give the old numbers, so
existing `convert` output is byte-identical. For a quarter-triplet (`len 2`,
`inSpace 2`, `cells 3`) `baseNotatedBeats = 1.0` (quarter) — the correct notation;
the old form gave `0.5` (eighth) with a `4/3` scale that mis-sized the note.

No change to `durations.ts` (TABLE already reaches whole↔32nd), `grace.ts`, the
group-coalescing loop (a multi-beat window is one `winIndex`, so its cells form
one run-group and get one `tuplet.id = w<start>`), `engrave.ts` `buildTuplets`
(reads `num`/`inSpace` generically; Voice is `SOFT` so tuplet tick sums are fine),
or `notation.tsx`.

## Files

- `…/notation/web/internal/rhythm.ts` — knobs + greedy scan + `tryMultiBeatTuplet`
  + combined predicate. (primary)
- `…/notation/web/internal/rhythm.test.ts` — new cases (below).
- `…/notation/web/internal/convert.ts` — the two-line formula fix in `buildBarStaff`.
- `…/notation/CLAUDE.md` — update the Rhythm section + "Tuplet scope" caveat.

## Verification

`bun test plugins/apps/plugins/sonata/plugins/notation/web/internal/rhythm.test.ts`
and `…/convert.test.ts` (regression). New rhythm cases:

- Quarter-note triplet over 2 beats — `planWindows([0, 2/3, 4/3], 0, 4)`: first
  window `{start:0, len:2, cells:3, tuplet:{num:3, inSpace:2}}`.
- Half-note triplet over 4 beats — `planWindows([0, 4/3, 8/3], 0, 4)`: one window
  `{start:0, len:4, cells:3, tuplet:{num:3, inSpace:2}}`.
- Quintuplet in a beat — `[0,.2,.4,.6,.8]` → `cells:5, tuplet:{5, inSpace:4}`.
- Septuplet in a beat — 7 even onsets → `cells:7, tuplet:{7, inSpace:4}`.
- 32nd-triplet (12) in a beat — 12 even onsets → `cells:12, tuplet:{12, inSpace:8}`.
- Regressions: two eighth-triplets over 2 beats (`[0,1/3,2/3,1,4/3,5/3]`) must
  stay **two 1-beat triplets**, not one 6/12-tuplet; clean 16ths stay binary; the
  existing suite passes unchanged.

Then `./equin build` and screenshot the `seed-rhythm-etude` starter (extend
it with a multi-beat triplet if none present) to confirm brackets render.
