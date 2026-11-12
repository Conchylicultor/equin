# plugin-records

Content-addressed records of what the build learns about each plugin, shared by
every worktree, so a build that changed nothing (or a fresh worktree from main)
recomputes nothing per plugin. Plan and measurements:
`research/2026-11-03-global-build-pipeline-step4-plugin-records.md`.

## The rule every record follows

A record's key is the hash of **everything its value is a function of** — blob
ids, other keys, the code that computed it — and nothing else (no path of this
checkout, no time). So a record never goes stale: a changed input is a new key,
and the old record is simply never asked for again. There is no invalidation
anywhere, and no global fingerprint: a change costs the records it touches.

## Three granularities

| Table | One record is | Keyed by |
| --- | --- | --- |
| `file` | a module's import specifiers | its blob id |
| `facet` | one facet's extract of one plugin (`plugin-tree/core/internal/facet-records.ts`) | the plugin's own files (what its snapshot holds), the facet's module Merkle key, the extraction harness, the lockfile's npm resolutions |
| `evaluated` / `module` | what importing a barrel produced, as data; the slots one module created | the barrel's (module's) Merkle key, the evaluator's |

- **Module graph** (`core/internal/module-graph.ts`): file facts + resolution
  against the snapshot give every module's **Merkle key** — its blob plus the
  keys of everything it imports (static and dynamic), cycles collapsed. An
  evaluated record is keyed by it, so it moves exactly when the barrel's
  loadable code does. **One graph per set**: every `buildModuleGraph` call
  over the same input (snapshot, store, `written` overlay, `readOutside` — each
  by identity; pass `NO_OUTSIDE_FILES`, never a fresh `() => null`) grows one
  shared graph, walking and keying only the modules no earlier call reached,
  and returns a view of exactly its entries' closure. A build asks ~9 closures
  of one snapshot; walked separately they visited ~31k modules for ~11k
  distinct ones (build pipeline step 12).
- **Evaluation** (the `evaluate` sub-plugin, apart so a producer that only
  makes keys and stores records does not key on barrel-import and
  slot-declaration): a barrel is imported live only
  when its record missed. Its exports are serialized (`serialize.ts`):
  functions become named stand-ins, symbols keep their description, slots
  become their **identity** — the module whose top-level evaluation created
  them plus an ordinal (`slot-declaration`'s `slotSite`, tracked from the first
  `importBarrel`) — and what cannot be data (a zod schema, a React element) is
  a value that throws when read. Readers (`codegen/core/evaluated-barrels.ts`)
  settle the slot naming over those stand-ins with `settleSlotNaming`.
- **Declaration-dependent barrels**: a plugin whose own modules subscribe to
  declaration passes (reorder, pane) fills its contributions from the whole
  declared set; its declared record is keyed also by that set, and a miss
  re-runs the live declaration pass over every barrel (and throws if any other
  barrel changed across it).

## Misses on worker threads

A record is a pure function of its key, so which thread makes it cannot change
it. A cold store (a new machine; an edit to a facet, which re-extracts every
plugin) therefore spreads its FACET misses over worker threads
(`core/internal/workers.ts`):

- A **record job** is a named function of plain data, defined at the top level
  of the module that owns the work (`defineRecordJob(import.meta.url, name,
  run)`; today `plugin-tree`'s facet extraction). A worker
  (`bin/record-worker.ts`) imports that module and runs the same function, so
  there is no second implementation.
- Workers **make records, never store them**: the reply carries the values and
  the caller stores them, in whatever store its process installed.
- The pool is the host process's to install (`installRecordWorkers`; the
  build's `cli/` `createPooledRecordWorkers`, about two threads per three
  cores, clamped to its grant, from stage 1 to the end of stage 2). Without one
  (a check pass, a test), or with a one-unit grant, every job runs in-process.
  A batch is split only when it has enough misses to pay a worker's start
  (`MIN_PLUGINS_PER_WORKER`), so a warm build starts none.
