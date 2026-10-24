# Chord trainer — song index

Track page: `block-49ba706c-affe-417b-a9a1-b6873e8c7ea8` ("Chord trainer app").
Previous step: [`2026-09-16-global-hooktheory-auth-and-api.md`](2026-09-16-global-hooktheory-auth-and-api.md).

## Context

The chord trainer plays a short loop of a real song and asks you to name its
chords. To pick a loop it has to answer one question fast:

> Give me loops whose chords are **all ones I have unlocked**, and that
> **include the chord I am learning**.

The Hooktheory API cannot answer that. Its song search matches one exact chord
sequence. So the trainer keeps its own index, seeded from Sheet Sage's
Hooktheory dump. This plan designs that index. The app itself (shell, training
loop, curriculum) comes in later steps.

The index must:

1. keep every chord detail (7ths, inversions, borrowed and secondary chords);
2. answer the question above quickly;
3. know which YouTube videos are gone or cannot be embedded;
4. cut loops, 4 bars by default, with room for other loop shapes;
5. leave room to add newer songs through the Hooktheory API.

## What the dump really contains (measured 2026-09-16)

Sheet Sage publishes two files in `github.com/chrisdonahue/sheetsage-data`
(`hooktheory/`, commit `06113c04b109a2f27517b0399ff47550099f2466`):

| File | Size (gz → raw) | sha256 | Holds |
|---|---|---|---|
| `Hooktheory.json.gz` | 20 MB → 309 MB | `917b7cd5…698e0c` | 26,175 sections. Per section: artist/song slugs, YouTube id + duration, **beat → seconds alignment**, and chords as sound (root pitch class, stacked intervals, inversion). Beats are 0-based. |
| `Hooktheory_Raw.json.gz` | 96 MB → **1.5 GB** | `716af297…41634` | The same 26,175 sections (+3 with no document) as the **original Hookpad document**: every chord field (`root` degree, `type`, `inversion`, `applied`, `borrowed`, `adds`, `omits`, `alterations`, `suspensions`), keys, meters, tempos; plus the API record (display artist, song, section name "Chorus"/"Verse"…). Beats are 1-based. |

Both files use the same Hooktheory section id, so they join exactly. The
processed file's `num_beats` equals the raw `endBeat − 1` for all 26,175.

So **neither file alone is enough**. The chord spelling (was it written as V/V
or as a borrowed II?) exists only in the raw file. The timing exists only in the
processed file. The index imports both.

Numbers that shape the design:

- **Usable sections: 22,001.** They have chords, a YouTube id and a timing sync.
  3,958 have no timing and 20 have no chords. Those are kept but never looped.
- **12,720 distinct videos** behind those 22,001 sections. A video often holds
  several sections.
- Timing: 17,855 of the usable sections have a per-beat alignment. The rest only
  have a start and an end time.
- Meters: 4/4 in 90%, then 6/4 (1,266), 3/4 (969), a long tail (2/4, 6/8, 5/4…);
  286 sections change meter partway. 549 sections change key.
- Keys: major 13.7k, minor 10.7k, then mixolydian, dorian, lydian, phrygian,
  locrian, harmonic minor, phrygian dominant.
- Chords: 449k, of which 24k rests. 84k are 7ths, 9k are 9/11/13. 61k are
  inverted, 19.5k are secondary (`applied`), about 52k borrowed. `pedal` and
  `substitutions` are always empty.
- Every raw document is Hookpad version 1. The live API also serves versions
  2.24/2.34, which the integration's schema already parses.
- As sound (root relative to the tonic + intervals + inversion) there are
  **1,955 distinct chords**. The top 20 cover 69% of all chords, the top 100
  cover 90%.
- **4-bar loops**: ~184k windows (one per bar start, single-meter sections).
  7,501 of them use only I/IV/V (from 1,816 sections). 8,983 use only
  I/IV/V/vi and contain vi. There is enough material at the easiest level.
- YouTube: an oEmbed check on 60 random videos gave 58 alive and 2 gone (404).

## Design

### Where it lives

