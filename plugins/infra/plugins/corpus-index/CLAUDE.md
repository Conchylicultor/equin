# corpus-index

Fingerprint-keyed incremental file index — the generalization of the
`stats/cost` usage-index template. Declare one with `defineCorpusIndex`:

```ts
const index = defineCorpusIndex<MyPartial>({
  name: "my.corpus",
  roots: () => [SOME_DIR],
  match: (p) => p.endsWith(".jsonl"),
  parse: (p) => parseOneFile(p), // side-effect-free, per-file
  indexPath: join(SOME_DATA_DIR, "index.json"),
  scope: "host",   // host ⇒ persist only on main; worktree ⇒ always persist
  version: 1,      // bump on TPartial shape change ⇒ full rebuild
});
```

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
- `markDirty()` — force the next `ensureFresh()` to re-walk **even on main**. This
  is load-bearing, not convenience: `ensureFresh` short-circuits on
  `!dirty && isMain()`, and `dirty` is otherwise only re-set by `startWatcher()`'s
  onChange. See the "own your own watcher" pattern below.
- **Boot catch-up reads the journal, not the disk.** Every full walk saves, in
  the index file itself, one file-system journal cursor per root (file-watcher's
  `journalCursor`, FSEvents on macOS) taken before the walk. A process's FIRST
  full pass replays the journal from them (`journalChangesSince`) and re-checks
  only the paths it names (`refreshCorpusPaths`) — O(changes since), where the
  walk was O(corpus): `~/Downloads` for Sonata's MIDI folders is 26k dirs,
  2.7–9 s per boot. Fail-closed: no cursor, a root added or dropped, a root on
  another volume, symlinked or replaced, a cursor over 7 days old, a reset
  journal or a dropped-events history ⇒
  walk. Only that first pass: a later `markDirty()` or lost-events report
  walks. A watcher batch's pass never advances the cursors (events still in a
  debounce window at a crash would be skipped). A backend that does not persist
  (a `host` index off main) replays main's saved cursors.
  **Bump `version` when `match` or `parse` changes meaning**: a walk used to
  repair that on the next boot; a journal catch-up re-checks only paths that
  moved, so files that newly match would stay missing until a walk.
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

### Own your own watcher (`markDirty`)

A consumer that already runs its own file watcher over the same corpus must **not**
call `startWatcher()` — that would double-watch, and `startWatcher()` is
`isMain()`-gated anyway. But on the main backend `ensureFresh()` short-circuits
while `!dirty`, so without an invalidation signal every refresh after the first
would silently reuse a **stale** index. `markDirty()` is that signal: call it from
your own watcher's onChange, then call `ensureFresh()`.

```ts
const index = defineCorpusIndex<MyPartial>({ /* …, no startWatcher() call… */ });
myWatcher.onChange(() => {
  index.markDirty();      // invalidate — the ONLY seam when you own the watcher
  void index.ensureFresh(); // re-walk in the background
});
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
  match: (p) => p.endsWith(".md"),
  indexPath: join(SOME_DATA_DIR, "index.json"),
  scope: "host",
  version: 1,
  // no parse
});
const { addedPaths, modifiedPaths, removedPaths } = await files.ensureFresh();
```

Baked in from the template: `(mtimeMs,size)` fingerprint keying, atomic
temp+rename persist, drop-vanished entries, bounded concurrency +
`withHeavyReadSlot` + a macrotask yield between files, ENOENT tolerance, and
version-mismatch → rebuild.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Fingerprint-keyed incremental file index: defineCorpusIndex enumerates files under roots matching a predicate, re-parses only those whose (mtimeMs,size) changed through a bounded heavy-read-gated pipeline, drops vanished entries, and persists atomically (host scope ⇒ main-only). ensureFresh is the lazy on-read correctness fallback; startWatcher is main-only push freshness.
- Server:
  - Uses:
    - `infra/file-watcher.defineFileWatcher`
    - `infra/file-watcher.journalChangesSince`
    - `infra/file-watcher.journalCursor`
    - `infra/file-watcher.JournalCursor`
    - `infra/file-watcher.JournalCursorResult`
    - `infra/file-watcher.JournalReplay`
    - `infra/host/host-read-pool.withHeavyReadSlot`
    - `infra/warmup.defineWarmup`
  - Exports (types):
    - `CorpusDelta`
    - `CorpusIndex`
    - `CorpusIndexSpec`
  - Exports (values): `defineCorpusIndex`
- Cross-plugin:
  - Imported by:
    - `apps/sonata/sources/midi/folders`
    - `stats/cost`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/corpus-index.ts` (debt)

<!-- AUTOGENERATED:END -->
