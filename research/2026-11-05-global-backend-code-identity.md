# The serving backend's code identity

2026-11-05. Found by task-1793837733 (why main boots ~74 times a day): on 11-04,
21 of 74 main deploys changed no file the backend loads, and still restarted
main. Each restart cost ~30 s of CPU, ~1 GB of transient footprint, a cut
WebSocket and a full resubscription per tab. A deploy can skip that restart
only when "the code main runs" can be measured soundly. Today it cannot be.

## What "the code a backend runs" is

It is the closure of the serving entry (`server-core/bin/index.ts`) with
**literal dynamic imports followed**. A module loaded lazily is still code the
process runs: if a restart is skipped and that file changed, the old process
lazily imports the new file and becomes a mix of two trees. That closure is
exactly what `packages/source-digest` hashes. The digest refuses a closure that
holds an `import(x)` / `require(x)` whose path is computed, because it cannot
vouch for code it cannot follow. So the requirement is a closure with no
computed load. Over-inclusion is safe: it only costs an extra restart.

Code that runs in **another process** is not part of this identity. That
covers a supervised job's child, a CLI command, a script run by path, and a
worker thread spawned by path. Each of those loads fresh code from disk when it
starts.

## Measured (main, 2026-11-05)

`server.generated` plus `machine.generated` with literal dynamic imports
followed is 5,958 repo modules. It contains 24 modules with computed loads, all
of them build tooling or framework selection. The tooling comes in through a
few edges:

| Entry that reaches it | What it reaches | Resolution |
|---|---|---|
| `checks/cache-prune/server` (a `run` body) | `checks/core` runner → check registry, exempt loader, codegen, lint | **fixed:** an `argv` body runs `./equin check-cache-prune` |
| `web-artifacts/prune/server` (a `run` body) | `web-artifacts/core` plan/compose/pipeline, `web-core` vite contributions | **fixed:** an `argv` body runs `./equin web-artifacts-prune` |
| `infra/deps` kinds, through ~15 barrels | `playwright-browser`'s `bun -e` script string holding `require(b)` | **fixed:** `scripts/record-executables.ts`, run by path |
| `plugin-tree/server` → `plugin-records/core` | `runRecordJobRequest`'s `import(moduleUrl)` | **fixed:** the worker entry (`bin/record-worker.ts`) passes its own `import` as the loader |
| `asset-mirror/bundle/server` | `runAssetMirrorPrewarm`'s `import(registry)` (release only) | **fixed:** moved to the bundle's `cli/` barrel (no backend registers it) |
| `server-core/bin` | registry selection (`plugins-active.ts`) and `coreBarrel` | **fixed:** each composition has its own serving entry (`bin/index.ts` for main, a generated `bin/index.composition.<id>.generated.ts` otherwise) importing its registries by literal path; the spec's `command` runs it and `serve` checks it against the spec's `composition`. Core barrels warm through a literal `core` loader per registry entry |
| `plugin-tree/server`, `composition/server`, `deploy-secrets/approvals/server` | the facet framework (`load-facets.ts`, which hides `facet.generated` behind a computed specifier on purpose), and through it codegen, web-artifacts, exempt and lint | **fixed:** `facets/core` holds only the data accessors (the loader moved to `facets/loader`), the faceted build moved out of `plugin-tree/core` into `plugin-tree/faceted`, and the backend reads the faceted tree as JSON from `./equin plugin-tree-facets` (a child reading the shared plugin records) |
| `type-check/server`, `type-check/backstop/server` (a `run` body) | `checks/core` runner | **fixed:** the backstop's `argv` body runs `./equin type-check-backstop`; `spawnTypeCheckWorker` takes a required `tree`, read by CLI callers through `type-check/cli`'s `readTypeCheckTree` |
| `worktree/reclaim/server`, `serve-composition/server` | codegen's barrel, used for a registry listing and a reset | **fixed:** the per-composition registry grammar and listing moved to `codegen/composition-registries` (over the new `collected-dir/discovery`), the off-disk config read to `config_v2/disk-read`; the reset's re-propagation (which evaluates every barrel) runs as `./equin config-propagate` in a child |

