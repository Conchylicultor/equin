# host-storage

Where a browser host keeps its state, and what happens to it across reloads,
tabs and new builds. Design: the wiki page "Design: a browser host's data kept
in browser storage" (under the track "apps running in the browser").

```ts
// a host's worker entry (bin/browser-host.ts)
serveBrowserHost({
  scope: self as unknown as WorkerScope,
  storage: {
    kind: "persistent", name: "demo-workspace", migrations: bundledMigrations().map((m) => m.hash),
    start: { snapshot, whenOutdated: "reset" }, // `snapshot` from `@browser-host-snapshot/<host>`
  },
  async boot(storage) {
    const host = await bootBrowserHost({ entries, onUnmatched });
    return { server: runtimeBrowserServer(host), keys: new Set(host.keys), boot: host.boot };
  },
});
```

- **The storage is the host's option; where its data starts is the app's policy.**
  `{ kind: "memory" }` is lost with the worker (tests, an ephemeral host);
  `{ kind: "persistent", name }` is IndexedDB: `equin-host--<name>--db`
  (PGlite's `idb://` data dir) and `equin-host--<name>--stores` (the host
  stores' entries, keyed [store, key], plus the lifecycle record). A local app
  starts empty; a demo declares a starting snapshot (`start`, below).
- **A starting snapshot** (`core/internal/snapshot.ts`): the database's data
  directory (PGlite's `dumpDataDir`) and every store's entries in one file,
  taken ONCE by the build (`takeHostSnapshot`, run by the host's
  `bin/browser-host.snapshot.ts` through web-artifacts' `host-snapshots.ts`,
  whose address covers everything that can change its bytes — every module
  the take can run, derived from the script's import graph (the whole server
  graph the seed boots, this plugin's codec included), the bundled migrations
  and config, the host's own data files, the npm resolutions and the Bun
  version). The take's database opens from the initialized PGlite cluster
  the build hands it (`takeHostSnapshot`'s `cluster`, `databaseStart:
  { from: "initialized" }`: initdb's output, no app state), so a take never
  runs initdb. A fresh storage
  loads it instead of starting empty (`origin: { kind: "snapshot" }`), and its
  times move to now: the database's timestamp columns are shifted by the
  driver before anything reads them, each store's values by its owner's
  required `shiftTime` (`store(name, { shiftTime })`; a store not opened on
  that boot owes the shift, recorded in the lifecycle record, until it is).
  Its migrations must equal this bundle's, or the boot fails loudly.
  `whenOutdated` is the app's: `reset` (a demo) replaces stored data from an
  older snapshot — or from before it had one — with this one (`origin.
  replacedOutdated`; the page is not told — an update just starts on the
  fresh data) — whatever
  migrations it was stored at, since it is thrown away — and the new snapshot
  is loaded and checked BEFORE anything is wiped for it (offline, the stored
  data stays); `keep` (a user's data) never does. Data from a NEWER snapshot
  is refused, like data from newer migrations, and a claim from a worker with
  an older snapshot is refused by the holder.
- **Declared at the entry, read lazily** (`declareHostStorage` /
  `hostStorage()`), like the runtime namespace: the providers read it on first
  use, never at module evaluation; reading it undeclared throws. A test that
  boots a graph declares `memoryHostStorage()` (one stateless instance).
- **What persists**: the database (`database/pglite`, `relaxedDurability`,
  flushed before anything is recorded durable, and when the host retires) and the four in-memory host
  stores, each a working copy in memory written through to `store(name)`:
  `config` (`config_v2/browser-store`), `transcripts`
  (`conversations/transcript-source/memory`), `attachment-blobs`
  (`infra/attachments/memory-blobs`), `data-files`
  (`infra/paths/data-files/memory`). The in-process job queue
  persists in the database itself (`infra/jobs/in-process`: its rows are
  written in the enqueuing transaction). NOT persisted: the log sink (ring
  only).
- **Lifecycle record** `{ state, migrations, snapshot?, owedShift? }`: `seeding` found at open = a
  first boot died mid-way → wiped and started again (never half a seed);
  `migrations` holding a hash this bundle lacks = newer code migrated the data
  → `StorageNewerThanCodeError` (a `HostRefusedError`: the page shows "reload"),
  before anything touches it. `booted()` flushes everything adopted, then
  records `ready` with this bundle's migrations.
- **Migrations over stored data** need nothing here: the runner is ledger-based
  and applies the pending files in one transaction (a failure leaves the data
  untouched). Proven on a reopened on-disk PGlite by
  `database/pglite`'s `stored-data.test.ts`.
- **One owner; tabs join it, never take it** (`ownership.ts`): the exclusive
  Web Lock `equin-host:<name>`, held while open. A worker that finds it held
  claims it over a BroadcastChannel, saying which code it runs (migrations,
  snapshot, its script URL — the build) and its SharedWorker name. The holder
  answers by cause (`answerClaim`, pure): older code → refuse (the claimant
  fails `StorageNewerThanCodeError`, `{ kind: "outdated" }`); the same build,
  both SharedWorkers — another tab whose worker got another generation's name
  — → `join` at once (the claimant fails `{ kind: "join", worker }` and its
  pages connect to the holder); another build → yield once serving, its tabs
  told `updated`; dedicated workers (no SharedWorker) → yield, `unshared`.
  No timeout: the claimant waits on the lock itself. Design:
  `research/2026-11-11-framework-demo-tabs-join-never-take.md`.
- **Several tabs** share one SharedWorker per build (the page's
  `startShared(name)`; `serveBrowserHost` accepts every connection). A tab that
  goes away is noticed through the Web Lock its page holds for its end
  (`browser-server`'s `hello`).
- **End of life** (a SharedWorker host): the worker outlives its last tab
  (`extendedLifetime`), then retires — every request it was answering
  settled, `close()` (PGlite flushed and closed, every store write settled,
  the lock released), then the worker closes (`serveHost`'s `retire`, under
  `browser-server`'s retire lock, so no page connects to it meanwhile: a page
  moves to the next name). A write the tab made just before it closed or
  reloaded is kept. From the start of a close, as of a wipe, the holder
  answers no claim (`ownership.closing()`): the next worker waits on the lock
  and opens what this one wrote.
- **Reset** (`ToHost` `reset`): `wipe()` — close, then delete every IndexedDB
  database of the storage — every tab is told `ended: "reset"`, the worker
  retires (under the retire lock, so a stale tab asking for its name moves
  on), and the tabs reconnect to a fresh one (under a new name: a
  closing SharedWorker can still be matched by its old one — `demo/scope`),
  which starts from the snapshot again. From the wipe's start the holder
  answers no claim: a fresh worker started meanwhile waits on the lock and
  opens the wiped storage, rather than taking this one over.
- **The boot report says where the data came from** (`HostBoot.data`:
  `stored`, `snapshot`, …) and what opening the storage cost (a `storage`
  stage), in the page's `demo-host-boot` log line.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Where a browser host keeps its state: in memory (lost with the worker) or persistent (IndexedDB, named), declared once by the worker's entry point before boot (declareHostStorage / hostStorage). Gives PGlite its data dir and each in-memory host store (config, transcripts, attachment bytes, data files) a write-through store loaded at open; owns the lifecycle (fresh → seeded, a dead seed wiped, data written by newer code refused), the one-owner Web Lock with the version handoff between builds, and the wipe behind Reset.
- Core:
  - Uses:
    - `framework/browser-server.HostBooted`
    - `framework/browser-server.HostRefusedError`
    - `framework/browser-server.PortEnd`
    - `framework/browser-server.reportDataProgress`
    - `framework/browser-server.retireLockName`
    - `framework/browser-server.ServedHost`
    - `framework/browser-server.serveHost`
    - `framework/browser-server/host-storage/stored.ENTRIES_STORE`
    - `framework/browser-server/host-storage/stored.Lifecycle`
    - `framework/browser-server/host-storage/stored.LIFECYCLE_KEY`
    - `framework/browser-server/host-storage/stored.META_STORE`
    - `framework/browser-server/host-storage/stored.storagePrefix`
    - `framework/browser-server/host-storage/stored.storesDbName`
  - Exports (types):
    - `BrowserHostStorage`
    - `DatabaseStart`
    - `HostSnapshot`
    - `HostSnapshotRef`
    - `HostStorage`
    - `HostStorageOrigin`
    - `HostStorageSpec`
    - `HostStorageStart`
    - `HostStore`
    - `HostStoreOptions`
    - `OpenedHostStorage`
    - `WorkerScope`
  - Exports (values):
    - `declareInitializedMemoryStorage`
    - `decodeHostSnapshot`
    - `encodeHostSnapshot`
    - `hostStorage`
    - `openHostStorage`
    - `serveBrowserHost`
    - `StorageNewerThanCodeError`
    - `takeHostSnapshot`
- Cross-plugin:
  - Imported by:
    - `config_v2/browser-store`
    - `conversations/transcript-source/memory`
    - `database/pglite`
    - `framework/tooling/web-artifacts`
    - `infra/attachments/memory-blobs`
    - `infra/paths/data-files/memory`
    - `ui/icons/sprites/bundled-symbols`
- Test helpers:
  - Core: `@plugins/framework/plugins/browser-server/plugins/host-storage/core/testing`
    - `declareMemoryHostStorage` — Declare that this process's browser host keeps its state in memory — what a test that boots a browser graph (PGlite and the in-memory host stores) declares before `bootBrowserHost`, as a host's entry point declares its storage.
- Sub-plugins:
  - **`stored`** — Whether this browser already holds a persistent browser host's data (hostDataStored(name)), read without booting anything — and the IndexedDB layout it reads, shared with host-storage's open (the…

<!-- AUTOGENERATED:END -->
