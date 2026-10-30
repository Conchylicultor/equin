# data-files

One file store for **app-owned data dirs**, on whatever host runs: the
`DataFiles` host service, reached only through **file roots** — the computer's
disk on the desktop (`machine/`), memory in a browser host (`plugins/memory`).
Plan: `research/2026-10-24-global-data-files-host-service.md`.

Not for arbitrary host paths: that stays `infra/host-fs` (desktop only).

## Declaring a root

The plugin owning the data dir (or a descendant) declares the root in its
portable `server/`, and binds it in its `machine/`:

```ts
// server/internal/roots.ts — portable: a root names its data dir, never a path
export const prototypesFiles = defineFileRoot({
  id: "apps.prototypes",               // unique, dotted kebab, a literal
  dir: "apps/prototypes",              // the data dir, `${kind}/${name}`, a literal
  watch: { name: "prototypes-files.tree", description: "…", extensions: [".html", ".css"] },
  ledger: { id: "prototype-picks", label: "Prototype option picks", under: relPath("_picks") },
});

// machine/index.ts — the half that may import data-dirs
contributions: [FileRootLocation(prototypesFiles, prototypesDir)],
```

Then `await prototypesFiles.read(relPath(id, "index.html"))`, once booted.

## The operations (`core/` — `Mount`)

`list` · `stat` · `read` · `write` · `remove` · `rename` · `withLock`, plus
`watch` on a root. Over `RelPath`s only — `relPath(...segments)` /
`parseRelPath(str)` / `joinRel` throw `InvalidRelPathError` on an empty
segment, `.`, `..`, `/` or `\` in a segment, NUL, or a leading `/`. Decode a URL
param before parsing it (`%2e%2e` decoded is `..`, refused).

- **Every miss is typed**: `StatResult` / `ListResult` / `ReadResult` have a
  `missing` arm (a missing directory is not an empty one); a file where a
  directory is expected (or the reverse) throws.
- `write` is atomic and creates parents. There is no `mkdir` and no `exists`.
- `remove` of nothing is a no-op; `recursive` is required, never implied.
- `rename` **never replaces**: `renamed | target-exists | missing`.
- `withLock(key)` — one holder per key across every process. On disk it is an
  flock on `<key>.lock` inside the root (`_picks/<id>.lock`), the same files the
  CLI takes; `LockBusyError` after 10 s of waiting, whether the holder is in
  this process or another.
- `watch(onChange)` resolves once changes flow; `{ kind: "changed", paths }`
  (filtered by the root's `watch.extensions` on every host) or, when the
  desktop's watch reports dropped events (`onLost` — there is no reconcile
  timer), `{ kind: "rescan" }`. Return the reaction's work —
  reactions are coalesced. Only a root declared with `watch` has the method
  (`defineFileRoot` returns a `WatchedFileRoot` for it, a plain `FileRoot` else).
- Every mutation names its `writer: WriteOrigin`. On the desktop an agent's
  write or remove under `ledger.under` is snapshotted in the agent-write ledger
  first; an agent's directory-sized change there throws (not revertible).
- Helpers over any `Mount`: `readText`, `copyTree`, `stageThenRename` (build a
  directory out of sight, rename it into place, never over another).

## Browsing a root (`browse`)

A root declared `browse: { label }` (it must also declare `watch` — tsc and a
throw) is readable by a generic browser on every host, by root id and a path
relative to it, never a host path. Served by the portable `server/`:

- `data-files.roots` — every browsable root (`id`, `label`, `dir`), fixed per build;
- `data-files.list` — a folder's entries, key-range-paged by name, its total
  as the meta sibling;
- `data-files.stat` and `data-files.text` (on demand, 2 MiB, binary-sniffed);
- `GET /api/data-files/:root/raw?path=` (`dataFileUrl`) — a file, served
  inert (`nosniff`, `sandbox` CSP but for a PDF, same-site only).

Each read refuses by code (`unknown-root`, `invalid-path`, `missing`,
`not-a-dir` / `not-a-file`, `too-large`, `binary`) and is pushed while read
from the root's watch — one subscription per root (a refcount hub), each read
notified by a change at, below or above its path. A change the root's
`watch.extensions` drops reaches a listing only with the next change that
passes it, or a dropped-events `rescan`. `readBrowsableFile` / `browsableFileRevision` / `watchBrowsableFile`
(server barrel) let another file reader serve a root's bytes (file-viewer's
`file-viewer.bytes`, the `{ source: "data" }` `FileRef`). The file explorer's
App data place (`apps/file-explorer/app-data`) is the browser.

## Providers

| host | provider | notes |
|---|---|---|
| desktop | `data-files#machine` | single-descriptor reads (a racing remove is `missing`, never ENOENT), temp+rename writes, flock, one `defineFileWatcher` per watching root (named by the root, so the Background catalog lists it; declared in data-files), one ledger per ledgered root |
| browser | `plugins/memory` (base-excluded) | in-process tree, monotonic clock, keyed-mutex locks, one `changed` per microtask, never `rescan` |

`diskMount(dataDir)` (machine barrel) is the disk operations for a `cli/`
process, which boots no graph — no watch, no ledger. `diskDirMount(dir)` is the
same over a directory that is not a data dir — checkout files a host process
reads (the prototypes template a mint copies, a check over the repo's
`prototypes/`); never a data dir.

`plugins/memory/server/testing` hands another plugin's suite a private
`createMemoryDataFiles()` (the prototypes snapshot history runs its contract
over one).

One conformance suite (`server/testing`, `describeDataFilesConformance`) runs
against both providers; a new provider runs it too.