A new top-level app, `plugins/apps/plugins/chord/`, following the
`create-app` skill. The app id is `chord` (decided 2026-09-17; it replaced the
working id "chord-trainer" in this doc's paths, tables and endpoints). Its root stays empty (plus `data-dirs/`). This step adds
two sub-plugins:

- **`song-index`**: sections, loop windows, the import, and the query.
- **`video-availability`**: one row per YouTube video, the oEmbed sweep, and
  reports from the player.

`song-index` depends on `video-availability` (the query leaves out dead videos).
Nothing depends back.

The Hookpad vocabulary stays with the integration, `integrations/hooktheory`.
It gains two pure functions in `core/`, so the dump importer and a later API
top-up share one reading of a Hookpad document:

- `sectionFromHookpadDoc(id, song, doc)`: today's `sectionFromEnvelope` minus
  the envelope. Moved to `core` along with `youtubeVideoId`.
- `hookpadChordSound(chord, key)` → `{ rootPc, intervals, inversion }`: the
  Hookpad theory (the mode's scale, `borrowed` as a mode name or custom offsets,
  `applied` as V/x, vii°/x, IV/x…, `type` as stacked scale thirds, then adds,
  omits, alterations, suspensions). No such converter exists in the repo.
  Sonata's `theory/core` only knows major and natural minor, and it has no
  applied or borrowed representation. Its interval tables are a reference, not
  something to reuse.

**Acceptance for the converter:** on all 424,859 non-rest chords of the dump, it
must produce the same sound as Sheet Sage's processed file. Every disagreement
must be listed and explained. This is the one test that proves "every chord
detail" is read correctly.

### Chord identity: a sound token

Transcribers spell the same sound in different ways. D major in C can be
written as a secondary V/V or as a borrowed lydian II. A listener cannot hear
the difference. So the index keys each chord by **what it sounds like, relative
to the local tonic**:

```
ChordToken = "<root semitones above tonic>:<stacked intervals>/<inversion>"
  e.g.  "0:4-3/0"   I (major triad)
        "7:4-3-3/1" V7, first inversion
        "10:4-3/0"  bVII
```

- The token is built from `hookpadChordSound` + the key in force at the chord's
  beat. It is exact: a V7 is not a V, and an add9 is not a triad. The
  curriculum decides which tokens count as unlocked. If it later wants "V7
  answered as V" it can widen its own set without changing the index.
- `song-index/core` exports `chordToken`, `parseChordToken` and the token type,
  a branded string. The token is opaque in SQL.
- **The spelling is not lost.** Each stored chord keeps its full Hookpad fields
  next to its token. Each window also carries **features** derived from the
  spelling: `seventh`, `extended`, `inverted`, `applied`, `borrowed`,
  `suspended`, `altered`, `added`, `omitted`. So a level such as "secondary
  dominants" can filter on how the chord was written, not only on its sound.
- A rest has no token. A window records `hasRest`.

### Tables (song-index)

Declared with `defineEntity` (`infra/entities`); JSON columns are decoded with
`parsedJson` (`database/sql-column`).

**`chord_sections`**: one row per Hooktheory section, from any source.

| Column | Notes |
|---|---|
| `id` text PK | Hooktheory section hash (`qveoYyGGodn`); the API uses the same id. |
| `source` | `"sheetsage-dump"` \| `"hooktheory-api"`. |
| `artist`, `song`, `sectionName` | Display names, from the raw file's API record. |
| `videoId` text null | Parsed with `youtubeVideoId`. |
| `alignment` jsonb | A union: `{ kind: "beat-times", beats, times }` (piecewise linear, Hookpad 1-based beats; the per-beat alignment, or the 2-point start/end one) \| `{ kind: "video-fraction", start, end }` (a Hookpad `youtube.syncStart/End` from the API, which needs the video length to resolve) \| `{ kind: "none" }`. |
| `keys`, `meters`, `tempos` jsonb | Hookpad arrays, verbatim. |
| `endBeat` | |
| `chords` jsonb | The Hookpad chords **with every field**, compacted (empty arrays and nulls dropped on write, restored on read by the schema), each with its `token`. |
| `sourceTags` text[] | Sheet Sage tags (`AUDIO_AVAILABLE`, `KEY_CHANGES`…), kept for filtering and debugging. |
| `derivedVersion` int | See "Re-deriving". |
| `importedAt`, `updatedAt` | |

The melody (`notes`) is **not stored**. It is the largest part of each document
(about 120 MB across the dump), the trainer does not use it, and the dump stays
in the cache folder, so importing it later is a re-run. Keeping this table to
tens of MB matters because every worktree database is a copy of main's.

**`chord_loop_windows`**: the loops the trainer can play. This is data
derived from sections.

| Column | Notes |
|---|---|
| `sectionId` FK → sections, cascade | |
| `shape` | Loop-shape id, e.g. `"bars-4"`. |
| `startBeat`, `endBeat` | Hookpad beats. The client turns them into seconds with `beatToSeconds(alignment, beat, videoDuration?)` from `song-index/core`. |
| `bars`, `beatsPerBar`, `beatUnit` | |
| `keyTonic`, `keyMode` | A window lies inside one key. |
| `chordTokens` text[] | Distinct tokens in the window. **GIN index.** |
| `features` text[] | GIN index. |
| `chordCount`, `changeCount`, `hasRest`, `startsOnChange` | Ranking inputs for the trainer. |

Unique on `(sectionId, shape, startBeat)`.

**`chord_index_imports`**: one row per import run: the source, the dump
sha256, start and end times, counts, and skipped sections with a reason ("no
chords", "no timing", "unreadable video id", "document failed to parse: …").

### Loop shapes

A loop shape is plain data plus a pure enumerator, kept as a closed list in
`song-index/core` (`LOOP_SHAPES`):

```ts
type LoopShape = {
  id: "bars-4";               // later "bars-3", "bars-2", "phrase-8"…
  enumerate(section): WindowSpan[];
};
```

`bars-4`: 4 whole bars, one window per bar start. A window must lie inside one
meter and one key and fully inside the section. It works for any time signature
(6/8, 5/4 and 3/4 included, since "bar" follows the meter). Sections that change
meter are simply cut at each change. A 3-bar loop, or phrase-aligned loops, is a
new entry in the list plus a version bump. No schema change.

### Re-deriving

Tokens and windows are derived. `song-index/core` exports
`INDEX_DERIVATION_VERSION`, which is bumped whenever the converter, the token
format, the feature list or `LOOP_SHAPES` changes. A `song-index.rederive` job
(`defineJob`, `hold: "minutes"`, `serial`) re-derives, in batches, the sections
whose `derivedVersion` is behind. It is enqueued once at boot through `onReady`,
not on a timer. Both it and every import share one write path,
`upsertSection(normalized, meta)`: it writes the section, computes its tokens,
replaces its windows, and ties its video to a `video-availability` row, all in
one transaction.

### The query

`song-index/server` exports `findLoopWindows` and wraps it in an endpoint,
`POST /api/chord/loops/find`:

```ts
findLoopWindows({
  unlocked: ChordToken[],        // the allowed set
  target: ChordToken,            // must appear
  shape?: LoopShapeId,           // default "bars-4"
  modes?: string[],              // e.g. ["major"] at the first levels
  requireFeatures?, forbidFeatures?,
  excludeSectionIds?: string[],  // recently played
  limit: number,                 // small, e.g. 20
}): LoopCandidate[]              // window + section names + its chords + alignment + video status
```

```sql
WHERE w.shape = $shape
  AND w.chord_tokens @> ARRAY[$target]     -- selective, uses GIN
  AND w.chord_tokens <@ $unlocked          -- GIN recheck
  AND v.status NOT IN ('gone', 'not-embeddable')
ORDER BY random() LIMIT $limit
```

A second read helps the curriculum decide what to unlock next:
`countLoopsByNextChord({ unlocked, shape, modes })`. For each chord outside the
set, it returns how many windows use only the unlocked chords plus that one.
(An `unnest` + `GROUP BY` over the windows that contain exactly one foreign
token.)

The trainer asks for a batch, so this is a plain endpoint, not a live-state
resource. Nothing on screen has to update when the index changes.

**Target:** p95 under 50 ms on the full index. It is measured, not assumed; see
Verification.

### Importing the dump

- **Files**: a `cache`-kind data dir, `chord/sheetsage`, declared with
  `defineDataDir` (`infra/paths`). It is shared by every worktree, so the
  115 MB download happens once per machine. The URLs are pinned to the commit
  above, and each file is checked against its sha256 before use. A mismatch
  fails loudly.
- **Out of process**: the raw file is 1.5 GB of JSON, one top-level object.
  Parsing it inside the backend would block the event loop and hold ~GBs of
  memory. So the import is a **supervised task** (`defineSupervisedTask` /
  `defineSupervisedJob`, as backup does). It streams both files through gunzip
  and a streaming JSON parser (new dependency: `@streamparser/json`; the repo
  has none). It pairs the two records per section id and calls `upsertSection`
  in batches of ~200. It skips the `json_api.xmlData` blob and the editor state.
- **Idempotent**: every write is an upsert by section id, so a crash or restart
  just re-runs. A dump row never overwrites a `hooktheory-api` row.
- **When it runs**: at boot, the plugin enqueues the import if no completed
  `index_imports` row exists for the pinned dump sha256. It runs on main.
  Worktrees forked afterwards get the rows with the database copy and skip the
  import. A worktree forked earlier imports on its own (same code, same cached
  files).

### Video availability

**`chord_videos`** (video-availability): `videoId` PK, `status`
(`unknown` \| `ok` \| `gone` \| `not-embeddable`), `evidence` (`oembed` \|
`player`), `lastCode`, `checkedAt`, `durationSeconds` (from the dump; later
reported by the player), `title` / `channel` (from oEmbed).

Two sources of evidence:

1. **oEmbed sweep.** `GET https://www.youtube.com/oembed?format=json&url=…`
   needs no API key. 200 → `ok` (with title), 404/400 → `gone`,
   401/403 → `not-embeddable`. It is a `defineJob` with a `schedule` (every
   5 min), `hold: "seconds"`, a batch of ~100 videos, and a per-request timeout.
   It checks `unknown` videos first, then `ok` videos older than 90 days. The
   first sweep of 12.7k videos takes about 11 h in the background. Plain
   `fetch` is fine: the host is fixed (the same rule as the integration's
   CLAUDE.md).
2. **Player reports.** oEmbed cannot see age limits, region blocks or
   "playback on other websites disabled" on some label videos. The player can.
   `POST /api/chord/videos/:id/playback` records a YouTube IFrame API
   error (100 → `gone`; 101/150 → `not-embeddable`) or a successful play
   (→ `ok`, plus the duration). Player evidence overrides oEmbed. The web hook
   that sends these belongs to the training-loop step; this step only adds the
   endpoint.

`unknown` videos stay selectable. The first play settles them.

To confirm while implementing: that YouTube's oEmbed answers 401 for an embed-disabled video.
The sample only saw 200 and 404. Until a real case is seen, anything other than
200 or 404 is stored as its code with status `unknown`, not guessed.

### Room for newer songs (not built in this step)

The seam is `upsertSection` with `source: "hooktheory-api"`. A top-up job will
call `getTheorytabSection(id)` → `sectionFromHookpadDoc` → `upsertSection`,
with an alignment of `{ kind: "video-fraction" }`. It is not built now because
finding *new* section ids is still open. The live shape of `trends/songs` has
never been seen (Hooktheory is not signed in on main), and going from its song
URL to section ids is unsolved. That stays on the track page as a later item.

## Implementation steps

1. `integrations/hooktheory/core`: move the pure document decoder and
   `youtubeVideoId` into core; add `hookpadChordSound` + its test against a
   small checked-in set of dump chords (every `applied` value, every `borrowed`
   form, every mode, every chord `type`, inversions, adds/omits/alterations/sus).
2. App root `plugins/apps/plugins/chord/` (empty barrel, `data-dirs/`).
3. `video-availability`: table, oEmbed sweep job, playback endpoint.
4. `song-index/core`: token, features, `LOOP_SHAPES`, `enumerate`,
   `beatToSeconds`, `INDEX_DERIVATION_VERSION`, plus unit tests.
5. `song-index/server`: tables, `upsertSection`, the rederive job, the
   supervised import, `findLoopWindows`, `countLoopsByNextChord`, the endpoints.
6. Plugin `CLAUDE.md`s: the token format, the two alignment kinds, and why
   melody is not stored.

## Verification

1. `./equin build` (background): migrations, boundaries, type-check, docs.
2. `./equin test plugins/integrations/plugins/hooktheory plugins/apps/plugins/chord`.
3. **Converter golden run** (`./equin run` script in `song-index/e2e/` or
   a scratch script): stream both dump files and compare `hookpadChordSound`
   with the processed harmony for all 424,859 chords. Expect 100% agreement, or
   a written list of the classes that differ and why.
4. After the import on the worktree database (`query_db`): 26,175 sections,
   22,001 with windows, ~184k `bars-4` windows. The `index_imports` row lists
   the 4,174 skipped sections by reason. Table sizes via
   `pg_total_relation_size`, to check that forks stay small.
5. Query checks (`query_db` + the endpoint):
   - unlocked = {I, IV, V}, target = IV, major only → about 7.5k matching
     windows, and each returned window's tokens are inside the set;
   - `EXPLAIN ANALYZE` uses the GIN index; p95 over 100 random
     (unlocked, target) pairs is under 50 ms;
   - `countLoopsByNextChord({I, IV, V})` ranks vi and V7 near the top.
6. The oEmbed sweep, after a few runs: statuses fill in, and the 404 video
   from the sample (`bhC_ca8A96Q`) is `gone`. POST a fake player error 150 →
   the video becomes `not-embeddable` and disappears from `findLoopWindows`.
7. Re-run the import: no duplicate rows, and nothing changes.

## Open questions left to later steps

- Coarser answer classes ("V7 counts as V") belong to the curriculum, over
  tokens.
- Ranking loops (prefer windows that start on a chord change, fewer rests,
  variety of songs) belongs to the training loop. The index only stores the
  inputs.
- How to find new section ids for the API top-up (see above).