The headline finding is that **main runs build tooling in-process**. The
clearest case is the facet framework: Studio and the deploy-secrets gate build
the faceted plugin tree inside the serving backend. Restart-skip is blocked by
that tooling, not by any app logic.

## Design

1. **Rule: build tooling never runs in the serving process.** Work that needs
   tooling runs out of process: a supervised job's `argv` body, a CLI command,
   or a script by path. The backend reads the result as data. A `run` body
   counts as backend code even though it executes in a child, because the
   backend imports it to register it. Tooling work therefore takes `argv`.
2. **Code the backend does run loads by a literal path**: a string-literal
   specifier, a generated registry of literal loaders, or a loader the caller
   injects from outside the guarded closure (as `runRecordJobRequest` now
   does).
3. **Guard: `boot:closure-digestable`** (`debug/profiling/boot/check`, next to
   `boot:closure-no-dev-tooling`). It measures the bin plus every
   server/machine registry barrel with `importClosures(…, follow)`, and reads
   each module with source-digest's own `computedLoads`, so the guard and the
   digest cannot disagree. It charges each finding to the entry (the bin or one
   barrel) whose own subgraph reaches it, stopping at other entries. The
   owning plugin either fixes the edge or holds it as tracked debt in its
   `exempt/`. The entries it held as debt when it landed are all fixed (the
   table above), so a new computed load anywhere fails the check.
4. **The identity** (after the chain above, part of the restart-skip work).
   First sketched as `sourceDigest` over the serving entry plus the non-code
   inputs below, compared by the build with a digest the backend took at
   boot. What landed is stronger — see "Restart-skip, as built" below: equal
   digests do not prove what a process loaded.

## Non-code inputs a boot reads once

These are read at boot (or first use) and held for the life of the process,
and the import closure does not see them. Each one must be folded into the
identity, or the restart is not skipped when it moves.

| Input | Where | Why it must count |
|---|---|---|
| Migration SQL `database/migrations/data/*.sql` | `migrations/machine/internal/list-files.ts`, applied in `database/server` `onReadyBlocking` | A process applies migrations only at boot and holds its schema generation. In practice a new migration always ships with code, but it is not in the closure. |
| The spawn: `spec.json` `composition` and `command` (the cloned Bun binary, argv) | `server-core/bin/spec-composition.ts`; `cli/build/named-backend.ts` | Together they decide which app the process is and which runtime it runs on. `Bun.version` is not in the digest. |
| `tsconfig.base.json` `paths` | read by Bun at import (and by `Bun.resolveSync` in the digest) | Resolution of every `@plugins/*` specifier. Not hashed. |
| Root `package.json` / `bun.lock` (workspaces, overrides) | install | Per-package `name@version` is already in the digest. Workspace and override changes beyond that are not. |
| Environment from the gateway (`-child-env`) and argv (`--namespace`, `--socket`, principal flag) | `declare-namespace.ts`, `pin-toolchain.ts`, pg driver | Fixed per process. Owned by the gateway, not the build. |

These are **not** once-read inputs (they are live, or re-read per call):
`config_v2` JSONC (watched), document head (re-rendered on subscribe),
`dist/.build-commit` / `.build-graph` (re-read per call through the dist
symlink), pgbouncer config (converged on demand), and `mise.toml` (re-read by
each spawned tool). A skipped restart also leaves the deployment's server pin
(`build/deployment/machine/internal/server-pin.ts`, HEAD sampled at import) on
the old commit. `wantsBuild` would then read main as unconverged forever, so
the restart-skip work must re-pin it, as a decision recorded by the deploy.

## Boot cost

Every edge cut from the closure is also one less thing a boot evaluates or can
reach. `closure-no-dev-tooling` measures the eager half, and this guard
measures the lazy half too. The facet fix in particular moves seconds of facet
CPU off main's post-boot warm-up.

## Restart-skip, as built (2026-11-05)

