# corpus-index

Fingerprint-keyed incremental file index — the generalization of the
`stats/cost` usage-index template. Declare its format (core) in a small module,
then the index (server):

```ts
// my-format.ts — the parse and what it loads, nothing else
export const myFormat = corpusFormat(import.meta, {
  match: (p) => p.endsWith(".jsonl"),
  parse: (p) => parseOneFile(p), // side-effect-free, per-file
});

const index = defineCorpusIndex({
  name: "my.corpus",
  roots: () => [SOME_DIR],
  format: myFormat,
  indexPath: join(SOME_DATA_DIR, "index.json"),
  scope: "host",   // host ⇒ persist only on main; worktree ⇒ always persist
});
```

- **The stored index is stamped with the format's code, not a version.**
  `corpusFormat(import.meta, …)` names the declaring module; the index file
  carries the `sourceDigest` (`packages/source-digest`) of everything that
  module loads, and an index stamped with another one is rebuilt. Change
  `match` or `parse` — or anything they import — and the next load re-parses
  the corpus; there is no constant to bump. Keep the format module narrow: an
  unrelated import moving the digest costs a full rebuild.

- **An append-only file is read from where it stopped (`lines`).** For a
  newline-delimited file that only grows (a transcript), declare the reading
  as a fold over its lines instead of a whole-file `parse`:

  ```ts
  corpusFormat(import.meta, {
    match: (p) => p.endsWith(".jsonl"),
    lines: {
      start: (path) => ({ total: 0 }),          // fresh state, before line 1
      line: (s, line) => { s.total += …; },     // one complete line, in place
      partial: (s) => ({ total: s.total }),     // a SNAPSHOT — share nothing mutable
      save: (s) => ({ total: s.total }),        // the state as JSON (its checkpoint)…
      load: (saved) => ({ total: saved.total }),// …and back: folds on exactly as `s`
    },
  });
  ```

  The index holds each file's fold state (`line-reader.ts`) and folds only the
  bytes appended since its last read — an append costs its own bytes, not the
  file. The cost corpus re-read a whole transcript on every line its agent
  wrote: ~1 s per append for a 100 MB transcript, O(n²) over a conversation.
  A state continues only while the file is provably the one it read (same
  inode, not shorter, the 64 bytes before the held offset unchanged);
  anything else folds the file again from its start. Only
  newline-terminated lines are folded: a trailing line still being written is
  read once its newline lands.

  **A fold state outlives the process (`checkpoints.ts`).** Each file's state
  is checkpointed on disk (`save`) with the offset, inode and tail bytes it was
  folded to, under `<indexPath>.lines/<format digest>/`, once a read has folded
  1 MiB past the last checkpoint (and 8× its size, so writing them costs at
  most 1/8 of the bytes folded). A process's first read of a file — after a
  backend restart, ~74 a day on main — continues from its checkpoint, validated
  like a held state: O(state + bytes since the checkpoint), where it re-folded
  the whole file (106 MB transcript: 100–540 ms → 1–25 ms,
  `scripts/bench-restart.ts`). Only the persisting backend writes checkpoints
  (the index's own persist rule); the others read them. A file that leaves the
  index drops its checkpoint, and the first write of a process removes every
  other digest's directory. In memory, states are held for the 64 most
  recently read files (the live ones) — the corpus's states held at once would
  be every message hash ever written; an evicted file's next read continues
  from its checkpoint like a restart's.

- **A change persists its entries, not the document (`store.ts`).** The index
  on disk is a snapshot plus an append-only log of the entries changed since
  (`<indexPath>.<generation>.log`); a pass appends the entries it moved, where
  it used to rewrite the whole document (3.7 MB of JSON per transcript append
  on main). The journal cursors move by a log line too (`{ c: [...] }`,
  appended after the entries they vouch for, once the whole pass has landed),
  so a checkpoint every few minutes costs a line, not a 3.7 MB rewrite. The
  log is folded into a new snapshot once it outgrows it. Each snapshot names
  its log's generation, so a log left by a crash is never replayed over a
  newer snapshot.

- `ensureFresh()` — lazy `(mtimeMs,size)` stat-diff. **Call on every read**: it is
  the correctness fallback that makes warmup deferral safe (a cold request just
  pays the incremental diff, re-parsing only what changed). Returns the
  `CorpusDelta` — `{ addedPaths, modifiedPaths, removedPaths }` — of files that
  moved (all empty when nothing changed, including the main-only clean
  short-circuit). It is single-flighted: a concurrent second caller **joins the
  in-flight refresh and receives that same delta**, never a silent empty one.

  **`added` ≠ `modified`, and conflating them is a bug.** A path is `added` when
  the index held no fingerprint for it — which on a *cold* index (the first walk
  of a process, or any `host`-scope backend, which never persists) is **every
  file**. "No prior fingerprint" means *unknown*, not *edited*. Only
  `modifiedPaths` (a prior entry existed and its `(mtimeMs,size)` differs) proves
  the bytes changed since the last walk, so only `modifiedPaths` may drive "re-do
  the work for this file". To decide whether a file is genuinely *new*, ask your
  own store — never `addedPaths`. (Sonata's MIDI folders learned this the hard
  way: keying re-import off the old conflated `changedPaths` re-imported the
  entire corpus on every worktree boot.)
- `entries()` — the current per-file partials keyed by path. The **rollup stays in
  the consumer**.
- `markDirty()` — force the next `ensureFresh()` to walk every root, even where
  a watch keeps the index fresh: the answer to a watch that reported dropped
  events. A watch that heard every change reports it instead (`startWatcher`'s
  own, or a consumer's through `markChanged`) — a walk is O(corpus).
- **Catch-up reads the journal, not the disk — per root.** Every pass saves,
  in the index file itself, one file-system journal cursor per root it walked
  or caught up (file-watcher's `journalCursor`, FSEvents on macOS), taken
  before the pass. A root this process has not caught up yet replays the
  journal from ITS cursor (`journalChangesSince`) and re-checks only the paths
  it names (`refreshCorpusPaths`) — O(changes since), where the walk was
  O(corpus): `~/Downloads` for Sonata's MIDI folders is 26k dirs, 2.7–9 s per
  walk. Fail-closed, per root: no cursor, a root on another volume, symlinked
  or replaced, a cursor over 7 days old, a reset journal or a dropped-events
  history ⇒ that root alone is walked; the others are left alone. A root that
  leaves the root set keeps its entries and cursor on disk (`entries()` hands
  out the current roots' only), so when it comes back it is caught up, not
  walked — a folder that read `checking` at one boot no longer costs a walk at
  the next. A caught-up root walks only when a walk is asked for
  (`markDirty`, a lost-events report). A watcher batch's pass never advances
  a cursor (events still in a debounce window at a crash would be skipped);
  the checkpoint below does. A backend that does not persist (a `host` index
  off main) replays main's saved cursors.
- **A live watch moves the cursors: `checkpoint()`** (the
  `corpus-index.checkpoint` job, every 5 min on main, over every index the
  process defined). **A replay costs the changes of the whole volume since
  its cursor, not those under the root**: FSEvents' history is volume-wide and
  filtered by path as it is read — ~0.15 µs per event id, ~300k events a
  minute on this machine (`file-watcher/scripts/bench-journal-replay.ts`:
  60M ids back → 9.4 s, naming 0 paths). With cursors moved only by a boot's
  pass, every boot replayed the journal since the previous one: the MIDI
  folders' two roots 24–44 s and the transcripts 16 s after a quiet
  half-day (2026-11-08). Now the replay covers at most two checkpoint
  periods plus the downtime. Two-phase, so a cursor is never saved ahead of
  the stored entries: a checkpoint takes a candidate cursor per root it can
  vouch for (caught up, its watch open, every loss the watch reported
  repaired by a walk or replay); the next one saves it once the watch has
  `drained()` (everything it received handed to its reaction — so every
  change before the candidate, a period old, was named to the index), a pass
  has re-checked those paths and logged their entries, and the watch neither
  reopened nor lost events since. It never does work owed to someone else: a
  walk due or a root not caught up ⇒ it skips (that pass saves its own
  cursors, and its delta reaches whoever asked). A crash anywhere leaves an
  older cursor: a longer replay, never a skipped change. Only a persisting
  backend checkpoints; the job runs on main, so a `worktree`-scoped index
  (none today) would still replay from its boot.
  This is why the format's code stamps the index: a walk used to repair a
  changed `match` / `parse` on the next boot; a journal catch-up re-checks only
  paths that moved, so files that newly match would stay missing until a walk.
- `startWatcher()` — main-only `@parcel/watcher` push freshness. A change batch
  re-checks **only the paths it named** (`refreshCorpusPaths`: a gone path drops
  its entries, a new directory is enumerated, a file goes through the
  fingerprint gate); the full walk is the cold pass, `markDirty()`, and the
  watch's dropped-events report (`onLost` — there is no timer). It used to re-walk the whole corpus on every batch — for
  the transcript corpus ~1.2k dirs and ~4k stats every couple of seconds while
  any agent wrote, 32k slow passes on main.
- `warmup()` — convenience `defineWarmup` wrapping `startWatcher` + `ensureFresh`.
  Consumers with extra warm work (e.g. pricing) write their own `defineWarmup`
  that calls `ensureFresh`/`startWatcher` instead.

### Own your own watcher (`watchedBy: "consumer"`)

A consumer that already watches the same roots on every backend (Sonata's MIDI
folders: its watch imports each file it hears) must **not** call
`startWatcher()` (it double-watches, is `isMain()`-gated, and throws on such an
index). It declares `watchedBy: "consumer"` and feeds its watch to the index:

- `markChanged(paths)` — each batch's paths. The next `ensureFresh()` re-checks
  only those, on every backend (an unwatched index off main walks every time).
- `markWatchOpened(root, watch)` — a root's watch just (re)opened: whatever
  moved under it before went unheard, so the next pass catches it up from the
  journal. Open the watch BEFORE the root enters `roots`, so no stretch of it
  is caught up that nothing was listening to. `watch` is the opened
  `FileWatcher` (its `drained` / `losses`, what `checkpoint()` asks it).
- `markDirty()` — only for the watch's dropped-events report (`onLost`).

```ts
const index = defineCorpusIndex({ /* …, */ watchedBy: "consumer" });
const watch = await myWatcher.start({
  dirs: [dir],
  onChange: (events) => index.markChanged(events.map((e) => e.path)),
  onLost: () => { index.markDirty(); void index.ensureFresh(); },
});
index.markWatchOpened(dir, watch);
```

### Enumerate-only (no `parse`)

Omit `parse` for a corpus that only needs the incrementally-maintained,
throttled, fingerprint-keyed **set of paths** — no per-file payload. The overload
yields a `CorpusIndex<null>` (every `entries()` value is `null`); `ensureFresh()`'s
delta (`addedPaths` / `modifiedPaths` / `removedPaths`) is the whole point.

```ts
const files = defineCorpusIndex({
  name: "my.paths",
  roots: () => [SOME_DIR],
  format: corpusFormat(import.meta, { match: (p) => p.endsWith(".md") }), // no parse
  indexPath: join(SOME_DATA_DIR, "index.json"),
  scope: "host",
});
const { addedPaths, modifiedPaths, removedPaths } = await files.ensureFresh();
```

Baked in from the template: `(mtimeMs,size)` fingerprint keying, atomic
temp+rename snapshots plus an entry log, drop-vanished entries, bounded concurrency +
`withHeavyReadSlot` + a macrotask yield between files, ENOENT tolerance, and
format-digest mismatch → rebuild.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Fingerprint-keyed incremental file index: defineCorpusIndex enumerates files under roots matching a predicate, re-parses only those whose (mtimeMs,size) changed through a bounded heavy-read-gated pipeline, drops vanished entries, and persists atomically (host scope ⇒ main-only). ensureFresh is the lazy on-read correctness fallback; startWatcher is main-only push freshness. The corpus-index.checkpoint job (every 5 min, main) saves each watched root's journal cursor up to where its live watch vouches, so a boot's catch-up replays only what no watch heard.
- Server:
  - Uses:
    - `infra/file-watcher.defineFileWatcher`
    - `infra/file-watcher.FileWatcher`
    - `infra/file-watcher.journalChangesSince`
    - `infra/file-watcher.journalCursor`
    - `infra/file-watcher.JournalCursor`
    - `infra/file-watcher.JournalCursorResult`
    - `infra/file-watcher.JournalReplay`
    - `infra/host/host-read-pool.withHeavyReadSlot`
    - `infra/jobs.defineJob`
    - `infra/warmup.defineWarmup`
    - `packages/source-digest.sourceDigest`
  - Exports (types):
    - `CheckpointOutcome`
    - `CorpusDelta`
    - `CorpusIndex`
    - `CorpusIndexSpec`
    - `CorpusWatch`
  - Exports (values): `defineCorpusIndex`
  - Register: `defineJob('corpus-index.checkpoint')`
- Core:
  - Uses:
    - `packages/source-digest.defineSourceSet`
    - `packages/source-digest.SourceSet`
  - Exports (types):
    - `CorpusFormat`
    - `CorpusRead`
    - `LineFold`
  - Exports (values): `corpusFormat`
- Cross-plugin:
  - Imported by:
    - `apps/sonata/sources/midi/folders`
    - `stats/cost`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `server/internal/corpus-index.ts`, `server/internal/store.ts`, `server/internal/checkpoints.ts` (debt)
    - `sink-safety/no-adhoc-file-sink` — `server/internal/store.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
