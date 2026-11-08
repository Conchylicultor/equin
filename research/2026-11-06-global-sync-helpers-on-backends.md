# Sync helpers and sync child processes on a backend's thread

Part of the responsiveness audit (task-1793965642-94fdhj). Task: task-1793980050-rdreq1.
Follows research/2026-11-06-global-no-sync-fs-on-backends.md.

## Problem

`blocking-fs/no-sync-fs` refuses a `node:fs` `*Sync` call written in a
`server/` / `machine/` / `central/` / `deps/` file. Main's event-loop-stall
reports kept naming blocking work the rule could not see:

- `core/` helpers called from a backend: `openSync ← openOwnedFd`
  (packages/owned-fd, 5.1 s), `readFileSync` / `realpathSync ←
  checkout-deploys` (infra/paths, 3.3 s), file-sink's sync tail read,
  `DataDir.ensure()` (`mkdirSync`), and timed-fs-wrapped calls whose caller
  the stall report cannot name (the top frame is the wrapper).
- synchronous child processes: `spawnSync` of `ps` / `pgrep` in runtime-sdk's
  agent-process (`livePid`, `childPids`), and others.

`core/` also serves the CLI, checks and scripts, so the folder cannot say
which thread runs a helper.

## Why not a call-graph lint

The natural fix — at a backend's call site, follow the callee into its body
and report when it reaches a `*Sync` — is unsound under the type-check lint
cache. A type-aware result is keyed on the file's text plus the
*declarations* it can see (research/2026-10-17-global-lint-keyed-on-what-it-reads.md);
no rule may read another file's source. A body edit in a helper adding a
`readFileSync` would leave every caller's cached "clean" verdict in place.

## Design: the name carries the fact (rung 3, cache-sound)

The fact must live in the declaration, and node already spells it there:
a blocking function is named `*Sync`.

1. **`blocking-fs/sync-named`** (type-aware, per file) — in a `core/`,
   `shared/` or `data-dirs/` folder (what a backend may import), a function
   that blocks is named `*Sync`. Blocking = it calls or hands on by reference
   a `node:fs` / `node:child_process` `*Sync`, `Bun.resolveSync` /
   `scanSync` / `spawnSync`, or any repo `*Sync` — so the name climbs through
   every wrapper by induction. A callback is charged to its enclosing named
   function; a method / property / field by its key; module scope, a
   constructor or an anonymous function has no name and is refused.
2. **`blocking-fs/no-sync-fs`** (extended) — on a backend, also refuses
   `node:child_process` `*Sync`, `Bun.spawnSync`, any `core/` / `shared/` /
   `data-dirs/` declaration named `*Sync`, and a blocking function handed on
   by reference. `closeSync` is not counted (it waits on no disk;
   `owned-fd/no-raw-fd-close` already confines it).
3. **`blocking-fs:sync-named-reach`** (check) — 111 helper files hold
   blocking functions; 70 of them no backend loads (codegen, web-artifacts,
   the check runner, …). Renaming those buys nothing, so their plugin
   declares a `sanctioned` `sync-named` exemption ("host tooling only"), and
   the check holds it true: a BFS of the runtime import graph from every
   backend module (static imports that do not erase + literal dynamic
   `import()`s), read off the tree's text. Measured: 5,445 modules in 1.3 s,
   identical to a `Bun.build` union closure of the 3,047 backend modules
   (5,449, the difference 4 JSON assets) which took 58 s.

`resolveRepoModule` moved from `boundaries/check` to `boundaries/core` so the
browser-realm check and this one resolve specifiers one way (and gained the
`.js`-module case: `sprites`' `icon-sets.js`).

## Migration

Inventory before (both rules, no exemptions): `sync-named` 604 messages over
297 functions in 111 helper files (41 a backend loads, 70 it does not);
`no-sync-fs` 42 more backend sites (the sync child processes).

- **Renamed to `*Sync`** where the function is a plain function a backend
  loads (≈95 functions, a TypeScript-language-service rename so every
  reference moved, then prose mentions): paths core (`readCheckoutOwnerSync`,
  `listWorktreeDirsSync`, `backupsDirSync`, `deploysForCheckoutSync`,
  `resolveCheckoutDeploySync`, the prune helpers, …), `openOwnedFdSync`,
  `readRunTerminalSync` / `observeRunSync` / `writeRunTerminalSync`,
  file-sink's `appendSync` / `appendAllSync` / `readTailSync` /
  `readJsonlTailSync`, `readDatabaseConfigSync` / `libpqEnvSync`,
  `readIconSetSync`, `hostCodeIdSync`, `findMiseBinSync`, … Its backend
  callers are now visible to `no-sync-fs`.
- **Made async** where the call is hot:
  - `openOwnedFd` is async (node's callback `open`, keeping the bare-number
    ownership `fs/promises`' `FileHandle` would break); `openOwnedFdSync` is
    the old one. Eight backend lock / log opens moved to it.
  - `spawnCaptured` / `spawnToFile` / `spawnPassthrough` — every backend
    spawn — no longer `mkdtempSync` / `writeFileSync` / `openSync` /
    `readFileSync` / `rmSync` per call; `holdParentLifeline` is async.
  - spawn-priority no longer stats `/usr/sbin/taskpolicy` on every demoted
    spawn (it ships with every macOS; a missing one fails the spawn loudly).
  - runtime-sdk's `livePid` / `childPids` (`ps` / `pgrep`), the build's
    `getHeadCommit`, the worktree's `branchExists`: `spawnSync` →
    `spawnCaptured` with a wedge-breaker timeout.
  - checkout-deploys: `lookupCheckoutDeploy` is async (the browser MCP's
    target resolution), sharing one judgment (`judgeLookup`) with its sync twin.
- **Exempted**: 70 tool-only helper files `sanctioned` (verified by the reach
  check); the rest `debt` — `sync-named` on backend-loaded files whose
  blocking functions are interface-bound or async-with-sync-inside
  (task-1793991095-ppkf09), `no-sync-fs` on backend files still calling a
  `*Sync` helper with no async twin (task-1793991088-yd3u37). Two
  `sanctioned` `no-sync-fs`: the server pin's module-eval `rev-parse`, the
  launcher's teardown `lsof`.

## Not done

- `DataDir.ensure()` / `.path` / `.file()` (68 calls, a `movedFrom` move
  inspection and `mkdirSync`) — an interface contract; needs moves resolved
  once at boot and an async `ensure`. Debt.
- file-sink's append path is synchronous by design (rotation in one
  process); an async queued writer is a redesign. Debt at each backend caller.
- host-semaphore's in-process fast path opens slot files synchronously.
- `paths` core's data-root resolution (`dataRoot()` → `resolveDataRootSync`)
  is memoized per process and read everywhere; renaming `dataRoot` was out of
  scope.
