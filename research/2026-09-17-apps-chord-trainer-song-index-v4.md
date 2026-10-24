# Chord trainer — song index, v4: what this step builds

Track page: `block-49ba706c-affe-417b-a9a1-b6873e8c7ea8` ("Chord trainer app").
Builds on v1 ([`…-song-index.md`](2026-09-16-apps-chord-trainer-song-index.md): token,
tables, loop shapes, query), v2 ([`…-v2.md`](2026-09-16-apps-chord-trainer-song-index-v2.md):
snapshot, worktree sample, backups) and v3 ([`…-v3.md`](2026-09-17-apps-chord-trainer-song-index-v3.md):
load on first use, app id `chord`). Converter results:
[`2026-09-17-integrations-hookpad-chord-sound.md`](2026-09-17-integrations-hookpad-chord-sound.md).

This doc does not redesign. It fixes the scope of the song-index step, records
the corrections found while reading the code, and lists the build order.

## Context

The chord app has to pick a loop of a real song whose chords are all unlocked
and include the chord being learned. Nothing can answer that yet: no song index
exists. Its prerequisites are merged: the Hookpad chord converter
(`integrations/hooktheory/core`, 100 % agreement with Sheet Sage) and
`ExcludeFromBackup` (`database/admin`).

Outcome of this step: opening the index (an endpoint call) downloads the dump
once per machine, builds the 7 MB snapshot, and loads the sections and 4-bar
loop windows into the database; `POST /api/chord/loops/find` then returns loops
that fit an unlocked set and a target chord.

## Scope

**In:** the app root and its data dir; the `song-index` sub-plugin (tables,
snapshot builder, load job, `ensure` endpoint, status resource, the two query
endpoints, worktree sample, fork and backup exclusions, snapshot backup source).

**Out (later steps, already on the track):**

- **Video availability** (its own task). The query has no video filter yet;
  the seam is a later `JOIN chord_videos` in `findLoopWindows`.
- **App skeleton / UI.** No pane, no loading screen. Verification goes through
  the endpoints, `query_db` and a script. Only `shell/core` (`defineApp`) is
  created now, because `defineAppDataDir` needs the app's id.
- **Hooktheory API top-up** and its `chord_api_documents` table (v2 §4). Nothing
  writes to it yet, so it is created with the top-up. The load job leaves a
  named step where API documents would be re-applied.

## Corrections to v1–v3 found in the code

1. **Full vs sample follows `isHostSingleton()`, not `isMain()`.** A release's
   single backend is not `isMain()`, so v2's rule would load a 5 % sample on a
   deployed instance. The config field is `scope: "auto" | "full" | "sample"`
   (default `"auto"`), resolved at load time: `auto` = full on a host singleton,
   sample elsewhere. No default computed at module load.
2. **The loader runs as a supervised job**, not a plain `defineJob`: a full
   load (streaming 1.5 GB, then ~184k window inserts) takes minutes, and
   `hold: "minutes"` in-process is reserved for work that may die with a
   restart. `defineSupervisedJob({ run, lock })` with the built-in ledger, the
   lock keyed `"chord.song-index.load"`, so a second `ensure` joins the running
   one instead of starting another.
3. **Progress travels through the database, not `notify()`.** The job runs in
   a child process, where an in-memory `defineExternalResource.notify()` would
   not reach the backend. The child writes its phase to the one-row
   `chord_index_state` table; the status resource is a push `defineResource`
   with `identityTable: "chord_index_state"`, and the change feed carries each
   write to the browser. One row, so it is a schema-bounded scalar.
4. **Where the files live.**
   - The two downloads (116 MB, refetchable): a `cache` dir,
     `defineDataDir({ kind: "cache", name: "chord-sheetsage", reclaim: safe })`.
   - The snapshot (the copy backups keep): the app dir,
     `chordDir.subdir("song-index")`, via `defineAppDataDir(chordApp)`. Reclaiming
     the cache must never take the one copy that survives Sheet Sage vanishing.
   - Host-wide build lock: `packages/flock` on a file in the cache dir, so two
     worktrees opening the app at once build the snapshot once.
5. **Re-deriving is a reload.** v1's separate `song-index.rederive` job is
   dropped: v3 already reloads from the snapshot when the state row's derivation
   version is behind, and a reload from 7 MB takes seconds to a minute. One
   write path (`loadSections`), one job.
