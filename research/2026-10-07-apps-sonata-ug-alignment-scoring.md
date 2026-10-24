# Sonata — UG alignment D: scoring that holds on the hard recordings, and a pick that compares

Follow-up of task C ([`2026-10-07-apps-sonata-ug-alignment-video.md`](2026-10-07-apps-sonata-ug-alignment-video.md),
"Results"). It builds on B's aligner and its calibration
([`2026-10-01-apps-sonata-ug-alignment-aligner.md`](2026-10-01-apps-sonata-ug-alignment-aligner.md)).

## Context

In C's 10-song run, two songs failed:

- **Skinny Love.** The studio art track scored 0.486, just under 0.5, so a live
  bootleg at 0.676 was accepted.
- **Shape Of You.** Three uploads of the studio audio scored 0.42–0.45, so
  nothing was accepted.

B's calibration had right recordings at 0.70–0.91 and wrong ones at ≤ 0.34.
Those were four clean, dense pop recordings, so that gap was never tested on
hard recordings.

**Goal:**

- On the 10-song set, every right recording aligns above a threshold that every
  wrong pair stays below.
- The pick prefers the higher-ranked recording when two are close.

**Measured on:**

- the full 10 × 10 matrix (each song's sheet against every song's recording);
- B's 4 × 5 matrix.

## Diagnosis (measured 2026-10-07, before any change)

These numbers come from `scripts/calibrate.ts` on the cached
`v2/final0-fastchroma` features, using the tabs stored in C's deploy DB
(`att-1791333308-3vyx`).

The score is `fit × coverage`:

- `fit = (constrained − base) / (free − base)`;
- `coverage` is the share of the sheet's *written* chord tokens that the path
  visits.

| Sheet × recording | constrained | free | base | fit | coverage | score |
|---|---|---|---|---|---|---|
| Skinny Love × studio `95FyXUHv8hk` | 0.643 | 0.721 | 0.362 | 0.78 | **0.62** | 0.486 |
| Skinny Love × live `5l8otWSs3Ro` | 0.528 | 0.632 | 0.305 | 0.68 | 0.99 | 0.676 |
| Shape Of You × `JGwWNGJdvx8` | 0.391 | 0.498 | 0.303 | **0.45** | 0.99 | 0.446 |
| Shape Of You × `_dK2tDK9grQ` | 0.387 | 0.494 | 0.302 | 0.44 | 0.96 | 0.425 |

The two misses fail in different terms of the score.

### 1. Shape Of You: the free reference overfits a sparse mix

The path itself is right. With `--chords`, every chord of the C#m F#m A B loop
takes 2 beats at 96 BPM, and the sections land where the song's do. Only the
score is low.

The cause is the free decode. It may switch to any of the 24+ triads on any
beat at no cost: `ADVANCE = 0`, plus the change prior. On thin chroma
(marimba, voice, little sustained harmony) it follows the melody beat by beat.
That gives it a gain the sheet can never match, so `fit` measures how noisy the
mix is, which is exactly what `fit` was meant to cancel.

A numpy replica of `freeDecode` (scratch, 24 triads, no sheet shapes) with a
per-switch cost `s` charged only in the free decode:

| Recording | free @ s=0 | s=−0.2 | s=−0.4 | base |
|---|---|---|---|---|
| Shape Of You `JGwWNGJdvx8` | 0.498 | 0.406 | 0.345 | 0.303 |
| Let It Be `QDYfEBY9NM4` | 0.734 | 0.642 | 0.563 | 0.305 |
| Someone Like You `hLQl3WQQoQ0` | 0.710 | 0.667 | 0.628 | 0.317 |
| Never Gonna `dQw4w9WgXcQ` (negative) | 0.525 | 0.442 | 0.394 | 0.310 |

At s = −0.2, Shape Of You's fit rises from 0.45 to about 0.85.

**Why charging it only in the free decode is principled.** In an HMM, the sheet
gives exactly one next chord, while the free model spreads a switch over V
chords. So each free switch costs about log V more than an advance on the
sheet.

**The risk.** A large `s` saturates `fit` towards 1 for wrong pairs too, and
then only `coverage` separates them. `s` must therefore be chosen on the full
matrix, not on the misses.

### 2. Skinny Love: coverage counts written copies, and the path loops verses