`build/restart-skip`. Before restarting a namespace backend
(`deploy-namespace.ts`) or central (`run.ts`, main builds), the deploy asks
the running process — `POST /api/build/restart-skip/adopt` on the backend,
`POST /api/restart-skip/central/adopt` on central — with what the new spec
spawns (the Bun binary, the entry) and the commit. The PROCESS judges,
because only it knows what it loaded.

### Why not compare digests

A digest equality between the running backend and the new tree misses:

- **A revert.** A lazily imported module changed, was loaded while changed,
  and was changed back: the tree's digest equals the boot digest, the process
  runs the in-between code.
- **The window between load and read.** A digest read after the imports can
  describe newer files than those loaded (the constraint the task named); one
  read before them can describe older ones, which a revert then matches.
- **A re-pointed package.** `node_modules` is Bun's isolated layout:
  `node_modules/zod` is a symlink into `.bun/zod@<v>`. Re-pointing it at an
  older store dir that is still on disk changes the code without touching a
  single file whose bytes the digest reads.

### The rule: nothing it loaded or could load changed since it started

Read by inode change time (`ctime`), against the process start
(`performance.timeOrigin`). The kernel sets `ctime` on every write, rename
into place, link or metadata change, and user space cannot set it back. So a
file whose `ctime` precedes the start held its present bytes from before the
start until now: whatever the process loaded from it, at any time, is what is
on disk. A rewrite of equal bytes counts as a change, and so does a revert.
`adopted` requires all of:

1. **Spawn**: the same Bun binary (real path) and entry, and the binary not
   replaced since the start.
2. **Runtime inputs**: `tsconfig.json`, `tsconfig.base.json`, `bunfig.toml`,
   root `package.json` untouched (read once, resolve every later import).
3. **Boot inputs** (`RestartSkip.BootInput`): the migration SQL dir (its own
   inode for an added or removed file, and each entry) untouched.
4. **Every loaded module** (`require.cache`: eager and lazy, repo files and
   package files, by real path) untouched.
5. **The closure on disk now** (`source-digest`'s `closureChangedSince`: the
   entry's closure, literal dynamic imports followed — what a fresh process
   would load and this one may still load lazily) measurable, every repo file
   untouched, every package resolution entry (`<dir>/node_modules/<name>`, the
   first walking up from the importer, by `lstat`) untouched — a re-pointed
   symlink or a new shadowing entry is a new inode — and each resolved
   package's `package.json` untouched.
6. **No stray module**: every repo module loaded is still in that closure.
7. **Every live child that dies with it**: a supervised worker or process
   (`infra/spawn/daemon` — the only way server code starts one; raw
   `new Worker` is linted out) is killed by a restart and respawned from the
   new tree, so a skip keeps it on the code it was spawned with. The
   supervisor records each incarnation's code (a worker's module; a
   process's executable and absolute code-file arguments) and spawn time;
   its executable and the closure of its entries must be untouched since IT
   spawned. A child whose code cannot be pointed at (no code-file argument —
   a `python -m`, a native binary's own data) refuses. Detached and attached
   daemons outlive a restart, so a skip changes nothing for them. (Found by
   the independent review: the sentinel worker's code is outside the
   backend's closure — it is started by URL, not imported.)

Anything else, including no answer (a backend predating the endpoint, still
booting, gone), is `restart`, with the reason in the build log.

On `adopted`, every `RestartSkip.Adopted` hook moves its per-process memo to
the deploy as a fresh boot would have read it: the deployment's server pin is
re-pinned to the build's commit (`wantsBuild` would otherwise read main as
unconverged forever), and server-build-id re-reads the served web graph the
live-resource runtime judges contract mismatches against (the deploy
published the dist first, so it is the graph built beside this code).

Not compared, on purpose: the spec's other fields. `web` is read per call
through the dist symlink; `composition` is decided by the entry. A field a
backend reads once that the spec grows later must join the comparison.

Residual assumption: the wall clock does not step backwards across a deploy
(`ctime` and `timeOrigin` share it).

Central needed its own closure made measurable first: its load waves warmed
core barrels by `import(\`@plugins/${pluginPath}/core\`)`. Its registry now
carries a literal `core` loader per entry, as the server's does, and
`boot:closure-digestable` covers central's bin and registry too.