## Enforcement

- **Boot** (`fileRootBindings`, register phase): every declared root has exactly
  one `FileRootLocation`, naming the data dir its `dir` says — else boot fails.
- `data-files:roots-bound`: roots declared in a `server/` with literal unique
  id and dir, bound to a `const`, and bound by exactly one `FileRootLocation` in
  a `machine/` that imports it from the declaring plugin.
- `data-files:root-owner`: a root's `dir` is declared in the `data-dirs/` of
  the declaring plugin or an ancestor.
- `data-files/no-direct-store` (lint): no `DataFiles.get()` through the barrel —
  a consumer holds its own `FileRoot`.
- `host-services:provider-placement` covers the two providers' placement.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Data files: the files app-owned data dirs hold, on whatever host runs — the DataFiles host service (the computer's disk on the desktop, memory in a browser host) behind defineFileRoot, a root declared by the plugin owning the data dir: list / stat / read / write (atomic) / remove / rename (never replacing) / withLock / watch over validated relative paths, every miss a typed result and every mutation naming its writer. A root declared `browse` (and watched) is readable by a generic browser on every host: data-files.roots, data-files.list (a folder's entries, paged by name), data-files.stat, data-files.text (on demand), each pushed from the root's watch while read, and GET /api/data-files/:root/raw (a file, inert).
- Server:
  - Contributes:
    - `resource.declare` "data-files.list"
    - `resource.declare` "data-files.list:meta"
    - `resource.declare` "data-files.roots"
    - `resource.declare` "data-files.stat"
    - `resource.declare` "data-files.text"
    - `host-service:data-files.store` "data-files.store"
  - Uses:
    - `infra/endpoints.rawEndpointHandler`
    - `network/live.serveValue`
    - `network/live.sliceRange`
  - Exports (types):
    - `BrowsableFileBytes`
    - `DataFilesImpl`
    - `FileRoot`
    - `FileRootBrowseSpec`
    - `FileRootLedgerSpec`
    - `FileRootSpec`
    - `FileRootStore`
    - `FileRootWatchSpec`
    - `WatchedFileRoot`
  - Exports (values):
    - `assertNotRoot`
    - `browsableFileRevision`
    - `DataFiles`
    - `defineFileRoot`
    - `listFileRoots`
    - `readBrowsableFile`
    - `requireWatchSpec`
    - `watchBrowsableFile`
    - `watchedPaths`
  - Resources:
    - `data-files.list` (keyed, window, notified)
    - `data-files.list:meta` (push, notified)
    - `data-files.roots` (push, fixed, whole: the file roots declared in code that opt in to browsing — a handful, fixed per build)
    - `data-files.stat` (push, notified)
    - `data-files.text` (invalidate, notified)
  - Routes: `GET /api/data-files/:root/raw`
- Core:
  - Uses:
    - `infra/endpoints.assetPath`
    - `infra/endpoints.AssetPath`
    - `infra/endpoints.blob`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
    - `packages/list-bound.wholeList`
  - Exports (types):
    - `BrowsableRoot`
    - `DataChange`
    - `DataChangeHandler`
    - `DataFileStat`
    - `DataFileText`
    - `DataFolderMeta`
    - `DataWatch`
    - `FileData`
    - `FileEntry`
    - `ListResult`
    - `Missing`
    - `Mount`
    - `ReadResult`
    - `ReadTextResult`
    - `RelPath`
    - `RemoveOpts`
    - `RenameResult`
    - `StatResult`
    - `WriteOpts`
  - Exports (values):
    - `BrowsableRootSchema`
    - `copyTree`
    - `DATA_FILE_TEXT_MAX_BYTES`
    - `DataFileEntrySchema`
    - `dataFileRoots`
    - `dataFilesRaw`
    - `dataFileStat`
    - `DataFileStatSchema`
    - `dataFileText`
    - `DataFileTextSchema`
    - `dataFileUrl`
    - `dataFolderListing`
    - `DataFolderMetaSchema`
    - `DataFolderQuerySchema`
    - `InvalidRelPathError`
    - `isWithinRel`
    - `joinRel`
    - `LockBusyError`
    - `parseRelPath`
    - `readText`
    - `relName`
    - `relParent`
    - `relPath`
    - `splitRel`
    - `stageThenRename`
- Cross-plugin:
  - Imported by:
    - `apps/prototypes`
    - `apps/prototypes/files`
    - `apps/prototypes/thumbnails`
    - `infra/paths/data-files/memory`
    - `primitives/file-viewer`
- Exemptions:
  - Exempts itself from: `check-thread-safety/no-blocking-check-work` — `check/roots.ts` (debt)
- Machine:
  - Exports (values):
    - `diskDirMount`
    - `diskMount`
    - `FileRootLocation`
- Test helpers:
  - Server: `@plugins/infra/plugins/paths/plugins/data-files/server/testing`
    - `CONFORMANCE_ROOT` — The suite's root: watched, with {@link CONFORMANCE_WATCH_EXTENSIONS}.
    - `CONFORMANCE_UNWATCHED_ROOT` — A root that declares no watch.
    - `CONFORMANCE_WATCH_EXTENSIONS` — The extensions the suite's watched root reports.
    - `describeDataFilesConformance` — Register the conformance suite for one provider. `makeHarness` is called once per test.
    - Types: `ConformanceHarness`
- Sub-plugins:
  - **`memory`** (excluded) — Data files in memory: provides the DataFiles host service for a host without the computer's disk (the browser composition), every root's tree kept in this process and lost with it — directories made…

<!-- AUTOGENERATED:END -->
