# song-index

The chord app's index of real songs: every TheoryTab section of Sheet Sage's
Hooktheory dump, read into chords the trainer can compare, and cut into loops.
It answers one question fast: *give me loops holding a chord being practised,
whose other chords are all on (or at most `extras` of them off).* Design: `research/2026-09-16-apps-chord-trainer-song-index.md`
(v1: token, tables, query), `-v2.md` (snapshot, sample, backups), `-v3.md` (load
on first use), `research/2026-09-17-apps-chord-trainer-song-index-v4.md` (this
build).

## Using it

```ts
// Open the index (idempotent). Starts a load when it is missing, stale or failed.
POST /api/chord/index/ensure                → IndexStatus

// Loops holding at least one `practised` chord, every other chord `playable`
// — or up to `extras` (0 | 1 | 2 | "any") outside it —, holding `focus` when
// named (random order), on a video not known to be unplayable. At most
// `limit` — possibly fewer. `practised` ⊆ `playable`, `focus` ∈ `practised`.
POST /api/chord/loops/find  { playable, practised, extras, focus?, shape?="phrase",
                              requireFeatures?, forbidFeatures?, excludeSectionIds?, limit ≤ 50 }
  → { kind: "not-ready", status } | { kind: "ready", candidates: LoopCandidate[] }

// For each chord outside `unlocked`: how many windows unlocking it adds, split
// by the key mode of the window. Biggest single mode first.
POST /api/chord/loops/next-chords  { unlocked, shape?, modes?, limit? = 20 (≤ 200) }
  → { kind: "not-ready", status }
  | { kind: "ready", nextChords: { token, byMode: { major?: n, minor?: n, … } }[] }

// Windows made only of this set: what a learner holding exactly these chords,
// in these modes, could be given. The set is a parameter, so a caller can ask
// about one nobody has — a whole family's seed, say.
POST /api/chord/loops/count-in-set  { unlocked, shape?, modes? }
  → { kind: "not-ready", status } | { kind: "ready", windows }
```

Three counts are also exported from the **server barrel**, for a plugin in the
same backend (the curriculum builds its catalog with them; HTTP between two
server plugins would be the wrong seam):

```ts
countLoopsByNextChord(body)                        → NextChordCount[]   // the same rows as the endpoint
countLoopsInSet({ unlocked, modes?, shape? })      → number             // windows made only of this set
countTokenSets({ shape })                          → TokenSetCount[]    // GROUP BY key_mode, chord_tokens: { mode, tokens, windows }
loadIndexStatus()                                  → IndexStatus        // gate your own read on it
loadReadyIndexIdentity()                           → string | null      // which index is loaded (snapshot|scope|derivation|windows); a memo key
```

`countTokenSets` is the whole index folded to what a chord catalog needs (on
the full index: 83,752 rows over 183,270 windows, ~0.3 s).

Gate an in-process read on `loadIndexStatus()` the way the handlers here do:
before the index is `ready` the counts are 0, which would read as "nothing
left to learn" rather than "not loaded yet".

`windowsInModes(count, modes)` (core) sums the modes a caller plays;
`bestModeWindows(count)` is the largest single mode, which is the order the
rows come in. Summing no mode at all throws: 0 for every chord is a ranking
that never moves and never fails.

`IndexStatus` is also the live value `chord.index-status` (`chordIndexStatus`,
a `liveValue` served with `serveValue({ source: "db" })`: the load job writes
the state row from its own process, and the change feed pushes each commit):
`not-requested` | `loading { phase: queued | downloading | building-snapshot |
loading, done, total }` | `ready { scope, sections, windows }` | `failed {
error }`. Reading it (`useLive(chordIndexStatus)`) never starts work; only
`ensure` does.

On the web, wrap a screen that needs the index in `<SongIndexGate>` (web
barrel): it calls `ensure` on mount, shows the phases ("Waiting to start…",
"Downloading songs…", "Preparing songs…", "Loading songs 12,000 / 26,175" with
a bar) or the failure with Retry, and renders its children once `ready`.

Both reads answer `not-ready` until the status is `ready` — never an empty list,
which would read as "no song fits". A `LoopCandidate` carries the section's
display names, `videoId`, `videoDurationSeconds`, `videoStatus` (`ok`, or
`unknown` when nobody could tell yet), `alignment`, the window's fields and the
section's chords overlapping the window (every Hookpad field plus its token).

