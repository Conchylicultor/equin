# Sonata — UG alignment B: aligner + Sonata integration

Task B of [`2026-09-29-apps-sonata-ug-sheet-alignment.md`](2026-09-29-apps-sonata-ug-sheet-alignment.md).
Builds on task A's beat features ([`2026-09-30-infra-audio-analysis-beat-features.md`](2026-09-30-infra-audio-analysis-beat-features.md)).

## Context

A UG sheet imported into Sonata has the right chords and invented timing:
`compile()` (`sources/ultimate-guitar/web/compile.ts`) synthesizes 4/4 at 100 BPM
from lyric length. Task A gives cached per-beat features for any YouTube
`videoId` (`ensureBeatFeatures(videoId, exec)`). This task aligns the sheet's
fixed chord sequence to those beats, stores the result per song, and compiles
the `Score` from it, so the song plays on the recording's real beats.

Done when a UG song with a hand-pasted YouTube link opens with its chords on the
recording's beats, and unit tests cover repeats, transposition and an omitted
section. Choosing the video automatically, and the YouTube player as the clock,
are task C.

## Facts the design rests on

- `Sonata.Source.compile(raw: unknown) => Score` is pure and synchronous.
  Raw comes from `Library.Source.hydrate(songId)` once at open, then
  `setSourceRaw(id, raw)`. Every raw change recompiles all sources and resets
  playback (`contentScore` identity).
- `mergeScores`: the first non-empty `tempoMap` / `timeSigMap` wins, so UG
  keeps owning tempo. A tempo map is piecewise-constant bpm, with seconds
  anchored at the first event, so it must start at beat 0. Nothing caps its
  length, and the hot paths use `TempoIndex` (O(log n)), so 400–650 events are
  fine.
- `ensureBeatFeatures` needs an `ExecContext`, which only a supervised job's
  `run` body or the CLI can mint. A supervised `run` body boots the full plugin
  graph, so it can read and write the DB and run the pure aligner directly.
  Audio analysis emits no completion event, so the chain job awaits it inline,
  as A's doc intends.
- The UG persist observer saves on every raw change after open. Pushing an
  alignment into raw must not look like a sheet edit.
- Reusable pieces:
  - `youtubeVideoId(raw)` (`integrations/youtube/core`) parses pasted links.
  - `parseChordSymbol` / `qualityToIntervals` (`sonata/theory/core`) give
    chord pitch-class templates.
  - `transposeScore` (`theory/core`).
  - `jsonField` (`fields/json/config/core`) for a zod-decoded jsonb column.
  - `defineExtension` (`infra/entity-extensions`) for the side-table.
  - `liveCollection` + `serveCollection` + `useLiveRow` for the record
    (pattern: `conversations/conversation-progress`).
  - `defineTriggerEvent` + `Trigger` (`infra/events`).
- Real fixtures exist host-wide:
  `~/.singularity/cache/beat-features/v2/final0-fastchroma/{QDYfEBY9NM4,FVdjZYfDuLE,hLQl3WQQoQ0,MIgK3zOk0zg,dQw4w9WgXcQ}.json`.

## Plugin layout

A new child `sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment`.
Import edges: UG web → alignment core → UG core; alignment server → UG server.
The graph stays a DAG. UG server never imports alignment; it emits an event
that alignment subscribes to.

```
alignment/
  core/
    align.ts          alignChords(sheet, features, opts) → AlignmentResult   (pure, the HMM)
    templates.ts      chord → 12-bin pitch-class + bass template; beat emission scores
    sheet.ts          ParsedTab → AlignSheet (sections of chord tokens; empty repeat sections
                      inherit chords from the same-named earlier section; "x2" repeat hints)
    record.ts         AlignmentRecordSchema (contract 2), ALIGNER_VERSION, sheetHash(content)
    aligned-score.ts  alignedScore(parsed, record, title) → Score (tempoMap/timeSig/annotations)
    endpoints.ts      get / set-video / realign endpoint contracts
    testing/          synthFeatures(chordSeq, opts): synthetic BeatFeatures for tests
  shared/resources.ts liveCollection("sonata-ug-alignment", { row, id: "songId" })
  server/
    tables.ts         sonata_songs_ext_ug_alignment (defineExtension on _songs)
    job.ts            sonata.ug-alignment.align (defineSupervisedJob, lock = songId)
    routes.ts         set video (URL → videoId, enqueue), realign, get
    index.ts          serveCollection, Trigger on UG's tab-saved event → job
  web/
    alignment-section.tsx  Sonata.Section "Recording" (area editor) + collapsed summary
    alignment-sync.tsx     Sonata.Effect: useLiveRow → setSourceRaw(UG, {...raw, alignment})
```

