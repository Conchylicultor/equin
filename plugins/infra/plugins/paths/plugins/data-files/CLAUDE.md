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

## Where a root's files are read

A root is a folder of the host's file system (`infra/paths/file-systems`):
`DataFiles.get().location(spec)` is the data dir on the computer's disk on the
desktop, `~/.equin/<dir>` in the browser's storage in a browser host (served by
`plugins/memory`, which lays the host's roots out as that home folder). A
reader (the file viewer) names a root's file by that location — never by root
id.

## Browsing a root's files

A root defines nothing a person browses: its folder is a folder of the host's
file system (`~/.equin/<dir>`), which Files lists like any other — on the
desktop a hidden folder of the computer's disk, in a browser host a hidden
folder of the browser's home (`plugins/memory`). An app that wants a sidebar
entry adds an ordinary Files place pointing at it.

## Providers

| host | provider | notes |
|---|---|---|
| desktop | `data-files#machine` | single-descriptor reads (a racing remove is `missing`, never ENOENT), temp+rename writes, flock, one `defineFileWatcher` per watching root (named by the root, so the Background catalog lists it; declared in data-files), opened with `startEventualFileWatcher` so it follows the root's dir through a removal and re-creation or a replace (a `rescan` each time; the dir is made only on the first open), one ledger per ledgered root |
| browser | `plugins/memory` (base-excluded) | in-process tree, monotonic clock, keyed-mutex locks, one `changed` per microtask, never `rescan`; also serves file-systems' `browser` system: the home's own tree (`~/Documents`, …) beside every root under `~/.equin/` |

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

- Description: Data files: the files app-owned data dirs hold, on whatever host runs — the DataFiles host service (the computer's disk on the desktop, memory in a browser host) behind defineFileRoot, a root declared by the plugin owning the data dir: list / stat / read / write (atomic) / remove / rename (never replacing) / withLock / watch over validated relative paths, every miss a typed result and every mutation naming its writer. Each root's folder is a location in this host's file system (DataFilesImpl.location: the data dir on the computer's disk, or the same dir in the browser storage's hidden data folder), where file-systems' reads read its files. A person browses a root's files as a folder of that file system (Files), never through the root.
- Server:
  - Contributes: `host-service:data-files.store` "data-files.store"
  - Exports (types):
    - `DataFilesImpl`
    - `FileRoot`
    - `FileRootLedgerSpec`
    - `FileRootSpec`
    - `FileRootStore`
    - `FileRootWatchSpec`
    - `WatchedFileRoot`
  - Exports (values):
    - `assertNotRoot`
    - `DataFiles`
    - `defineFileRoot`
    - `listFileRoots`
    - `requireWatchSpec`
    - `watchedPaths`
- Machine:
  - Uses: `infra/file-watcher.startEventualFileWatcher`
  - Exports (values):
    - `diskDirMount`
    - `diskMount`
    - `FileRootLocation`
- Cross-plugin:
  - Imported by:
    - `apps/desktop/wallpaper`
    - `apps/prototypes`
    - `apps/prototypes/files`
    - `apps/prototypes/files/snapshot-history`
    - `apps/prototypes/fixtures`
    - `apps/prototypes/thumbnails`
    - `apps/sonata/covers`
    - `infra/asset-mirror`
    - `infra/paths/data-files/memory`
- Exemptions:
  - Exempts itself from: `check-thread-safety/no-blocking-check-work` — `check/roots.ts` (debt)
- Core:
  - Exports (types):
    - `DataChange`
    - `DataChangeHandler`
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
    - `copyTree`
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
- Test helpers:
  - Server: `@plugins/infra/plugins/paths/plugins/data-files/server/testing`
    - `CONFORMANCE_ROOT` — The suite's root: watched, with {@link CONFORMANCE_WATCH_EXTENSIONS}.
    - `CONFORMANCE_UNWATCHED_ROOT` — A root that declares no watch.
    - `CONFORMANCE_WATCH_EXTENSIONS` — The extensions the suite's watched root reports.
    - `describeDataFilesConformance` — Register the conformance suite for one provider. `makeHarness` is called once per test.
    - Types: `ConformanceHarness`
- Sub-plugins:
  - **`memory`** (excluded) — Data files in memory: provides the DataFiles host service for a host without the computer's disk (the browser composition), every root's tree kept in this process and written through to the host's…

<!-- AUTOGENERATED:END -->