**Loop shapes** (`core/loop-shapes.ts`). `bars-4` is every 4-bar window as
cut. `phrase` — the default, and what the trainer plays — is the loops worth
training on, one per bar start: the 4 bars when they are **rich**
(`isRichLoop`: at least 3 different chords and 3 changes — a progression, not
a vamp or an I–V–I–V back-and-forth); else 8 bars when those are rich, hold at
most 8 chords (one answer box each) and loop within 20 s at the document's
tempo (a fast song: at 120 bpm in 4/4, 8 bars are 16 s; a section with no
measurable tempo never stretches) and are not the 4 bars played twice
(`repeatPeriod`, also what the trainer's blanks rule deals repeats by); else the 4 bars as they are — unless no
chord changes in them (one chord held or repeated), which is left out. Every
window stores `rich`, and `find` orders `rich DESC, random()`: rich loops
first, the plain ones only for a learner whose chords make too few rich ones.
Because `phrase` drops vamps, the counts on the default shape no longer see
the one-chord windows `next-chords` describes below; they still do on
`bars-4`.

**Video availability** (`research/2026-09-18-apps-chord-video-availability.md`;
the evidence and the verdict live in the `video-availability` plugin). About 1
video in 6 in the dump no longer plays. `find` left-joins the video status and
leaves out the videos known `gone` or `not-embeddable` — failing open, so a
video nobody has checked is still offered. It fetches 3 × `limit` rows, checks
their unchecked videos over oEmbed in one wave (`ensureVideoStatus`), drops the
ones that just came back dead, and returns up to `limit`. Fewer than `limit` is
a legal answer: there is no second query to top it up.

The two reads answer about the same windows:

- A chord's count is every window of the shape with exactly one chord
  outside the unlocked set — that chord — so unlocking it makes all of them
  `find` answers, except those on a video known to be unplayable. It counts
  windows sharing nothing with the set (a vamp on one chord), which is why it
  scans rather than starting from the GIN index.
- **The count is per key mode, in one scan** (group by token AND `key_mode`,
  fold, then `LIMIT` — so the limit counts chords, not rows). A chord worth
  nothing in major can be the biggest step in minor, and a single total over
  "whichever modes were scanned" is a number no caller can read. `modes` still
  narrows which windows are scanned.
- `countLoopsInSet` selects on `unlockedWindowsWhere`, the same rule `find`
  uses (playable set, extras 0, no practised chord) — so what it promises is
  exactly what can be played. `find` adds `chord_tokens && practised` (GIN),
  `@> [focus]` when named, and for the extras: `0` keeps `<@ playable` (GIN),
  `1` / `2` count the chords outside the set per row
  (`cardinality(array(… NOT (t = ANY(playable)))) ≤ n`, an array subtraction
  like `next-chords`), `any` drops the containment test. Key modes are no
  longer a `find` filter (the chords alone decide); the count reads keep
  `modes`.
- **The count ignores the videos, deliberately.** It only ranks chords, the
  dead videos fall roughly evenly across them, and with checks on demand most
  videos are `unknown` — so a filter would remove almost nothing, for a join
  over 183k windows. If the count ever becomes a number the user reads as a
  promise, it needs that join and a swept corpus.
- A candidate's chords are the ones its window was derived from: both sides call
  `chordOverlapsWindow`, so a payload can never carry a token the window's
  `chord_tokens` — what "every chord is unlocked" filtered on — does not list.

**Song videos.** The index is also the `hooktheory` source of
`integrations/youtube/song-videos` (`server/internal/song-videos-source.ts`):
a song's synced videos by slug (`hooktheorySlugs`: Hooktheory's slug rules,
tried with and without a leading "the", `&`, parentheticals) through the
`(artist_slug, song_slug)` index, grouped by video, playable ones only. It
answers `unavailable` until the index is `ready` and never starts a load.

## The chord token

A chord is keyed by what it SOUNDS like relative to the local tonic, since one
sound has several spellings (D major in C is a V/V or a borrowed lydian II):

```
<root semitones above the tonic>:<stacked root-position intervals>/<inversion>
"0:4-3/0" I     "7:4-3-3/1" V7, first inversion     "10:4-3/0" ♭VII
```

Exact on purpose: a V7 is not a V. A curriculum that wants "V7 counts as V"
widens its own unlocked set. The spelling is kept: every stored chord keeps its
Hookpad fields, and each window has `features` (`seventh`, `extended`,
`inverted`, `applied`, `borrowed`, `suspended`, `altered`, `added`, `omitted`)
for levels that filter on how a chord was written. A rest has no token.

## Alignment

`Alignment` places Hookpad beats (1-based) in the recording:

- `beat-times` — piecewise-linear points: Sheet Sage's per-beat ("refined")
  alignment when it has one, else its two-point start/end one, shifted from
  Sheet Sage's 0-based beats. `beatToSeconds(alignment, beat)`.