## Contract 2: the alignment record

The record follows the vision doc's contract 2, with `sheetHash` added.

```ts
AlignmentRecord = {
  alignerVersion: number;
  videoId: string;
  analysisVersion: number; settingsKey: string;  // which features it used
  sheetHash: string;                 // sha of tab.content it was aligned against
  durationSec: number;
  beats: { t: number; downbeat: boolean }[];     // the grid used (chroma dropped)
  transpose: number;                 // semitones, recording = sheet + transpose (capo shows here)
  segments: (                        // in performance order, covering beats [0, beats.length)
    | { kind: "chord"; section: number; line: number; chord: number; occurrence: number;
        startBeat: number; endBeat: number }     // beat indices; repeats appear once per occurrence
    | { kind: "gap"; startBeat: number; endBeat: number }   // the sheet omits this passage
  )[];
  barConfidence: number[];           // one per bar (downbeat to downbeat), 0–1
  score: number;                     // overall 0–1; what C compares candidates with
}
```

The side-table row is `{ videoId | null, status, phase | null, error | null,
record | null, updatedAt }`. `status` is one of `queued | running | aligned |
weak | failed`. The UI derives a discriminated state from it:

- **no video**
- **aligning** (phase: analysing audio / aligning)
- **aligned** (score, transpose)
- **weak match**: score below the threshold, shown as "needs a video"; the
  record is kept but not applied
- **failed** (message, retry unless permanent)
- **out of date**: the record's `sheetHash` differs from the current tab
  while a re-align runs

## The aligner (`core/align.ts`)

This is the vision doc's left-to-right HMM with jumps, decoded with Viterbi, one
decode per transposition.

- **Sheet model.** Sections in sheet order, each an ordered list of chord
  tokens (`section/line/chord` indices). An unparseable symbol (`N.C.`) is a
  token with no template, scored like the filler.
  - A UG section header with no chords whose normalized name ("Chorus 2" →
    "chorus") matches an earlier section with chords takes that section's
    tokens. This is the common "[Chorus]" written once convention.
- **States.** One per chord token, plus one **filler** state.
- **Transitions** (log-penalties, tunable constants):
  - **Stay:** stay on the token.
  - **Advance:** to the next token.
  - **Section end:** go to the next section's start (cheap), repeat the same
    section (cheap, cheaper with an `x2` hint), jump to an earlier same-named
    section (medium), jump to any section (expensive) or go to the filler
    (expensive).
  - **Filler:** stay, or enter any section start.
  - **Start:** the first section, or the filler (intro).
  - **Priors:** a small bonus for a change landing on a downbeat or half-bar.
    Minimum duration is one beat. Half and double beat grids need nothing
    special: chords just span more or fewer beats.
- **Emission** per beat and state:
  - The cosine of the beat's chroma against the chord's pitch-class template
    (root weighted above the other tones), rotated by the transposition.
  - Plus a bass term: the bass chroma at the chord's bass or root.
  - The filler's emission is a constant floor, raised when `rms` is low, so
    silence, intros and passages the sheet omits fall into it.
- **Transposition.** Run all 12 and keep the best total log-probability. A small
  prior favours `transpose ≡ capo` (UG chords are shapes over the capo).