- **Barrel evaluation stays in-process, measured** (step 6,
  `research/2026-11-04-global-build-pipeline-step6-parallel-cold-records.md`):
  split over 4 workers it saved ~0.4 s on the web barrels and cost as much on
  the declaration-dependent pass (which needs every slot-creating module in
  one realm), because each worker reloads the shared closure (4 groups load
  14.7k modules for the web barrels' 7k) and a whole web import is only
  ~1.5–1.9 s.

## The store

`core` defines `RecordStore` (batched; async reads, synchronous writes) and a per-process memory
store (`currentRecordStore()` without an install). The build, `regen-generated`
and **every check pass** install the shared one, `cli`'s `openRecordStore()`:
one SQLite file (`<data root>/cache/plugin-records/records.v4.sqlite`, WAL), so
a pass computes only the records no checkout has made yet.

- **The layout is sized for a store larger than the page cache.** A lookup is
  one probe of `keys` (`tbl`, `key` → `val`, `used`; WITHOUT ROWID, ~50 B a
  row) and one of `vals` by its integer rowid (`id`, `vid` UNIQUE, `used`,
  `body` = the value zstd-compressed). Measured on the 24M-row v2 store
  (`research/2026-11-12-global-plugin-records-store-layout.md`), the layout
  before it was 8.8 GB, half of it values: `vals` was a WITHOUT ROWID table
  keyed by the value's hash, whose interior pages hold whole ~1 KB rows (8
  levels deep, a chain of overflow pages per value), and a `keys_vid` index —
  a quarter of the file, and a third B-tree under every insert — existed only
  so the reclaim could tell a value no key names. Never put large rows in a
  WITHOUT ROWID table, and never index the keys by value: the reclaim has
  `vals.used` (Reclaim, below).
- **Values are content-addressed too.** A key moves whenever anything in its
  producer's code closure moves, while the value almost never does (measured
  2026-11-05: 8.7M rows held 30k distinct values — 99% duplicates, 4.4 GB in
  two days). Each distinct value is stored once, found by its sha256
  (`vid`) when written, and a key row names it by its rowid.
- **No read holds the caller's thread.** `getMany` is async: lookups run
  on reader threads (`bin/record-reader.ts`, each its own connection, lazy,
  unref-ed when idle); what the process holds or read answers in-process, and
  a key already being read joins that read. A lookup is a random read of a
  multi-GB file (~0.5 ms on a loaded host, mostly I/O wait) and a check pass
  asks ~32k: in-process they held the one thread every check shares 10–15 s.
  A put stays synchronous (held until `flush`).
