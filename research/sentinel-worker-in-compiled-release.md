# Sentinel worker + duress latch in compiled releases

## Problem

The cluster congestion sentinel (`plugins/debug/plugins/sentinel`) — sampler +
onset detector + **duress-latch lifecycle**, all on a dedicated Bun `Worker`
since Stage 5 — never runs in a compiled release. There are **two** independent
root causes, both of which must be fixed for the sentinel (and the duress
protection that gates shedding) to actually run in a release:

### Cause 1 — the start-gate excludes every release

`sentinel/server/index.ts` gates start on `onReady`:

```ts
onReady: () => { if (!isMain()) return; startSentinelSampler(); }
```

`isMain()` is `process.env.SINGULARITY_WORKTREE === "singularity"`
(`infra/paths/core/internal/paths.ts:24`). In a release the gateway spawns the
single backend with `SINGULARITY_WORKTREE=<composition>`
(`gateway/worktree.go:887`; the name is the composition — `launch.ts` →
`bootSelfContainedApp({ name: manifest.composition })`), so `isMain()` is
**false**. The sentinel is skipped **silently** (early return, no log).

`isMain()` was written for the dev topology where a *fleet* of worktree
backends sits behind the gateway and exactly one — main — must own the
host-wide cluster sentinel + latch (else N backends fight over one latch file).
The real invariant is "**this backend is the singleton sentinel owner for its
host**". A release runs **exactly one** backend (`boot.ts` writes a single
`writeWorktreeSpec`), so that one backend is the singleton — but `isMain()`
never admits it.

### Cause 2 — the worker module is not embedded by `bun build --compile`

Even if it started, `worker-host.ts` spawns:

```ts
new Worker(new URL("./worker/entry.ts", import.meta.url))
```

Verified on Bun 1.3.13: `bun build --compile` does **not** trace/embed a
`new Worker(new URL(...))` entry. In the compiled binary the spawn fails with
`ModuleNotFound` and the rapid-failure guard gives up after 5 tries with one
loud stderr line. (The URL form works from source — every dev worktree.)

Empirically reproduced (scratchpad):
- compile server-only → `ModuleNotFound resolving "/$bunfs/root/…/worker/entry.ts"`.
- A nested (non-entry) module's `import.meta.url` **collapses to the compile
  entry's path** (`/$bunfs/root/bin/server.js`), so any `/$bunfs/root/…`
  specifier depends on the entrypoint set's common ancestor → fragile.

## Fix

### Part 1 — admit the release's single backend (Cause 1)

- `launch.ts`: set `process.env.SINGULARITY_RELEASE ??= "1"` alongside the
  other vendored-asset env vars. It propagates launch → gateway
  (`spawnGatewayDaemon` uses `env: { ...process.env }`) → backend (the Go
  gateway forwards `os.Environ()`).
- `infra/paths/core/internal/paths.ts`: add `isRelease()` (symmetric with
  `isMain()`): `process.env.SINGULARITY_RELEASE === "1"`. Export from the core
  + server barrels.
- `sentinel/server/index.ts`: gate becomes `if (!isMain() && !isRelease())`
  for both `onReady` and `onShutdown`. Safe singleton: a release runs one
  backend.

### Part 2 — vendor the worker as a standalone `.js` (Cause 2)

Mirror the **exact** established precedent for un-embeddable release deps
(`SINGULARITY_PARCEL_WATCHER_NODE` — parcel-watcher `.node`; also migrations
dir, config tree, pg natives): vendor on disk + point an env var + dev
fallback.

- `release.ts`: after the existing vendoring steps, bundle the worker entry to
  a standalone `<out>/sentinel/worker.js` via `Bun.build({ entrypoints:
  [SENTINEL_WORKER_ENTRY], target: "bun", naming, outdir })` — **bundle** mode,
  not `--compile`; the worker's lean closure (latch leaf, log-channels,
  embedded-pg constants, pure detector/gatherers, `pg`) inlines into one file.
- `launch.ts`: `process.env.SINGULARITY_SENTINEL_WORKER_JS ??= join(bundleRoot,
  "sentinel", "worker.js")`.
- `worker-host.ts` `spawn()`: resolve the worker URL — vendored env path via
  `pathToFileURL` when set, else the dev source URL. Update the stale
  compiled-release caveat comment.

Verified in scratchpad: a `--compile` binary spawns an external on-disk bundled
`.js` worker via `pathToFileURL` and the closure is fully inlined.

### Why vendor-`.js` over add-as-extra-compile-entrypoint

The extra-entrypoint recipe (worker as a 2nd entrypoint on the server compile,
referenced by a `/$bunfs/root/…` specifier) works too, but the specifier is
tied to Bun's embedded-FS layout and shifts with the entrypoint set's common
ancestor — fragile and Bun-version-sensitive. Vendoring is independent of that,
matches every other release dependency, and keeps the worker closure isolated
from the server binary's composition-alias-overridden closure.

## Verification

- Existing worker tests unaffected (the test spawns its own source worker).
- End-to-end: `./equin release --composition <c> --dev` (staged; skips the
  slow self-extracting pack but still compiles the backend + launch and vendors
  the worker), run the staged `launch`, confirm the sentinel worker spawns:
  `sentinel` channel logs, no "giving up" line, duress-episodes readable.

## Docs

Update `sentinel/CLAUDE.md`'s "Compiled-release caveat" to describe the fix
(vendored `sentinel/worker.js` + `isRelease()` gate). `paths` autogen block
regenerates on build.
