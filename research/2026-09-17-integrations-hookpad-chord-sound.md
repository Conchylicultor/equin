# Hookpad chords → the notes they sound

Track page: `block-49ba706c-affe-417b-a9a1-b6873e8c7ea8` ("Chord trainer app").
Parent design: [`2026-09-16-apps-chord-trainer-song-index.md`](2026-09-16-apps-chord-trainer-song-index.md),
"Where it lives" and implementation step 1. (v2 of that design changes only the data lifecycle.)

## Context

The chord trainer's song index keys every chord by how it sounds relative to the
key. A Hookpad chord is written as theory, not notes: a scale degree, a size
(triad, 7th, 9th…), an inversion, and optionally a secondary target, a borrowed
mode or custom scale, adds, omits, alterations and suspensions. Nothing in the
repo turns that into notes, in any of the nine Hookpad modes. Sonata's theory
only knows major and natural minor.

Also, the integration's document decoder (`sectionFromEnvelope`) lives in
`server/`. The dump importer (a later step) must read the same documents, so the
pure part moves to `core/`.

Outcome of this step: two pure functions in `integrations/hooktheory/core`, and
proof that the chord one agrees with Sheet Sage on the whole dump.

## Pinned inputs

The two dump files, from `github.com/chrisdonahue/sheetsage-data`, commit
`06113c04b109a2f27517b0399ff47550099f2466`, folder `hooktheory/`:

| File | Size (gz) | sha256 |
|---|---|---|
| `Hooktheory.json.gz` (processed) | 20,075,896 B | `917b7cd58f5f4e07d6c36acf7bfad958c99ee05472dab3555399141094698e0c` |
| `Hooktheory_Raw.json.gz` (raw Hookpad) | 95,918,784 B | `716af2979f060400c302ab098dd45d9f8c5fe4d4b3b1fe61c478dd9bdf041634` |

Download URL form: `https://github.com/chrisdonahue/sheetsage-data/raw/<commit>/hooktheory/<file>`.

The reference implementation that produced the processed harmony is public:
`github.com/chrisdonahue/sheetsage`, commit
`bbdd7b7b6a5fb845828f82790acdceb03a197779`, file `sheetsage/theory/theorytab.py`
(`TheorytabChord._check_values` and `as_chord`). The converter is a port of its
rules, not a new reading of Hookpad theory.

## What the data holds (measured 2026-09-17)

Chord field values across all 424,859 non-rest raw chords:

- **Key modes (9):** major, minor, mixolydian, dorian, lydian, phrygian, locrian,
  `harmonicMinor`, `phrygianDominant`. Tonics use 18 spellings, including `E#`,
  `A#` and `Gb`.
- **type:** 5, 7, 9, 11, 13. **Inversions** occur only on 5 (0–2) and 7 (0–3).
- **applied:** 0–7 (5 → 14.6k, 7 → 2.4k, 4 → 2k, then 2, 1, 3, 6).
- **borrowed:** null (372k); a mode name (all 9); a custom scale of 7 semitone
  offsets from the tonic (29 distinct, which can go below 0 or reach 12, e.g.
  `[-1,1,3,5,6,8,10]`); and one `"super:2"`. 145 chords are both applied and
  borrowed.