- **Confidence.**
  - **Per bar:** the mean, over the bar's beats, of the margin between the
    path state's emission and the best other template's, squashed to 0–1.
    Filler beats count 0.
  - **Overall `score`:** the mean path emission over the non-filler beats,
    times the fraction of beats that are not filler. Calibrate it on the
    reference songs: a right video should land well above a wrong one
    (`dQw4w9WgXcQ` against another song's sheet is the negative control).
- **Cost.** About 650 beats × 300 tokens × 12 transpositions, with jump fan-out
  only at section ends. Expect tens of ms, cheap enough to re-run on every
  sheet edit.

## Compile (`alignedScore`, called from UG `compile()`)

- UG's raw becomes `UgSourceRaw = { tab: UgTab; alignment: AlignmentRecord | null }`
  (schema in UG core). The loader and editor read and write `raw.tab`.
- `compile()`:
  1. Parse `tab`.
  2. If `alignment` is present, `alignment.sheetHash === sheetHash(tab.content)`,
     and the alignerVersion is current, build the aligned Score.
  3. Otherwise fall back to today's `synthesizeScore`, unchanged. A stale
     record cannot be misapplied because it is checked by construction, not
     invalidated by hand.
  4. A weak record never reaches raw as applied: the sync effect passes it as
     `null`.
- **Tempo map.** Score beat 0 is t = 0 s, ready for C's video clock.
  - Lead-in before `beats[0].t`: `n = max(1, round(beats[0].t / firstInterval))`
    beats at `bpm = 60·n / beats[0].t`.
  - After that, one tempo event per detected beat (`bpm = 60 / Δt`), the last
    ending at `durationSec`.
- **Time signatures.** `timeSigMap` comes from the downbeats: an event wherever
  the bar length changes, and the lead-in plus the beats before the first
  downbeat form a pickup bar.
- **Annotations, in performance order.**
  - Each chord segment becomes a chord annotation `[startBeat+n, endBeat+n)`.
  - Each line occurrence becomes a lyric annotation, from its first chord's
    start to the next line occurrence's start. A lyric-only line between two
    chord lines gets an interpolated span.
  - Each section occurrence becomes a section annotation, so a repeated chorus
    appears twice.
  - Each gap becomes a section annotation named "Not in sheet".
- **Pitch.** The Score is at **sounding pitch**: `transposeScore(score, transpose)`,
  so the synth plays in the recording's key. The section shows "+2 (capo 2)",
  and the existing transpose control can still shift the display.

## Data flow and triggers

1. **Paste a link.** The Recording section takes a YouTube URL
   (`youtubeVideoId`) and calls `PUT …/ultimate-guitar/alignment { videoId }`.
   The handler upserts `videoId, status: queued` and enqueues the job.
2. **Job** (`run` body, out of process):
   1. Read the UG tab and the alignment row.
   2. With no `videoId`, finish as a no-op.
   3. Set `status: running, phase: analysing`, then
      `ensureBeatFeatures(videoId, exec, { log })`.
   4. Set `phase: aligning`, run `alignChords`, and upsert
      `record, status: aligned | weak`.
   5. On a throw, write `failed` with the message and rethrow. A
      `NonRetryableError` (an unavailable video) stays failed.
   6. Finally, if the tab's hash changed while the job ran, enqueue itself
      again.
3. **Sheet edit / import.** UG's create and update handlers emit a
   `sonata.ug.tabSaved {songId}` trigger event, but only when `content`
   changed. The alignment server binds it with a `Trigger` to the job (a no-op
   without a video). UG server stays ignorant of alignment.
4. **Player.**
   - UG `hydrate` fetches the tab and the alignment (the alignment core
     endpoint) together, so an already-aligned song opens aligned with no
     reset.
   - The `alignment-sync` Effect watches `useLiveRow` and calls
     `setSourceRaw(UG, { ...raw, alignment })` when the applied record changes,
     at most once per finished job.
   - The persist observer saves only when `raw.tab` changes identity, so an
     alignment push is never mistaken for an edit.
5. **Status.** The "Recording" `Sonata.Section` (`area: "editor"`) holds:
   - the link field;
   - the video title or id, opening on YouTube;
   - the state line (aligning…, aligned 82 % · +2 semitones, needs a better
     video 31 %, failed: msg);
   - Re-align;
   - a collapsed `summary` showing the same state.

   Its body unmounts when collapsed. Nothing in it needs to keep running,
   because the sync lives in the Effect.

## Steps

1. Alignment `core`:
   - the sheet model, templates, `alignChords`, the record schema,
     `sheetHash` and `alignedScore`;
   - `testing/synthFeatures`;
   - unit tests.
2. A calibration script (`scripts/`, run with `./equin run`): align a UG
   tab JSON against a cached features file and print the transpose, score and
   section-occurrence timeline. Tune the constants on the 4 reference songs plus
   the negative control. Record the numbers here.
3. UG:
   - `UgSourceRaw`, and `compile()` branching to `alignedScore`;
   - loader, editor, persist observer and import dialog moved onto `raw.tab`;
   - hydrate also loading the alignment;
   - the `tabSaved` event emitted from create and update.
4. Alignment `server`: the side-table, the live collection, the supervised job,
   the endpoints, and the `Trigger`.
5. Alignment `web`: the Recording section and the sync Effect.
6. Write "contract 2 as built" back into the vision doc, then a backgrounded
   `./equin build`, `./equin check`, and `./equin test` on
   both plugins.

## Tests (`alignment/core/*.test.ts`, synthetic features)

`synthFeatures` renders a chord sequence into beats: the template chroma plus
seeded noise, with downbeats every 4 beats and an optional tempo-double.

- **Plain:** a sheet played straight. Every chord starts on its beat, transpose
  0, high score.
- **Repeats:** the sheet has a chorus once (and an empty "[Chorus]" later), the
  recording plays it 3 times. The occurrences expand, and the empty section
  inherits its chords.
- **Transposition:** the recording is +3, and is found. With capo 2 and an
  ambiguous chroma, the prior picks +2.
- **Omitted section:** the recording has an 8-bar solo the sheet lacks. A gap
  covers it, and the following section still lands.
- **Double-tempo grid:** the same chords on a doubled grid align, with chords
  spanning twice the beats.
- **Wrong video:** random or unrelated chroma gives a score below the
  threshold.
- **`alignedScore`:**
  - the tempo map reproduces the beat times (`beatToSeconds(startBeat+n) ≈ beats[i].t`);
  - the lead-in and pickup bar are right;
  - a stale `sheetHash` falls back to the synthesized timing.

## Verification

- `./equin test plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar`.
- Calibration script on the reference songs: the transposes and scores are
  sensible, and the right video scores clearly above the negative control.
- Deployed worktree:
  1. Import "Let It Be" and "Wonderwall" (capo 2) from UG.
  2. Paste their YouTube links in the Recording section. It shows aligning,
     then aligned with a score and transpose.
  3. The songsheet and the piano roll show repeated choruses as separate
     occurrences.
  4. `screenshot.ts --path <song route>` before and after.
  5. By ear, play the synth alongside the YouTube video started at the same
     moment. C will do this in sync.
  6. Edit the tab (load another version): the status goes to aligning and
     re-settles.
  7. A bogus link ends `failed`, permanent.

## Known limits (left to C or follow-ups)

- **Tempo octave.** It is not corrected: a double-tempo grid gives double the
  Score beats per bar (the display shows 8/4 bars). A half-time fold is a
  possible follow-up.
- **Playback reset.** When the alignment lands while the song is open, playback
  resets once (`contentScore` changes). That is acceptable, since it happens
  once per job.
- **Threshold.** The weak-match threshold is a calibrated constant, and C
  re-uses `score` to rank candidates.

## Calibration (as built)

Run with `scripts/calibrate.ts` (`./equin run <script> <features.json>… <ug-tab.json>…`)
on the cached `v2/final0-fastchroma` features and the most-voted UG "Chords" tab of each
song: Let It Be 17427 (capo 0), Wonderwall 39144 (capo 2), Someone Like You 1006751
(capo 2), Take On Me 390284 (capo 0, the original-key tab; the most-voted one, 1842621,
is the MTV Unplugged arrangement). Every Rick Astley tab answers UG 451, so
`dQw4w9WgXcQ` serves only as a negative recording.

### What changed from the design above

- **Score.** The designed score (mean path correlation × non-filler fraction)
  did not separate right from wrong: it tracks how clean a recording's chroma is.
  Let It Be's piano recording scored 0.515 against the Someone Like You and Take
  On Me sheets, above both songs' own recordings (0.463, 0.470). The score is now
  `fit × coverage`:
  - `fit = (constrained − base) / (free − base)`, clamped to 0–1: the share of the
    gain over explaining nothing (`base`, all filler) that the sheet's sequence
    achieves, against a free decode where any of the 24 triads or the sheet's
    shapes may follow any other. It cancels the recording's chroma quality.
  - `coverage`: the fraction of the sheet's written chords the path plays. A wrong
    recording sharing one progression with the sheet fits that block well, but
    only by repeating it: Take On Me's chorus (A E/G# F#m D) against Someone Like
    You's recording has fit 0.77 but coverage 0.45.
- **One filler per block.** A gap after block `i` is its own state, left at the
  price of the jump from block `i` it stands for, so a gap after the first chorus
  resumes at the second verse rather than the first (one shared filler forgot
  where it was).
- **Repeated lines are unrolled, not looped.** A line marked "x4" is written four
  times into the block, and the end of any copy but the last may skip the rest
  (`SKIP_REPEAT`). A cheap loop let a generic line (Let It Be's solo is the whole
  song's progression) absorb the song: score 0.14. A costly one was never taken:
  Wonderwall's intro "x4" played once, its 16 extra seconds absorbed by holding
  Dsus4 for 26 beats in verse 1.
- Constants moved: `BASS_WEIGHT` 0.3 → 0.5, `FILLER_FLOOR` 0.2 → 0.3 (the pair
  that widened the margin most; a lower floor let wrong pairs avoid the filler).

### Score matrix (rows: sheet, columns: recording; transpose in brackets)

| Sheet ↓ / recording → | Let It Be `QDYfEBY9NM4` | Wonderwall `FVdjZYfDuLE` | Someone Like You `hLQl3WQQoQ0` | Take On Me `MIgK3zOk0zg` | Never Gonna `dQw4w9WgXcQ` |
| --- | --- | --- | --- | --- | --- |
| Let It Be (capo 0) | **0.697** (0) | 0.239 (4) | 0.227 (9) | 0.164 (9) | 0.216 (8) |
| Wonderwall (capo 2) | 0.112 (5) | **0.872** (2) | 0.208 (2) | 0.088 (2) | 0.108 (1) |
| Someone Like You (capo 2) | 0.193 (5) | 0.341 (2) | **0.912** (2) | 0.223 (2) | 0.190 (1) |
| Take On Me (capo 0) | 0.166 (3) | 0.293 (0) | 0.344 (0) | **0.749** (0) | 0.243 (11) |

Right pairs 0.70–0.91, wrong pairs at most 0.344, so `WEAK_MATCH_THRESHOLD`
stays 0.5, about midway. The right pairs' parts:

| Pair | constrained | free | base | fit | coverage | filler |
| --- | --- | --- | --- | --- | --- | --- |
| Let It Be | 0.658 | 0.769 | 0.305 | 0.761 | 0.92 | 0.00 |
| Wonderwall | 0.618 | 0.665 | 0.302 | 0.872 | 1.00 | 0.00 |
| Someone Like You | 0.694 | 0.727 | 0.317 | 0.920 | 0.99 | 0.00 |
| Take On Me | 0.561 | 0.641 | 0.320 | 0.749 | 1.00 | 0.05 |

### Timelines (right pairs)

Every transposition matches the tab: 0 for Let It Be (C) and Take On Me (A),
+2 for the capo-2 Wonderwall and Someone Like You (sounding F#m and A). The
section order follows the sheets, and the boundaries are plausible against the
songs' known structure (not yet checked by ear against the recordings):

- **Let It Be:** Intro 0:00, Verse 1 0:13, Chorus 0:39, Verse 2 0:52, Chorus
  1:19, Instrumental 1:45, Solo 1:59, Chorus 2:27, Verse 3 2:41, Chorus 3:09.
  Chords land two beats each (C G Am F), with Fmaj7/F6 one beat each.
- **Wonderwall:** Intro (x4, all four) 0:00, Verse 1 0:22, Verse 2 0:44,
  Bridge 1 1:06, Chorus 1:28, Verse 3 1:55, Bridge 2 2:17, Chorus 2:39, Outro
  3:28.
- **Someone Like You** (double-tempo grid, 621 beats): Intro 0:01, Verse 1
  0:15, Pre-Chorus 0:58, Chorus 1:14, Verse 2 1:51, Pre-Chorus 2:20, Chorus
  2:37, Bridge 3:06, Chorus 3:24 and 3:53, Outro 4:37.
- **Take On Me:** a 6 s gap (the synth intro), Intro 0:06, Riff ×2 0:08,
  Verse 1 0:35, Chorus 0:52, Verse 2 1:14, Chorus 1:31, Instrumental 1:54,
  Verse 3 2:34, Chorus 2:51, a gap for the fade from 3:41.

Known weak spot: a sheet that writes fewer chords than are played (Wonderwall
writes two per lyric line over a four-chord riff) holds a chord where the
recording moves; nothing in the model prices a long hold.

### Cost

`alignChords` on 650 beats × 300 tokens (12 full decodes plus the path decode
and the free decode): 60–130 ms measured, but on a host at load average 20–26;
the real songs ran 9–35 ms in the calibration runs between spikes. All 12
transpositions are still decoded exhaustively.