The studio path is Intro, V1, V2, V1, V2, Chorus (2:25), V3, V1, V2. It never
reaches Chorus [6], the Outro or the Coda. The live path walks the sheet in
order.

Two separate problems:

- **Coverage counts copies.** The tab writes the Chorus out twice with
  identical chords, and the Coda is a copy of the Intro. Playing chorus #1 twice
  instead of chorus [6] is the same music, but it loses 33 of the 98 written
  tokens.
  - Counting a token as covered when *any token with the same content* was
    played (same line chord sequence and position) gives about 59/65 = 0.91.
  - The score would then be about 0.71.
- **The structure is probably wrong.** A verse block ending at the expected
  "chorus" can jump to Verse 1 for `SAME_NAME = −1.5`, because all verses
  normalise to "verse". That is cheap enough to cycle verses instead of taking
  the chorus.
  - The recording is tuned −39 cents (a quarter step down; UG's note says so).
    The chroma is tuning-compensated, but −39 is near the ±50 bin edge.
  - Whether the chorus emits poorly here, or the jump is just too cheap, needs
    the per-bar view below. It is not settled yet.

### 3. Accept rule: the first pass wins, whatever its rank

`walkCandidates` (`server/internal/decide.ts`) accepts the first candidate that
reaches `WEAK_MATCH_THRESHOLD` and stops.

The bootleg ("Skinny Love (Glastonbury 28-06-09)") carries **no** version term,
so the ranker never penalised it. A "skip version-penalised candidates" rule
would not have caught it. What is missing is a comparison: a near-miss on the
higher-ranked candidate should be weighed against a pass on a lower-ranked one.

A related gap: after an aligner change, an auto-picked row only re-aligns its
*chosen* video (`decideWork`'s align arm). A better scorer would never
reconsider Skinny Love's bootleg.

### Other weak spots (from B, to measure, not presumed)

- **Sheets that write fewer chords than are played** (Wonderwall). It still
  scores 0.87. A fix only lands if it does not narrow the matrix.
- **Tempo-octave grids.** Take On Me runs at 163 BPM, Hallelujah at 168 and
  Someone Like You at 131. They align, and nothing shows them hurting the
  score.
- **Take On Me 0.559.** The most-voted tab (1842621) is the MTV Unplugged
  arrangement, so this is a sheet/recording version mismatch, not an aligner
  failure. It is labelled as such in the set, not tuned for.

## Plan

### Step 1: a calibration set and a matrix mode for `calibrate.ts`

Today the matrix is hand-assembled from loose files. Make it repeatable:

- **Manifest.** `alignment/scripts/calibration-set.ts` holds, per song, the UG
  `tabId`, its capo, and labelled recordings: `right`,
  `right-other-arrangement` (Take On Me album vs. the unplugged sheet) and
  `other-version` (Skinny Love's bootleg).
  - The rows are C's 10 songs plus B's Take On Me 390284 (original key).
  - It holds no tab content or audio, only ids.
- **Inputs.**
  - The tabs are fetched once through the deploy's
    `POST /api/sonata/sources/ultimate-guitar/fetch` into
    `~/.singularity/cache/ug-calibration/<tabId>.json`.
  - The features come from the beat-features cache. All 15 videos involved are
    cached today.
  - Nothing copyrighted lands in the repo.
- **`--set` mode prints:**
  - the full sheet × recording matrix;
  - per term: fit, coverage, free, constrained;
  - the **separation**: min right, max wrong, the margin between them, and the
    worst pair on each side;
  - a **pick simulation**: each song's stored candidate order run through the
    accept rule, showing which video it would choose.
- **`--bars` view** for one pair: per bar, the path chord, the best sheet chord
  and the best triad, with their correlations. This is what tells "the chorus
  emits poorly" apart from "the jump is too cheap" for Skinny Love.

The baseline run is recorded in this doc before any constant moves.

### Step 2: aligner scoring (`core/internal/align.ts`, `templates.ts`)

Take each change only if it widens the separation on the full set without
making any right pair worse than "weak". In order:

1. **A switch cost in the free reference** (`FREE_SWITCH`, swept over
   −0.05 … −0.4). It is charged in `freeDecode` only, as above. It targets
   Shape Of You.
2. **Coverage by content.**
   - `sheetCoverage` keys a written token by its content: the line's shape
     sequence and the token's position in it. Copies of a section, and a Coda
     that repeats the Intro, count once.
   - The written set is deduplicated the same way.
   - Wrong pairs still lose coverage when they repeat *one* block, because the
     other distinct blocks stay unvisited.
   - It targets Skinny Love's 0.62.
3. **Structural moves, only if `--bars` shows the jump is at fault.** Price a
   back-jump to an *earlier* same-named block above the expected forward one,
   e.g. split `SAME_NAME` into forward and backward costs. Verify that Skinny
   Love studio then takes Chorus → V3 → Chorus → Outro, and that the B
   timelines (Let It Be, Wonderwall, Someone Like You, Take On Me) do not
   move.
4. **Optional: passing-chord insertion for under-written sheets** (Wonderwall).
   Within a token, allow a short excursion to any triad at a cost, returning to
   the same token. Kept only if the matrix margin does not shrink. Otherwise it
   is dropped and noted as a known limit.

Then:

- **Threshold.** Set `WEAK_MATCH_THRESHOLD` midway in the new margin, and
  record it with the matrix.
- **Version.** Bump `ALIGNER_VERSION`. Every stored record becomes stale by
  construction (`fitsSheet` / `stale`), so nothing is invalidated by hand.

**Tests** (`align.test.ts`, synthetic `synthFeatures`):

- a sheet that writes its chorus twice, played as chorus #1 twice, has
  coverage 1;
- a sparse fast loop with melody-like noise (2-beat chords, low SNR) scores at
  or above the threshold;
- the existing wrong-video test still scores below.

### Step 3: the pick compares (`server/internal/decide.ts`)

`walkCandidates` gains a pure `choose(tried)` rule, unit-tested in
`decide.test.ts`:

- **Confident accept.** The best-ranked tried candidate scoring ≥ threshold is
  accepted at once. This is today's behaviour on the 8 songs that worked, so it
  costs no extra downloads.
- **Near-miss band** `[NEAR_MISS, threshold)`, with `NEAR_MISS` calibrated just
  above the max wrong score.
  - A near-miss does not end the walk.
  - A lower-ranked candidate that passes is accepted only if it beats every
    higher-ranked near-miss by `RANK_MARGIN`. Otherwise the walk continues.
- **At the end of the walk** (`MAX_TRIES_PER_RUN`, still 3), take the best
  value among the tried candidates, where value = score with an earlier rank
  winning within `RANK_MARGIN`:
  - if that value is ≥ threshold, accept;
  - if it is a near-miss, `needs-video` as today, playing that candidate (the
    best try).

**Re-pick on an aligner change.** In `decideWork`, a row with
`pick: "auto"` whose record is stale because the *aligner* changed (not the
sheet) goes to the resolve arm with `retry: true`.

- `retryScored` puts the tried candidates back to untried.
- Their features are cached, so the walk downloads nothing.
- `pick: "user"` keeps today's behaviour and only re-aligns its video.
- Tests in `decide.test.ts`.

### Step 4: re-run and record

- **Calibration.** `calibrate.ts --set`: the matrix, the separation and the
  pick simulation, written into this doc next to the baseline.
- **Deploy.**
  - Build in the background. After the deploy, the version bump re-resolves
    every song in the worktree DB on its next trigger, using "Find a video" or
    re-align where nothing triggers it.
  - Then the 10-song table from C, with the new chosen video, score and
    outcome. Expected: Skinny Love → `95FyXUHv8hk`, Shape Of You →
    `JGwWNGJdvx8`, the other 8 unchanged.
- **Timelines.** Spot-check with `--chords` for Skinny Love and Shape Of You,
  plus B's four reference timelines (they must not regress).

## Critical files

Under `plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/`:

- `core/internal/align.ts`: `freeDecode`, `sheetCoverage`, the jump costs, and
  `alignWithDiagnostics` (more diagnostics for `--bars`).
- `core/internal/record.ts`: `ALIGNER_VERSION`.
- `core/index.ts`: `WEAK_MATCH_THRESHOLD`, and `NEAR_MISS` / `RANK_MARGIN` if
  the web needs them for labels.
- `core/internal/align.test.ts` and `core/testing/synth-features.ts`.
- `server/internal/decide.ts` and `decide.test.ts`: the `choose` rule, and the
  re-pick on an aligner change.
- `scripts/calibrate.ts`, plus the new `scripts/calibration-set.ts`.

Reused as-is:

- `retryScored`, `walkCandidates`' hooks;
- `stale()` / `fitsSheet`;
- `synthFeatures`;
- the UG fetch endpoint;
- the beat-features cache.

## Verification

- `./equin test plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment`.
- `./equin run …/alignment/scripts/calibrate.ts --set`. Pass when:
  - min right > max wrong with a margin no narrower than B's 0.35 (or the
    difference explained);
  - all 10 right recordings are ≥ threshold, with the unplugged-arrangement
    pair reported separately;
  - the pick simulation chooses the studio recording for all 10.
- On the deploy: the 10-song table re-run as above, and the Recording section
  for Skinny Love and Shape Of You showing "picked automatically" on the
  studio video.

## Out of scope

- The ranking itself: it already put the studio recording first in all 10.
- New candidate sources, e.g. making Hooktheory's Topic video for Shape Of You
  reachable in a worktree.
- The play-time issues listed in C's "Open issues".

## Results (2026-10-07)

`calibrate.ts --set` runs 11 sheets (C's 10 songs plus B's original-key Take
On Me 390284) against 17 recordings (every candidate with cached features,
plus `dQw4w9WgXcQ` as a negative). That gives 15 right pairs, 169 wrong
pairs, and 3 pairs reported apart: the Skinny Love bootleg and the
unplugged-sheet Take On Me pairs.

### Baseline: what the wider matrix showed

B's 4 × 5 matrix put wrong pairs at ≤ 0.344. The 11 × 17 matrix does not:

| | min right | max wrong | right < 0.5 | wrong ≥ 0.5 |
|---|---|---|---|---|
| Baseline (aligner v1, threshold 0.5) | 0.418 (Shape Of You) | 0.753 (Hallelujah sheet × Someone Like You) | 4 / 15 | 7 / 169 |

- **Common progressions.** Sheets built on the I, vi, IV and V chords
  (Hallelujah, Riptide, Let It Be) fit other songs that use those chords. The
  HMM's free durations bend one order onto another: Hallelujah × Someone Like
  You flicks through unwanted sheet chords for one beat each, so coverage
  reads 1.00.
- **Global separation is impossible from chroma alone** for a loop song. Shape
  Of You's C#m F#m A B loop fits any recording of that loop.
- **What the threshold is for.** The resolver only aligns candidates that
  already matched the song's title and artist. So it has to reject a wrong
  video of the song, and the measure that matters is **per sheet**: the right
  recording against every wrong one.

### What was tried and dropped

| Idea | Why it was dropped |
|---|---|
| A per-change cost in both decodes (penalises 1-beat flicks) | It sinks fast-changing right songs: Shape Of You fell to 0.05 at −0.2, and Hallelujah × Someone Like You stayed at 0.66. |
| Coverage by line content | It collapses a loop sheet to one line: Shape Of You's sheet × Skinny Love's live recording rose to 0.79. |
| Coverage by section content | +0.05 on Skinny Love, but +3 wrong pairs ≥ 0.5. |
| A permutation null (chords relabelled, how much the true order wins) | It does not separate. A loop relabelled one step round the loop is the same sequence shifted in time (Shape Of You order gain 0.007), while Livin' On A Prayer × Someone Like You gained 0.43. |
| Full root credit for every slash bass | It fixed Skinny Love, but moved Let It Be's verse one beat off the downbeat (C/E read as C). |

### What landed (aligner v2)

| Change | Where | Effect |
|---|---|---|
| `FREE_SWITCH = −0.15`: the free reference pays per chord change (the sheet names the next chord; the free model picks among 24+) | `freeDecode` | Shape Of You fit 0.45 → 0.72 |
| `SAME_NAME_BACK = −3.5` (forward stays −1.5): a jump *back* to an earlier same-named block costs more | `buildStateSpace` | Skinny Love studio stops cycling verses: coverage 0.62 → 0.86 |
| A non-chord-tone slash bass (`C/B`, `Am/G`) counts its root as well; inversions (`C/E`) keep their bass | `bassTerm`, both decodes | Skinny Love studio walks its sheet in order (Intro 0:01, V1 0:34, V2 0:58, Chorus 1:30, V3 1:48, Chorus 2:26, Outro 3:01, Coda 3:13): 0.857 |
| `WEAK_MATCH_THRESHOLD` 0.5 → 0.6 | `record.ts` | |
| `ALIGNER_VERSION` 1 → 2 | `record.ts` | |

B's reference timelines are identical to v1, section by section: Let It Be,
Wonderwall, Someone Like You, Take On Me (album). So are Livin' On A Prayer,
Hotel California, Hallelujah, Riptide and Shape Of You.

| | min right | max wrong | right < 0.6 | wrong ≥ 0.6 | min per-sheet margin |
|---|---|---|---|---|---|
| v1, threshold 0.5 | 0.418 | 0.753 | 4 / 15 (< 0.5) | 7 / 169 (≥ 0.5) | −0.071 (Shape Of You) |
| **v2, threshold 0.6** | **0.679** | 0.823 | **0 / 15** | **6 / 169** | **+0.091** (Shape Of You) |

The right pairs now: Let It Be 0.83, Wonderwall 1.00 ×3, Someone Like You 0.99,
Take On Me 0.89 / 0.86, Livin' On A Prayer 0.93, Skinny Love 0.85, Hotel
California 1.00, Hallelujah 0.94, Shape Of You 0.71 / 0.68 / 0.68, Riptide
1.00. Apart from them:

- Skinny Love's bootleg: 0.76.
- The unplugged-sheet Take On Me pairs: 0.64 / 0.63.

Per sheet, every right recording beats every wrong one:

| Sheet | Margin |
|---|---|
| Let It Be | 0.38 |
| Wonderwall | 0.51 |
| Someone Like You | 0.33 |
| Take On Me | 0.37 |
| Livin' On A Prayer | 0.37 |
| Skinny Love | 0.38 |
| Hotel California | 0.50 |
| Hallelujah | 0.12 |
| Shape Of You | 0.09 |
| Riptide | 0.22 |

The 6 wrong pairs ≥ 0.6 are all common-progression sheets:

- Hallelujah × Someone Like You 0.82, × Livin' On A Prayer 0.66, × Skinny
  Love's bootleg 0.61;
- Riptide × Never Gonna 0.79, × Let It Be 0.64;
- Someone Like You × Livin' On A Prayer 0.66.

### The pick (`chooseCandidate`, `core/internal/accept.ts`)

- **When it decides.** Once a tried candidate reaches the threshold, it takes
  the highest-ranked try within `RANK_MARGIN = 0.1` of the best. Uploads of
  the same audio score within about 0.03 of each other.
- **No extra downloads.** Lower-ranked candidates are never tried just to
  compare: they could only win by beating the pass by more than the margin.
- **Re-pick on an aligner change.** A new `ALIGNER_VERSION` re-picks an
  auto-chosen video. It releases the video and retries the scored candidates,
  whose features are cached. A user's video is only re-aligned.
- **Simulation on the set:** every song accepts its rank-0 candidate, the
  studio recording, on the first try. That includes Skinny Love (was: the
  bootleg) and Shape Of You (was: `needs-video`).

### Known limits

- **`fit` saturates at 1.0** for clean recordings (Wonderwall, Hotel
  California, Riptide), so the score no longer orders the versions of a
  well-aligned song. The pick leans on rank there, which is what the ranking
  is for.
- **Common-progression sheets.** About 4 % of cross-song pairs still pass. A
  real fix needs evidence beyond chroma: lyric timing against the sheet's
  lyric lines, or duration consistency across a section's repeats.
- **Untuned.** Sheets that write fewer chords than are played (Wonderwall) and
  tempo-octave grids showed no problem on this set, so nothing was changed for
  them.

### On the deploy (`att-1791404339-e10b`)

- **What ran:** Skinny Love (835053) and Shape Of You (1928431), created
  through `POST /api/sonata/songs/ultimate-guitar` with no video given.
  `tabSaved` started the resolver, which searched YouTube itself.
- **Skinny Love:** the walk tried #0 `95FyXUHv8hk` (the Bon Iver art track),
  scored 0.853 and picked it. The live bootleg was not tried.
- **Shape Of You:** the walk tried #0 `JGwWNGJdvx8` (the official video),
  scored 0.710 and picked it. Before, this song ended in `needs-video`.
- Both pick the studio recording on the first try.