- **A key is read once per process.** A record is a pure function of its
  key, so the store keeps what it read and never asks SQLite for that key
  again (a no-change build re-read ~37k keys: the facet records for both
  trees, two generators' scans of one file set). Writes are not kept past the
  flush below.
- **Records are read a plugin at a time.** `readGrouped` stores a GROUP of
  records (one plugin's facet records, the file records of one plugin's files
  in a scan or a module-graph level) as one more record, in the `group`
  table, keyed by the member keys alone — a pure function of its key like any
  record, so never stale: a changed member is a new member key, so a new
  group key, and only that plugin's group misses. A missing group is read
  member by member and written once every member exists. A lookup is two
  random B-tree probes (~20 µs); a no-change build asked ~83k of them,
  0.43 s of SQLite (build pipeline step 13), now ~0.15–0.2 s: module
  records group by plugin too; evaluated records (one per barrel) stay per
  key.
- **No write holds the store long.** Every build, push and check pass on the
  host shares the file, and SQLite has one writer: a long write transaction
  queues every other writer, and one past the 30 s busy timeout makes theirs
  throw `SQLITE_BUSY` (2026-11-08, and again 2026-11-12). So:
  - **an open takes no write lock** — `auto_vacuum` is set only on a fresh
    file (setting it runs a write transaction even when already set), and
    everything else an open runs is a read on an existing store;
  - **writes are held back, then flushed.** `putMany` holds its records (its
    own `getMany` answers them at once) until `flush()`: one commit per call
    made a cold codegen's ~3,700 calls cost 4 s on a loaded host. `flush()`
    is async (it may wait in the writer line, below) and one runs at a time,
    in call order; past 64 MB held a put starts one on its own. Every process
    that puts records awaits a flush before it ends: the build at the end of
    codegen (before its check pass, another process, reads) and in
    `finalizeBuild`, the check runner right after its checks, before its
    verdict. The exit listener writes nothing — it cannot wait in a line —
    and only names what a process held and never wrote. A lost record only
    means it is computed again;
  - **a write reads nothing under the lock, and holds it a bounded TIME**
    (`writeBounded`). Before each transaction a batch of records is probed
    with no lock — a point lookup of a missing key ends on the very leaf its
    insert goes into, so the probe brings in every page the insert will touch
    (and drops a record another build already stored) — then the transaction
    commits once it has held the lock `HOLD_MS` (200 ms), whatever is left.
    The bound used to be a record count (2,000, measured 1.6 s on a 600k-row
    store); on 2026-11-12 the store was 23M rows / 8.5 GB, a random lookup on
    a host at load ~50 took 2–60 ms (its pages no longer cached), and one
    2,000-record chunk held the lock 44–58 s. A cost per record is not a
    constant; a time is. The next batch's probe is also the gap in which a
    writer waiting in SQLite's busy handler (which polls) gets the lock,
    rather than this one re-taking it commit after commit. The read path's
    once-a-day `used` refresh is written right after its read, on the pages
    it brought in, and not awaited: an answer never waits in the line;
  - **writers wait in line.** SQLite's busy handler is a lottery, not a
    queue: a waiter polls, and whoever polls when the lock frees takes it, so
    any writer could lose to every newcomer until its 30 s timeout threw
    (2026-11-12: a green check and a build turned failed by the throw, from
    the exit listener). So every write transaction first takes a ticket in
    the store's writer line (`packages/ticket-line`, the `<file>.writers`
    dir: first come, first served across processes, a dead holder's place
    freed by the kernel) and takes SQLite's lock only at its head. Each
    transaction's wait and hold are measured (`RecordWriteTiming`, in every
    flush outcome and the reclaim's line); a wait over 5 s or a hold over 2 s
    prints a line naming the process. A turn comes after each writer ahead
    commits one transaction, so a wait in the line is bounded at 120 s — a
    bound around another process (one stopped holding its ticket would
    otherwise hold every writer, and every verdict awaiting a flush). The
    busy timeout stays only as the backstop for a writer outside the line —
    never raise either: a write they end is something to find. A reader
    thread's `used` refreshes are coalesced to one write in flight;
  - **a lost write is an outcome, not a failure.** A flush the store could
    not make resolves `{ kind: "lost", reason }` (`RecordFlushOutcome`;
    `busy` — a writer outside the line, `sqlite` — another SQLite failure,
    `line` / `line-timeout` — the writer line's) — never a throw (only a
    programming error throws): it prints one line and, for the host's shared store,
    files a `plugin-records-write-lost` report (the `write-lost` sub-plugin)
    through the report outbox. The caller's verdict is untouched;
  - **one file version per write protocol.** A writer on code before the
    line takes the lock with no ticket (and one before the time bound held it
    44–58 s a chunk), so the line came with `records.v3.sqlite` (older code
    writes `records.v2.sqlite`), and the layout above with `records.v4.sqlite`
    (older code writes v3); the reclaim unlinks both. A future change to how
    writers take the lock, or to the schema, bumps the file again.
- **Reclaim** is main's daily `plugin-records.reclaim` job (the `reclaim`
  sub-plugin, a supervised `./equin plugin-records-reclaim`), never an open:
  key rows unread for 7 days are deleted a page at a time (read in key order
  with no lock, through `writeBounded`; a row read since is kept), then the
  values unread for 7 days the same way. That is safe with no index of keys by
  value because a value's `used` is at least that of every key naming it:
  every write of a key and every last-read refresh moves both in one
  transaction, so once the stale keys are gone a stale value is named by none
  (and one named again meanwhile fails the re-check). Then the freed pages are
  returned in steps sized to hold the lock ~`HOLD_MS`, each transaction taking
  its own turn in the writer line (so a build's write goes next, not after
  the whole reclaim) — on a file created with `auto_vacuum = INCREMENTAL`; any other keeps them
  for reuse, and the run says so. The earlier stores' files
  (`records.sqlite`, `records.v2.sqlite`, `records.v3.sqlite`) are unlinked by
  the same pass.

## Every input in the key — and a verifier

A record's key must name every input, **the producer's own code included**,
and nothing names that code by hand:

- file facts (the module graph's scan) are keyed by `scan-imports.ts`'s Merkle
  key, from a graph that reads no record (`fileFactsIdentity`);
- a file scan names its code by `url: import.meta.url` (`FileScan`), resolved
  to the repo module (`repoModuleOf`) — a scan moved to another file cannot go
  on being keyed by the one it left. That module is a `*.scan.ts` file holding
  only the scan and the code it runs (asserted on every scan): defined inside
  its generator, a scan was keyed by the generator's 300+-module closure and
  ~1 main commit in 4 re-keyed every file's record;
- a facet record by its facet's module and the harness that runs it
  (`facet-records.ts`), evaluated records by the evaluator's modules — each a
  Merkle key over its whole closure — plus the runtime and the lockfile's npm
  resolutions.

**The npm code is the lockfile's npm resolutions, never its blob**
(`npmResolutionsKey`: `bun.lock` minus its workspaces section and every
`@workspace:` line — `infra/deps/npm/lock-resolutions`, what type-check and the
browser host snapshot key on too). Adding a plugin adds its workspace stanza to
`bun.lock` and installs nothing; keyed by the blob, every new plugin re-keyed
every record of every producer. From 2026-11-04 to 11-10, 61 of main's 64
lockfile edits were workspace-only, against 0–18 edits of any producer's own
closure (the file-facts scan: 0), and the store reached 19M key rows (6.7 GB)
for ~480k distinct values
(`research/2026-11-10-global-plugin-records-store-growth.md`). An npm change
still re-keys every record — the next rung would be each producer's own
`lockfileNpmClosure`.

**A barrel load reads only what its key names.** Every barrel import runs
under barrel-import's load guard: while its modules' top level runs, a file
read (any `timed-fs` call), an environment read or `process.cwd()` throws
`BarrelLoadReadError`, naming the variable or file and the module that read
it — except the declared load inputs (`barrelLoadInputs()`: `NODE_ENV`, the
data root and `EQUIN_DIR`, the cluster's port and socket dir, a release's
migrations dir), whose values the evaluator key folds in. A module that needs
anything else from its host reads it at run time. See barrel-import's
`CLAUDE.md` for the span and what it does not see.

**A record names no checkout.** Records are shared by every checkout, so a
path built from `import.meta.dir` or `REPO_ROOT` (a `RestartSkip.BootInput`'s
`paths`) is an input no key can name. Evaluated records are stored with the
checkout root replaced by a placeholder and read back with the reader's own
(`checkoutRelative`). Before this, the store held `database/migrations`'
machine record naming other worktrees' `data/` dirs.

**What still escapes a key** is caught, not prevented:
`./equin check --verify-records` computes every record a pass makes again
(reads see only this process's own records) and compares each with the shared
store's value under the same key, writing nothing; any disagreement fails it.
Main's daily `plugin-records.verify` job (the `verify` sub-plugin: a lone
`server/`, so this plugin's build-tooling `core` stays out of the backend)
runs it over the tree checks, so a key that missed an input surfaces as a
failed job, never as a quiet stale read.

## A producer's key is its whole closure — so keep it narrow

A producer's code identity is the Merkle key of its module's **whole**
static+dynamic closure, and stays so: importing a barrel evaluates every module
it re-exports, and their top-level code (a slot created, a registry filled,
`globalThis` patched) can shape the value. Narrowing the key to "the modules
defining the names it uses" would ignore that, and a sound narrowing (the
bundler's tree-shaking, which keeps every module with a top-level call) was
measured 2026-11-05 to barely help: cross-refs 25 → 20 re-keys of 200 main
commits, the facet harness 16 → 14.

So the key stays whole and the producers are kept narrow, **guarded**: the
`key-width` sub-plugin walks a producer's closure through only the names it
imports from each barrel — unsound as a key, exact as a diagnostic — and
names the barrel imports that drag in modules it never calls. Each producer's
owner checks its own (`plugin-records:scan-key-width` over every `*.scan.ts`,
`faceted:facet-key-width` over the facets and the extraction harness), failing
over `MAX_UNUSED_KEY_MODULES`. The fix is always the same: move what the
producer takes into a leaf it can import alone (`boundaries/runtime-exception`,
`closure/entry-pattern`, `theme-engine/token-var-name`), or read it from the
producer's own input. Measure a producer's re-key rate with
`scripts/key-closures.ts`.

**The bound is never raised to pass a failing producer** — that keeps the
cost and only hides it; move the helper instead. It may change only when the
walk itself changes what it counts (a new kind of module it learns to see
through, or stops seeing through), re-measured over every producer the way
its docblock records — and then lowered as readily as raised.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Content-addressed records of what the build learns about each plugin (file facts, facet extracts, evaluated barrels), shared by every worktree's build and check pass; the daily plugin-records.verify job recomputes them on main and fails on any record that disagrees with its key.
- Core:
  - Uses:
    - `framework/plugin-id.pluginDirOfRepoPath`
    - `infra/deps/npm/lock-resolutions.lockfileNpmResolutions`
    - `infra/host-fs/user-path.AppPath`
    - `infra/host-fs/user-path.joinAppPath`
    - `packages/string-hash.sha1Hex`
    - `packages/string-hash.sha256Hex`
    - `packages/timed-fs.readFile`
  - Exports (types):
    - `BundledClosure`
    - `FileScan`
    - `ModuleGraph`
    - `ModuleGraphInput`
    - `ModuleNode`
    - `OutsideFiles`
    - `RecordFlushOutcome`
    - `RecordJob`
    - `RecordJobRequest`
    - `RecordStore`
    - `RecordTable`
    - `RecordWorkers`
    - `RecordWriteTiming`
  - Exports (values):
    - `buildModuleGraph`
    - `createMemoryRecordStore`
    - `currentRecordStore`
    - `defineRecordJob`
    - `emptyWriteTiming`
    - `gitBlobId`
    - `groupedByOwner`
    - `installRecordStore`
    - `installRecordWorkers`
    - `NO_OUTSIDE_FILES`
    - `npmResolutionsKey`
    - `outsideFilesAt`
    - `readGrouped`
    - `RECORD_TABLES`
    - `recordKey`
    - `recordWorkerCount`
    - `repoModuleOf`
    - `runRecordJobRequest`
    - `runRecordJobs`
    - `scanFilesCached`
    - `scanRepoFiles`
- Cli:
  - Uses:
    - `packages/thread-pool.createThreadPool`
    - `packages/thread-pool.serveThreadPool`
  - Exports (types):
    - `ReclaimResult`
    - `RecordDisagreement`
    - `RecordVerification`
  - Exports (values):
    - `createPooledRecordWorkers`
    - `describeVerification`
    - `idealRecordWorkerThreads`
    - `openRecordStore`
    - `reclaimRecordStore`
    - `serveRecordReads`
    - `verificationPassed`
    - `verifyRecordsAgainst`
- Cross-plugin:
  - Imported by:
    - `framework/cli/build`
    - `framework/cli/check`
    - `framework/cli/migrations`
    - `framework/cli/regen-generated`
    - `framework/cli/test`
    - `framework/cli/test/digest`
    - `framework/tooling/boundaries`
    - `framework/tooling/codegen`
    - `framework/tooling/web-artifacts`
    - `plugin-meta/plugin-records/evaluate`
    - `plugin-meta/plugin-records/key-width`
    - `plugin-meta/plugin-records/reclaim`
    - `plugin-meta/plugin-tree/faceted`
    - `plugin-meta/relocate`
- Exemptions:
  - Exempts itself from:
    - `imperative-create-table-allowlisted` — `cli/internal/sqlite-store.ts` (sanctioned)
    - `boundaries/no-platform-api` — `core/internal/outside-files.ts` (debt)
- Sub-plugins:
  - **`evaluate`** — Evaluated records: what importing a plugin barrel produced (its definition, slots, contributions), serialized as data under the barrel's module Merkle key, so a build reads it without importing…
  - **`key-width`** — How much of a record producer's key is code it never calls: keyWidths walks a producer's closure through the names it actually imports from each barrel and attributes the rest to the barrel imports…
  - **`reclaim`** — The daily plugin-records.reclaim job: on main, deletes the shared record store's key rows unread for 7 days and the values only they named, then returns the freed pages — a page at a time, off every…
  - **`verify`** — The daily plugin-records.verify job: on main, recomputes every plugin record a tree check pass reads (`./equin check --verify-records`) and fails when one disagrees with the shared store under the…
  - **`write-lost`** — plugin-records-write-lost report kind: validates the shared record store's lost-write payloads (filed through the report outbox by the store itself, one row per cause) and renders a task naming the…

<!-- AUTOGENERATED:END -->