- **adds** ⊂ {9, 4, 6}, **omits** ⊂ {3, 5}, **alterations** ⊂ {b5, #5, b9, #9,
  #11, b13}, **suspensions** ⊂ {2, 4}, in any order.
- 6 non-rest chords have `root: 0`; 14 chords carry a non-empty `alternate`.

Processed file: 421,298 chords, so **3,561 raw chords have no processed
counterpart**. All of them sit in 21 sections whose processed harmony is empty
(its validator threw on the section, which drops every chord in it). A
re-implementation of that validator explains 14 of the 21:

| Rule broken | Sections |
|---|---|
| alteration not allowed for the chord's size | 6 |
| non-empty `alternate` | 4 |
| sounding chord with `root ≤ 0` | 2 |
| `borrowed: "super:2"` (plus a suspension not allowed for the size) | 1 |
| add not allowed for the chord's size | 1 |
| **not yet explained** | 7 |

The other 298 sections with empty harmony have no sounding chords. In every
other section, the chord count matches.

## Design

### Where it lives

All in `plugins/integrations/plugins/hooktheory/core/`, pure TypeScript with no
node imports, so any runtime (the importer's supervised task, a server, the web)
can use it.

```
core/internal/
  schemas.ts            (existing) + HookpadModeSchema
  parse.ts              moved from server/internal (parseOrThrow)
  youtube.ts            moved from server/internal (youtubeVideoId) + its test
  section.ts            NEW home of HookpadDocSchema + sectionFromHookpadDoc + its test
  hookpad-sound.ts      NEW hookpadChordSound, hookpadTonicPc, HOOKPAD_MODE_OFFSETS
  hookpad-sound.test.ts NEW
  hookpad-sound.fixtures.ts  NEW, generated from the dump (see Verification)
server/internal/
  section.ts            only PublicSongEnvelopeSchema + sectionFromEnvelope
                        (JSON.parse of jsonData, then sectionFromHookpadDoc)
scripts/
  hookpad-sound-golden.ts    NEW manual script: the whole-dump comparison
```

### `sectionFromHookpadDoc(id, song, doc: unknown): TheorytabSection`

Today's `sectionFromEnvelope` minus the envelope: parse `doc` with
`HookpadDocSchema` via `parseOrThrow`, pull the video id out. It throws naming
the section on a bad shape, as today. The raw dump's `json` field is exactly
this document (with `youtube: { id, syncStart, syncEnd }`), and the dump's
`json_api.song` is the song, so the importer calls it directly.

`sectionFromEnvelope` keeps its only job: turning `jsonData` from a string into
a value, with its "not valid JSON" error.

### Key modes become a closed list

`HookpadKeySchema.scale` tightens from `z.string()` to `HookpadModeSchema`, an
enum of the nine modes. The same schema types a mode-name `borrowed`. A tenth
mode from the live API then fails at the fetch boundary, naming the field,
instead of deep in the converter. The list is data both Sheet Sage and the dump
agree on. (`HOOKPAD_MODE_OFFSETS: Record<HookpadMode, 7 offsets>` is typed by
it, so a mode without offsets is a type error.)

`borrowed` stays `string | number[] | null` in the schema: `"super:2"` is a real
value, and one odd chord must not make its whole section unreadable. The
converter reports it instead (below).

### `hookpadChordSound(chord, key): HookpadChordReading`

```ts
type HookpadChordSound = {
  rootPc: number;        // 0–11, absolute (C = 0)
  intervals: number[];   // stacked semitones, root position: [4, 3] for a major triad
  inversion: number;     // Hookpad's, passed through
};

type HookpadChordReading =
  | { kind: "sound"; sound: HookpadChordSound }
  | { kind: "rest" }
  | { kind: "unreadable"; rule: HookpadChordRule; detail: string };
```

A result, not a throw: an unreadable chord is expected data (14 dump sections),
and the importer has to record why and move on. `rule` is a closed union
(`"root"`, `"type"`, `"inversion"`, `"type,alterations"`, `"alternate"`,
`"borrowed"`, …, one per check in Sheet Sage's `_check_values`), so the golden
script and the importer's skip reasons group by it.

The steps, ported from `as_chord`:

1. **Check** every rule in `_check_values`: allowed values per field; the
   per-type allow-list (inversions, suspensions, adds, alterations); and the
   cross-field rules (inversion vs. omits, an add and an alteration on the same
   degree, sus2 + add9, sus4 + add4, omit 5 with an altered 5th, omit 3 with a
   suspension). `pedal` must be null and `alternate` empty.
2. **Chord degrees:** 1, 3, 5, … up to `type`. The first suspension replaces the
   3rd. Adds 4 and 6 become 11 and 13; add 9 stays 9. Omits remove. Each
   alteration adds its degree.
3. **Scale:** the key's mode offsets; replaced by the borrowed mode's offsets,
   or by the custom offsets as given.
4. **Secondary (applied):** the tonic moves up to the scale step of `root`; the
   root becomes `applied`; the scale becomes major.
5. **Degrees → semitones:** degree step `(root−1)+(d−1)`, offset from the scale,
   plus 12 per octave. One Hookpad quirk, kept deliberately: in a vii/x
   (`applied = 7`), the 7th is lowered a semitone (a fully diminished 7th).
6. **Alterations** raise or lower their degree a semitone.
7. Sound = first tone's pitch class, and the differences between consecutive
   tones.

`hookpadTonicPc(tonic)` reads a spelling (letter, then `#`/`##`/`b`/`bb`) to a
pitch class and throws on anything else. The schema has already accepted the
string, so an unknown spelling is a broken assumption, not data.

It does not import Sonata. The integration sits below the apps, and Sonata's
tables cover only two modes.

### Not in scope

- The sound token, windows, the importer and the tables (song-index steps).
- Live-API documents of versions 2.24 / 2.34 are read by the same rules. Only
  version 1 is proven against Sheet Sage. The unit tests include the 50-section
  live sample's chords as a readable-without-error check.

## Implementation steps

1. Move `parse.ts`, `youtube.ts` (+ test) to `core/internal`; split `section.ts`
   into core `sectionFromHookpadDoc` and server `sectionFromEnvelope`; move the
   tests with them. Export `sectionFromHookpadDoc`, `youtubeVideoId` from the
   core barrel.
2. `HookpadModeSchema`; tighten `HookpadKeySchema.scale`.
3. `hookpad-sound.ts` and hand-written tests: I–IV–V in C major; ii–V–i in A
   harmonic minor; V/V in C (D major); vii°7/V (F♯ fully diminished); borrowed
   `minor` ♭VI in C; a custom scale with a −1 offset; each mode's I; sus2, sus4,
   sus2+4; add9/add4/add6; omit 3 and omit 5; every alteration on a 7th and a
   9th; an 11th and 13th; each inversion; each unreadable rule.
4. `scripts/hookpad-sound-golden.ts` (below); run it; write the results into
   this doc; generate `hookpad-sound.fixtures.ts` from it.
5. Plugin `CLAUDE.md`: the core functions, the Sheet Sage reference with its
   commit, the applied-7 quirk, and the golden-run numbers. Update the track
   page's agent card.

## The golden script

`./equin run plugins/integrations/plugins/hooktheory/scripts/hookpad-sound-golden.ts --raw <path> --processed <path> [--emit-fixtures]`

- Checks both files against the pinned sha256 first; a mismatch stops it.
- The processed file (309 MB raw) is read with one `JSON.parse`. The raw file is
  1.5 GB, beyond one string, so it is streamed with **`@streamparser/json`**,
  one section at a time. That is the dependency the song-index importer already
  plans on, so it is added now (to this plugin's `package.json`).
- For each section: decode with `sectionFromHookpadDoc`; pair raw sounding
  chords with processed harmony in order, checking `onset = beat − 1` and
  `offset = onset + duration`; find the key in force at the chord's beat; compare
  `rootPc`, `intervals`, `inversion`. Also compare the key itself against the
  processed key (tonic pitch class, mode steps).
- Prints: chords compared, agreeing, and a table of disagreement classes, each
  with a count and 3 examples (section id, chord fields, key, ours, theirs). A
  section with empty processed harmony is one class per `rule`, plus
  "reference dropped it, we read it" for the 7 not yet explained.
- `--emit-fixtures`: one example per distinct combination of (key mode, applied,
  borrowed kind, type, inversion, adds, omits, alterations, suspensions), with
  Sheet Sage's expected sound, written as a small checked-in table. The unit
  test then replays the whole-dump check in miniature on every test run.

The files are downloaded to a scratch directory for this step. The shared cache
directory belongs to the app root (song-index step 2).

## Verification

1. `./equin test plugins/integrations/plugins/hooktheory`: the moved
   decoder and YouTube tests still pass; the new theory tests and the fixture
   replay pass.
2. The golden run: 421,298 paired chords agree 100%, or each class of
   disagreement is in the Results section below with its count, examples and
   explanation. The 3,561 unpaired chords are accounted for by class (the 7
   unexplained sections are explained, or listed as such).
3. `GET /api/hooktheory/sections/_NgbRXeYgQA` on this worktree's deploy still
   answers the Let It Be verse. Every chord in it reads as a sound.
4. `./equin build` (background): boundaries, type-check, docs in sync.

## Results

Golden run of 2026-09-17, on the pinned files. It takes about 3½ minutes.
Command: `./equin run plugins/integrations/plugins/hooktheory/scripts/hookpad-sound-golden.ts --raw <Hooktheory_Raw.json.gz> --processed <Hooktheory.json.gz> [--emit-fixtures]`.

### Chords: 100 % agreement

| | Count |
|---|---|
| Raw entries | 26,178 |
| … with no Hookpad document (absent from the processed file too) | 3 |
| … refused by the section schema (see below) | 1 |
| Sections compared | 26,174 |
| Raw non-rest chords in them | 424,851 |
| Processed chords in them | 421,290 |
| **Chords paired, and agreeing on root, intervals and inversion** | **421,290 (100 %)** |

Every paired chord also lines up in time: processed `onset = beat − 1` and
`offset = onset + duration`. No converter change was needed after the first
full run; the port matched as written, the applied-7 quirk included.

### The 3,561 raw chords with no processed counterpart

3,560 sit in **20** sections whose processed harmony is empty. (The earlier
count of 21 sections was off by one; the chord total was right.) The last one
is a chord of zero length inside a kept section.

| Why the reference has no harmony | Sections | Chords |
|---|---|---|
| a chord breaks `type,alterations` (e.g. `b9` or `#9` on a triad) | 6 | 3,114 |
| a chord ends after the section's `endBeat` | 6 | 146 |
| a chord has `alternate: "_"` | 4 | 43 |
| a sounding chord has `root: 0` | 2 | 82 |
| a chord has `borrowed: "super:2"` | 1 | 89 |
| a chord breaks `type,adds` (add 6 on an 11th) | 1 | 86 |
| **reference dropped it, we read it** | **0** | 0 |

**The 7 formerly unexplained sections.** Six of them are the "ends after
`endBeat`" row. Sheet Sage's lead-sheet builder
(`LeadSheet.from_theorytab` in `theory/lead_sheet.py`, same commit) throws when
a sounding chord's `beat + duration` passes `endBeat`, and the rule holds in
both directions across the dump: every section with such a chord has empty
harmony, and no section with harmony has one. The seventh was the double count
above. Examples: `nJmBkqNWgAV` (endBeat 38, a chord at beat 37 running past it),
`ZwxKqepDmed` (endBeat 82, a chord starting at 82), `nvgy-WaRgkA` (endBeat 21,
chords up to 25). This is a section-level rule, not a chord one, so it is not in
`hookpadChordSound`; the importer has to apply it itself.

**The one zero-length chord** is in `bWgMP_wXmlX`: a non-rest chord at beat
15.99998 lasting 1.8 × 10⁻¹⁵ beats (floating-point drift in an old document).
The reference's `_check_values` would throw `duration` on it and drop the
section; the published data instead kept the section's other 32 chords and
left this one out. This is the one place where the code at the pinned commit
does not explain the data. `hookpadChordSound` follows the code and reports
`unreadable` / `duration`.

### Section documents the schema had to learn about

- **216 sections have `youtube.id: null`** (nothing was ever pasted).
  `TheorytabYoutube.rawId` is now `string | null`; `videoId` is `null` then.
- **1 section is refused on purpose:** `pJkmZPEjxqn` has a broken melody (its
  notes have `beat: null`, and most also `octave: null` and `sd: ""`).
  `sectionFromHookpadDoc` throws naming the fields. Sheet Sage kept its 8
  chords (with no melody), so an importer that wants those 8
  chords would need notes to be read separately from the chords. Left strict
  for now: one broken document should not make every consumer handle null
  beats.
- `pedal` is `null` in all 449,072 chords (rests included); `alternate` is
  `""` except the 14 `"_"` above. Both are now modelled, so the converter can
  check them.

### Keys: 100 % agreement

All 26,174 sections' key maps match the processed keys (tonic pitch class,
mode steps, 0-based beat) **without** dropping a repeated key and **without**
trimming a change at the last beat. The lead-sheet builder does both; the
processed file does neither. 12 sections repeat their last key exactly at
`endBeat` (e.g. `veoYq_Ljodn`: A♭ major at 1, again at 33), and the processed
file keeps the repeat.

### Fixtures

`--emit-fixtures` wrote 2,624 lines (one per distinct combination of key mode,
applied, borrowed, type, inversion, adds, omits, alterations, suspensions),
about 285 KB. `hookpad-sound.test.ts` replays all of them.