6. **Rules the importer applies before the converter** (from the converter
   results): skip a section when a sounding chord ends after `endBeat`
   (`beat + duration > endBeat`, Sheet Sage's lead-sheet rule, 6 sections);
   record `pJkmZPEjxqn` (`sectionFromHookpadDoc` throws) as skipped, not fatal;
   a chord reading `unreadable` skips its whole section, with the rule as the
   reason, as Sheet Sage does. The "key in force at a beat" helper, today a
   private `keyAt` in the golden script, moves to `hooktheory/core`
   (`hookpadKeyAt`) and the script uses it, so the importer and the golden
   comparison share one rule.

## Layout

```
plugins/apps/plugins/chord/
  package.json, web/index.ts (empty)
  data-dirs/index.ts                 chordDir = defineAppDataDir(chordApp)
  plugins/shell/core/app.ts          chordApp = defineApp({ id: "chord", … }) — nothing else yet
  plugins/song-index/
    core/      token.ts (ChordToken, chordToken, parseChordToken), features.ts,
               loop-shapes.ts (LOOP_SHAPES, bars-4 enumerate), beat-time.ts
               (Alignment union, beatToSeconds), sample.ts (bucket rule +
               SAMPLE_PINNED_SECTIONS), derive.ts (section → tokens, features,
               windows; INDEX_DERIVATION_VERSION), snapshot-format.ts (zod line
               schema), endpoints.ts, resources.ts (IndexStatus descriptor)
    data-dirs/ index.ts              chord-sheetsage cache dir
    shared/    config.ts             scope: auto | full | sample
    server/    tables.ts, snapshot.ts (download + sha + stream both files →
               ndjson.gz), load.ts (loadSections), load-job.ts, ensure.ts,
               find.ts (findLoopWindows, countLoopsByNextChord), handlers.ts,
               status-resource.ts, backup-source.ts
    e2e/       song-index-verify.ts
```

## Tables (as v1, with v2/v3 changes)

- `chord_sections`: v1's columns (`source` kept), minus melody.
- `chord_loop_windows`: v1's columns; `chord_tokens text[]` and `features text[]`
  with GIN indexes (`index(…).using("gin", t.chordTokens)`, the first GIN over a
  native array in the repo). Unique `(sectionId, shape, startBeat)`, FK cascade.
- `chord_index_state`: one row. `phase` (`downloading | building-snapshot |
  loading | ready | failed`), `done`, `total`, `error`, `snapshotSha`, `scope`,
  `derivationVersion`, `skipped` (jsonb **list** of `{ reason, count, examples }`
  ranked by count, up to 20 example ids each — a list, not a reason → entry
  object, because jsonb orders an object's keys itself), timestamps. It also replaces v1's `chord_index_imports`.
- `chord_index_request`: one row, `requestedAt` (v3).

`ExcludeFromFork` and `ExcludeFromBackup` on sections, windows and state, each
with its reason. `chord_index_request` is kept by both.

## Flow

- `POST /api/chord/index/ensure` → upsert request row → if state is not
  `ready` at the current snapshot sha, scope and derivation version (or is
  `failed`), enqueue the load job. Returns the current status.
- **Boot** (`onReady`): the same check, only when the request row exists.
- **Load job** (child process):
  1. under the flock: if no snapshot, download both files (sha256-checked), stream
     them, and write `sheetsage-<sha>.ndjson.gz` atomically (tmp + rename);
  2. in one transaction: delete sections for this load, stream the snapshot,
     keep the scope's sections, derive and insert in batches of ~200, writing
     `done/total` to the state row between batches;
  3. (API documents step: empty until the top-up exists);
  4. state row → `ready`. A throw → `failed` with the message, then rethrow.
  During a reload the old rows stay readable until the transaction commits; the
  status says `loading`.
- `findLoopWindows` / `countLoopsByNextChord` answer
  `{ kind: "not-ready", status }` unless the state is `ready`, never an empty
  list. `findLoopWindows` is v1's SQL; `countLoopsByNextChord` drops v1's
  `chord_tokens && unlocked` prefilter (§Corrections found in review, 1).
- **Backup source** `chord-song-index`: copies the snapshot file; reports skipped
  when there is none.

## Build order

1. `hooktheory/core`: `hookpadKeyAt` (+ test), golden script switched to it.
2. App root, `shell/core`, data dirs.
3. `song-index/core` + unit tests: token round-trip; features from spelling;
   `bars-4` on 4/4, 6/8, 3/4, a meter change, a key change, a section shorter
   than 4 bars; `beatToSeconds` on both alignment kinds; the sample rule is
   stable and keeps a song's sections together.
4. Snapshot builder, run once against the real files (scratch output), and the
   format's measured size recorded here.
   **Measured 2026-09-17:** download 6 s (20.1 + 95.9 MB); build 44–48 s;
   snapshot **8.7 MB** gzipped (115 MB unzipped — every chord field in full, so
   larger than v2's 49 MB estimate). 26,178 lines: 26,175 sections and 3
   `no-document` skips (`pJkmZPEjxqn` reads once the builder parses with the
   harmony schema and `bpm` is nullable — its tempo's bpm is `null` too).
   Derived without a database (~5 s): full scope 25,855 sections stored, 21,723
   with windows, 183,270 `bars-4` windows, 320 derivation skips; sample 1,328
   sections, 9,612 windows.
   **Decided while building:** no transaction around the whole load (§Flow step
   2 said one). The state row is the gate instead — the queries answer
   `not-ready` unless it is `ready`, only the load's last write sets that, and
   each batch of 200 sections is its own transaction — so progress commits and
   reaches the browser, and a dead load is restarted from a truncate.
5. Tables, load job, ensure, status resource, exclusions, config.
6. Query endpoints, backup source.
7. Plugin `CLAUDE.md`s (token format, alignment kinds, why no melody, the
   skip rules, measured sizes); track page card.

## Verification

1. `./equin test plugins/integrations/plugins/hooktheory plugins/apps/plugins/chord`.
2. `./equin build` (background): migrations, boundaries, type-check, docs.
3. On this worktree (scope `auto` → sample): a fresh boot does nothing (no
   request row). `ensure` → status goes `downloading → building-snapshot →
   loading → ready`; a second `ensure` mid-load does not start a second run.
   `query_db`: about 1.3k sections plus the pinned ones; the state row's
   `skipped` lists reasons.
4. Set scope `full`, `ensure`: 26,175 source sections accounted for (loaded +
   skipped by reason), about 22k with windows, about 184k `bars-4` windows.
   Record table sizes (`pg_total_relation_size`).
5. Query: unlocked {I, IV, V}, target IV, major → about 7.5k matching windows,
   every returned window inside the set; `EXPLAIN ANALYZE` uses the GIN index;
   p95 over 100 random pairs under 50 ms (script). `countLoopsByNextChord({I,IV,V})`
   ranks vi and V7 near the top.
6. Restart: nothing reloads. Bump `INDEX_DERIVATION_VERSION`, restart: reload from
   the snapshot with no download.
7. A backup lists the snapshot file, and the database dump holds no rows for the
   three excluded tables.
8. `e2e/song-index-verify.ts` drives 3–5 against the deploy.

## Corrections found in review (2026-09-17, after the first build)

Five findings from the code review of the step above, all fixed in place.
Numbers re-measured against the real snapshot and a throwaway database holding
the full index (25,855 sections, 183,270 `bars-4` windows).

1. **`next-chords` undercounted.** The query prefiltered on `chord_tokens &&
   unlocked` — the GIN index's selective shape — so a window sharing *no* chord
   with the unlocked set was never looked at, although a four-bar vamp on one
   chord is exactly the case where unlocking that chord adds a loop. It now
   counts every window of the shape with exactly one distinct chord outside the
   set, which is what `find` returns once that chord is unlocked. Knowing only
   I, the old query credited IV with 2,121 windows (really 2,313) and never
   mentioned the minor tonic, worth 1,542. The cost of being right is the scan:
   median of 6 runs on the full index, 36 → 87 ms for one unlocked chord,
   101 → 119 ms for eight. (A `NOT (chord_tokens <@ unlocked)` prefilter to skip
   already-playable windows was measured too: slower, 94 / 125 ms.)
2. **One overlap rule, not two.** The window derivation kept a chord overlapping
   `[start, end)` with a beat tolerance; the read that attaches a candidate's
   chords compared beats without it, so a candidate could carry a chord — and a
   token — its window never counted. Both now call `chordOverlapsWindow`
   (`core/loop-shapes.ts`).
3. **The candidate query names its columns.** It selected both whole rows, which
   decoded `keys`, `meters` and `tempos` (three jsonb columns) per candidate for
   nothing. `ORDER BY random()` stays: it sorts what the GIN index already cut
   down, p95 31 ms on the full index. The state row's read is now explicit for
   the same reason — the status never needs the skip list.
4. **The snapshot is decoded once per load.** The total the app counts down from
   was computed by a full pass over every line's every field, then the load
   decoded the file again. The count now reads four fields per line
   (`readSnapshotHeads`): 2.6 s → 0.87 s on the full scope, so a load's decode
   goes from ~5.2 s to ~3.4 s.
5. **The skip summary is a list.** It promised "sorted by count, largest first"
   while living in a `jsonb` column, where Postgres orders an object's keys
   itself. `SkipSummary` is now `{ reason, count, examples }[]`, the one shape
   that carries the ranking back out of the database.
