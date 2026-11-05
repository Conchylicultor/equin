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
| `server-core/bin` | registry selection (`plugins-active.ts`) and `coreBarrel` | task-1793843058-8yr0wg |
| `plugin-tree/server`, `composition/server`, `deploy-secrets/approvals/server` | the facet framework (`load-facets.ts`, which hides `facet.generated` behind a computed specifier on purpose), and through it codegen, web-artifacts, exempt and lint | task-1793843068-6u6ujy |
| `type-check/server`, `type-check/backstop/server` (a `run` body) | `checks/core` runner | task-1793843085-tgrdel |
| `worktree/reclaim/server`, `serve-composition/server` | codegen's barrel, used for a registry listing and a reset | task-1793843090-eqagj3 |

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
   `exempt/`. Eight entries are debt today, each tied to one of the tasks
   above. A new computed load anywhere else fails the check.
4. **The identity** (after the chain above, part of the restart-skip work)
   is: `sourceDigest` over the serving entry, plus the non-code inputs below.
   The build compares the new tree's identity with the one the running backend
   computed at its own boot. Equal means a restart is not needed.

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