- `video-fraction` — Hookpad's own `syncStart`/`syncEnd` as fractions of the
  video's length (a document from the live API). Needs the duration first:
  `resolveVideoFraction(alignment, seconds)`.
- `none` — the section is kept but never looped.

## What is left out, and why

- **The melody (`notes`).** The largest part of each document, unused by the
  trainer. The snapshot builder parses documents with the hooktheory plugin's
  `HookpadHarmonyDocSchema`, so a broken melody cannot refuse a section's
  harmony (`pJkmZPEjxqn`: notes on a `null` beat, a tempo with a `null` bpm).
- **Snapshot skips** (the builder writes a skip line per source entry it cannot
  use, so every load accounts for the whole dump): `no-document`,
  `no-display-names`, `no-processed-section`, `no-raw-entry`,
  `document-refused`. On the pinned dump: 3 × `no-document`, nothing else.
- **Derivation skips** (`deriveSection`, Sheet Sage's rules): `no-chords`,
  `chord-past-end` (a sounding chord ends after `endBeat`),
  `chord-before-first-key`, `unreadable:<rule>` (one chord the converter cannot
  read drops the section). Full scope, pinned dump: 299 `no-chords`, 6
  `chord-past-end`, 6 `unreadable:type,alterations`, 4 `unreadable:alternate`, 2
  `unreadable:root`, 1 each `unreadable:borrowed`, `unreadable:type,adds`,
  `unreadable:duration`.
- **Unloopable sections** stay in `chord_sections` with no windows:
  `unloopableReason` `no-video` or `no-timing`.

Every skip is counted by reason in the state row's `skipped`: a **list** of
`{ reason, count, examples }`, largest first, up to 20 examples each. A list
because it is jsonb, and Postgres orders an object's keys itself.

## Data lifecycle

| What | Where | Forks | Backups |
|---|---|---|---|
| The two dump files (116 MB, pinned commit + sha256) | the `sheetsage-dumps` dependency (`deps/index.ts`, infra/deps' `download` kind: `cache/deps/sheetsage-dumps/<identity>/env/`) | — | no (refetched; the deps sweep may reclaim them) |
| The snapshot `sheetsage-<processed sha>-<raw sha>-v<format>.ndjson.gz` | `apps/chord/song-index/` | — | **yes** (`chord-song-index` backup source) |
| `chord_sections`, `chord_loop_windows`, `chord_index_state` | DB | excluded | excluded |
| `chord_index_request` (the app was opened here) | DB | kept | kept |

1. **Nothing happens until the app is opened.** `ensure` writes the request row,
   then enqueues `chord.song-index.load` unless the state row is `ready` at the
   current snapshot name, scope and `INDEX_DERIVATION_VERSION`. A failed state
   row is deleted first, so the status reads `queued` until the retry runs.
2. **Boot** (`onReady`) runs the same check, only where the request row exists:
   a derivation bump, a restored database or a fresh fork reloads on its own.
3. **The load job** is a supervised job (a detached child, `lock` = one run at a
   time; a second enqueue claims nothing). It re-checks the state row first, then:
   under a host-wide flock (`apps/chord/song-index/snapshot.lock`) it builds the
   snapshot once per machine — `ensureDep(sheetSageDumps, exec)` first, which
   downloads and sha256-checks the files when they are not installed (phase
   `downloading`); truncates the two
   index tables; streams the snapshot, keeps the scope's sections, derives and
   inserts them in batches of 200 (one transaction per batch); marks the state
   row `ready`. A throw marks it `failed` with the message and rethrows.
4. **No transaction around the whole load, on purpose.** Progress must commit to
   reach the browser, and ~184k uncommitted rows for minutes is the wrong trade.
   The state row is the gate instead: queries answer `not-ready` unless it is
   `ready`, and only the load's last write sets that. A load that dies midway
   leaves `failed` (or a stuck `loading`), and the next load truncates and starts
   over.
5. **Progress reaches the browser through the change feed**: the child writes
   `chord_index_state`, and `chordIndexStatus` (a db-sourced live value) re-reads
   it. The two bulk tables are excluded from the change feed; nothing live reads
   them.

**Scope** (`config`: `scope: auto | full | sample`, default `auto`): `auto` loads
everything on the host singleton (main, or a release's single backend —
`isHostSingleton()`, never `isMain()`) and the worktree sample elsewhere. The
sample is every song whose slugs hash into bucket 0 of 20, plus
`SAMPLE_PINNED_SECTIONS`. A change reloads on the next `ensure` or boot.

## Measured (pinned dump, 2026-09-17)

- Snapshot build: 44–48 s for both files (after a 6 s download), **8.7 MB**
  gzipped (115 MB of JSON lines once unzipped: every Hookpad chord field, in full).
- Full scope: 26,178 lines → **25,855 sections** stored, 21,723 with windows,
  **183,270 `bars-4` windows**; the sections' compacted chords are 31 MB of JSON.
- Sample scope: 1,346 lines → 1,328 sections, 1,108 with windows, 9,612 windows.
- Deriving the whole snapshot without a database: ~5 s.
- Reading the snapshot: 2.6 s to decode every line in full, 0.87 s for the four
  fields a load counts its total with (`readSnapshotHeads`) — so a load decodes
  it once, not twice.
- `find` on the full index: p95 31 ms over 100 random unlocked sets, inside the
  < 50 ms target (`e2e/song-index-verify.ts`, before the extras; it now times
  100 finds per extras setting — extras 1 and 2 are still to measure on main). Measured before the video check;
  a cold batch adds one oEmbed wave (~150 ms expected), still to re-measure
  (`e2e/video-availability-verify.ts` reports a cold and a warm call).
- `next-chords` on the full index (a scan of the 183,270 windows): 87 ms for one
  unlocked chord, 119 ms for eight (median of 6).
- Still to measure after a deploy: load time into Postgres and table sizes
  (`pg_total_relation_size`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The song index's web half: the settings registration for its load scope, and SongIndexGate — opens the index on mount and shows the load's progress (or its failure, with Retry) until the index is ready, then its children. The chord app's song index: the Sheet Sage download and snapshot build, the supervised load job, the ensure endpoint, the live load status, the loop queries, the snapshot's backup source, and the `hooktheory` song-video source (the videos transcribers synced a song to, by slug).
- Web:
  - Contributes: `ConfigV2.WebRegister` "config"
  - Uses:
    - `config_v2.ConfigV2`
    - `infra/endpoints.useEndpointMutation`
    - `network/live.useLive`
    - `primitives/css/center.Center`
    - `primitives/css/clip.Clip`
    - `primitives/css/spacing.Inset`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/live-state.matchResource`
    - `primitives/loading.Loading`
  - Exports (values): `SongIndexGate`
- Server:
  - Contributes:
    - `ConfigV2.Register` "config"
    - `resource.declare` "chord.index-status"
    - `song-videos.source` "hooktheory"
    - `backup.source` "Chord song index snapshot"
    - `fork-data-exclusion` "chord_index_state"
    - `fork-data-exclusion` "chord_loop_windows"
    - `fork-data-exclusion` "chord_sections"
    - `backup-data-exclusion` "chord_index_state"
    - `backup-data-exclusion` "chord_loop_windows"
    - `backup-data-exclusion` "chord_sections"
    - `change-feed-exclusion` "chord_loop_windows"
    - `change-feed-exclusion` "chord_sections"
  - Uses:
    - `apps/chord/video-availability.chordVideoStatus`
    - `apps/chord/video-availability.ensureVideoStatus`
    - `backup.BackupSource`
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
    - `database.db`
    - `database/admin.ExcludeFromBackup`
    - `database/admin.ExcludeFromFork`
    - `database/change-feed.ExcludeFromChangeFeed`
    - `database/derived-updated-at.deriveUpdatedAt`
    - `database/sql-column.parsedJson`
    - `database/sql-column.parsedText`
    - `infra/endpoints.implement`
    - `infra/jobs/supervised-job.defineSupervisedJob`
    - `integrations/youtube/song-videos.SongVideos`
    - `network/live.serveValue`
    - `primitives/log-channels.defineLogSink`
  - DB schema: `plugins/apps/plugins/chord/plugins/song-index/server/internal/tables.ts`
  - Exports (values):
    - `countLoopsByNextChord`
    - `countLoopsInSet`
    - `countTokenSets`
    - `loadIndexStatus`
    - `loadReadyIndexIdentity`
  - Register: `defineSupervisedJob('chord.song-index.load')`
  - Resources: `chord.index-status` (push)
  - Routes:
    - `POST /api/chord/index/ensure`
    - `POST /api/chord/loops/find`
    - `POST /api/chord/loops/next-chords`
    - `POST /api/chord/loops/count-in-set`
- Core:
  - Uses:
    - `apps/chord/video-availability.VideoStatusSchema`
    - `infra/endpoints.defineEndpoint`
    - `integrations/hooktheory.HookpadChord`
    - `integrations/hooktheory.HookpadChordRule`
    - `integrations/hooktheory.HookpadChordSchema`
    - `integrations/hooktheory.hookpadChordSound`
    - `integrations/hooktheory.HookpadHarmonyDocSchema`
    - `integrations/hooktheory.HookpadKey`
    - `integrations/hooktheory.hookpadKeyAt`
    - `integrations/hooktheory.HookpadMeter`
    - `integrations/hooktheory.HookpadMode`
    - `integrations/hooktheory.HookpadModeSchema`
    - `integrations/hooktheory.HookpadTempo`
    - `integrations/hooktheory.hookpadTonicPc`
    - `integrations/hooktheory.TheorytabSectionIdSchema`
    - `network/live.liveValue`
  - Exports (types):
    - `BeatTimesAlignment`
    - `ChordFeature`
    - `ChordToken`
    - `ChordTokenParts`
    - `CountLoopsInSetBody`
    - `DerivedSection`
    - `DeriveSectionInput`
    - `FindLoopsBody`
    - `IndexedChord`
    - `IndexLoadPhase`
    - `IndexPhase`
    - `IndexScopeSetting`
    - `IndexStatus`
    - `LoadScope`
    - `LoopCandidate`
    - `LoopChord`
    - `LoopExtras`
    - `LoopSectionInput`
    - `LoopShape`
    - `LoopShapeId`
    - `LoopWindow`
    - `NextChordCount`
    - `NextChordsBody`
    - `SectionLoops`
    - `SectionSkipReason`
    - `SectionUnloopableReason`
    - `SheetSageAlignment`
    - `SkipSummary`
    - `SkipSummaryEntry`
    - `SnapshotLine`
    - `SnapshotSection`
    - `SnapshotSkip`
    - `SnapshotSkipReason`
    - `StoredChord`
    - `TokenizedChord`
    - `TokenSetCount`
    - `VideoFractionAlignment`
    - `WindowsByMode`
  - Exports (values):
    - `alignmentFromSheetSage`
    - `AlignmentSchema`
    - `beatTimesAlignment`
    - `beatToSeconds`
    - `bestModeWindows`
    - `CHORD_FEATURES`
    - `chordFeatures`
    - `chordIndexStatus`
    - `chordOverlapsWindow`
    - `chordToken`
    - `chordTokenFromParts`
    - `ChordTokenSchema`
    - `compactChord`
    - `CountLoopsInSetBodySchema`
    - `countLoopsInSetEndpoint`
    - `DEFAULT_LOOP_SHAPE`
    - `deriveSection`
    - `ensureChordIndexEndpoint`
    - `expandChord`
    - `FIND_LOOPS_MAX_LIMIT`
    - `findLoopsEndpoint`
    - `fnv1a32`
    - `INDEX_DERIVATION_VERSION`
    - `INDEX_LOAD_PHASES`
    - `INDEX_SCOPE_SETTINGS`
    - `IndexLoadPhaseSchema`
    - `IndexPhaseSchema`
    - `IndexStatusSchema`
    - `isInLoadScope`
    - `isInSample`
    - `LoadScopeSchema`
    - `LOOP_EXTRAS`
    - `LOOP_SHAPE_IDS`
    - `LOOP_SHAPES`
    - `LoopCandidateSchema`
    - `LoopExtrasSchema`
    - `LoopWindowFieldsSchema`
    - `NEXT_CHORDS_MAX_LIMIT`
    - `NextChordCountSchema`
    - `nextChordsEndpoint`
    - `parseChordToken`
    - `repeatPeriod`
    - `resolveLoadScope`
    - `resolveVideoFraction`
    - `SAMPLE_BUCKETS`
    - `SAMPLE_PINNED_SECTIONS`
    - `sampleBucket`
    - `SheetSageAlignmentSchema`
    - `SheetSageBeatTimesSchema`
    - `SKIP_EXAMPLES_PER_REASON`
    - `SkipSummaryEntrySchema`
    - `SkipTally`
    - `SNAPSHOT_FORMAT_VERSION`
    - `SNAPSHOT_SKIP_REASONS`
    - `SnapshotLineSchema`
    - `SnapshotSectionSchema`
    - `SnapshotSkipReasonSchema`
    - `SnapshotSkipSchema`
    - `StoredChordSchema`
    - `TokenizedChordSchema`
    - `WindowsByModeSchema`
    - `windowsInModes`
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps/download.download`
  - Exports (values):
    - `SHEETSAGE_DUMP_FILES`
    - `sheetSageDumps`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `apps/chord/curriculum`
    - `apps/chord/piano`
    - `apps/chord/progress`
    - `apps/chord/trainer`
    - `apps/chord/vocabulary`
- Exemptions:
  - Exempts itself from: `ids:pk-declared` — `server/internal/tables.ts` (debt)

<!-- AUTOGENERATED:END -->
