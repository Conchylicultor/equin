# Moving the ad-hoc external dependencies onto infra/deps

Follow-up to [`2026-09-29-infra-deps-v2.md`](2026-09-29-infra-deps-v2.md), migration item 2.

## Context

`infra/deps` is now the one system for external dependencies: you declare
them, they install on demand, their state is visible, and a gated updater
keeps them current. Five older dependencies still do this by hand, each with
its own "installed" test, its own locking, and its own update story:

| Dep | Today | Runs in |
|---|---|---|
| Sheet Sage dumps (`apps/chord/song-index`) | pinned URL and sha256, supervised job, its own flock, its own data dir | supervised job |
| IP-country DB (`deploy/analytics/ip-country`) | **unpinned** current-month URL, no sha, boot plus weekly cron, compiled to `ip-country.bin` | backend (deployed boxes too) |
| signal-origin shim (`packages/signal-origin`) | `cc` run synchronously on the first arm, content-addressed name, fail-open and silent. A release ships no `.c`, so it never arms there | **CLI ops**, with no backend |
| Gateway binary (`infra/launcher`) | `go build` into `<main>/gateway/gateway`, where `existsSync` counts as installed. Only `start` rebuilds it; `release` cross-builds it | **`./equin start`**, before any DB or backend exists |
| Chromium (`safe-fetch/browser-fetch/provision`, reused by the e2e harness) | `playwright install` at **every** `bun install`, with a stamp in `node_modules`. Cannot see a cache deleted by hand | provision, then backend, checks and e2e |

Two gaps block the move, and both are structural:

1. **The engine and the declarations only exist inside a booted backend.**
   `ensureDep` / `depState` live in `infra/deps/server`, and `DepDeclare` is a
   server contribution, collected only by a boot (which is why every
   `deps` CLI verb goes through `runExec`). The gateway is needed *before* a
   backend can boot. signal-origin arms in a CLI op, and Chromium is needed
   by e2e scripts and checks. None of these can reach a server-side
   declaration.
2. **There is only one kind, `python`.** A `download` kind and a `build` kind
   are missing, plus one for Playwright's browser.

**Decisions taken with the user:**
- **Chromium goes on demand.** Nobody downloads it at `bun install` any more.
  As a result no `at-install` dependency remains, so no `at-install` policy
  is built, and the two Chromium provision steps are deleted.
- **IP-country gets pinned** (URL plus sha256) and a monthly `db-ip`
  updater, so each new month is a gated commit like any other upgrade.

## Design

### 1. Declarations and the engine move below `server`: a new `deps/` barrel folder

A new **barrel folder `deps/`** joins the plugin vocabulary
(`framework/plugin-id/core` `RUNTIME_FOLDERS`), with this boundary row:

```
deps: ["deps", "core", "data-dirs"]
```

Every host-process row that needs dependencies gains `"deps"`: `server`,
`central`, `cli`, `check`, `e2e`, `scripts`, `bin`. `web` and `core` do not
gain it, because the engine reaches `paths/core` (`homedir()` at module eval).

- `plugins/<feature>/deps/index.ts` holds the plugin's `defineDep(...)` values
  as named exports, plus a `default` array of them.
- Codegen collects every `deps/index.ts` into
  `infra/deps/deps/deps.generated.ts` through `defineCollectedDir("deps")`.
  This is the same pattern as `provision.generated.ts`, and the file is
  committed and kept honest by the registry-in-sync check.
  `declaredDeps()` / `declaredDep(id)` read that generated file. `DepDeclare`
  (the server contribution) is **deleted**. The set is now known statically,
  so nobody has to boot anything to learn it.
- The engine moves from `infra/deps/server/internal/` to
  `infra/deps/deps/internal/`: `dep.ts`, `ensure.ts`, `store.ts`, `lock.ts`
  and `state.ts`. These are host-only, and depend on `data-dirs`, `spawn/core`,
  `flock` and `paths`. The `server/` barrel keeps what really is server work:
  the `deps.install` / `deps.sweep` jobs, the `deps.states` live value, and
  the endpoints.
- **Host admission is injected, not imported.** `withHostGrant` lives in the
  `host-admission` server barrel, which `deps/` cannot reach. `ensureDep`
  takes admission from the `ExecContext`. The two mints fill it:
  `supervised-job`'s run context and `cliExecContext` both use
  `withHostGrant`. `ExecContext` gains an `admit` field. Callers cannot
  forget it, because it is part of the brand.
- A new event-loop-safe read, `readyNow(dep)`, returns
  `{ kind: "ready", ready: Ready } | { kind: "absent" | "installing" | "failed", … }`.
  It is the fast path of `ensureDep` without the install, and it is how a
  request path gets a `Ready` for something already installed
  (ip-country lookup, browser-fetch). It pairs with `requestDep` for the
  not-ready arms.
- The `deps list | install | remove` CLI verbs **drop `runExec`**. They import
  the `deps` barrel directly. `upgrade` keeps `runExec`, because updaters are
  still server contributions. Moving them too is out of scope.

### 2. Three new kinds (sub-plugins under `infra/deps/plugins/<kind>`, each exporting from its `deps/` barrel)

- **`download`**: `download({ files: [{ name, url, sha256 }], derive? })`.
  - Identity inputs: every URL and sha256, plus `derive.version`.
  - Install:
    - Fetch each file into `env/<name>.part` through `ctx.run`
      (`curl -fL --retry`), so progress lands in the install log.
    - Check the sha256, then rename. A mismatch throws.
    - `derive?: { version, run(ctx) }` post-processes inside `env/`. For
      example, the CSV is compiled to `.bin` and the CSV is dropped.
  - No updater of its own. A pinned dataset says
    `updates: { none }`, or its declaring plugin contributes an updater that
    rewrites the pin (below).
- **`build`**: `build({ inputs: globs, tool: { argv, versionArgv }, output, run(ctx) })`.
  - Identity inputs: the sha256 of every file under the declared
    `git ls-files` globs, the output of `tool --version` (`cc --version`,
    `go version`), and `process.platform/arch`.
  - Install: `run(ctx)` builds straight into `ctx.dir` (`env/<output>`).
  - `isIntact` checks that the output exists.
  - `updates: { none: "built from this checkout's own source" }`: the source
    moves with the repo.
- **`playwright-browser`**: `playwrightBrowser({ browser: "chromium" })`.
  - Identity inputs: the `playwright-core` version, resolved through the module
    graph exactly as `provisionChromium` does today.
  - Install: `<bun> <playwright cli> install chromium` with
    `PLAYWRIGHT_BROWSERS_PATH=ctx.dir`. Then a one-line child with the same
    env writes `env/executables.json` (the headed and headless-shell paths)
    **as Playwright reports them**. That way Playwright's own answer is
    recorded, not re-derived.
  - `isIntact`: both recorded executables exist. This fixes the blind spot of
    a cache deleted by hand.
  - `launchChromium(ready, opts)` wraps `chromium.launch({ executablePath })`
    with the recorded headless-shell path. Taking a `Ready` makes "launched
    without ensuring" a type error.
  - Updater: none of its own. It follows the `playwright` npm pin, which is
    the future `npm` updater's job. The declaration says so in `updates.none`.
  - The shared `~/Library/Caches/ms-playwright` is no longer used. The deps
    sweep replaces Playwright's stale-browser GC.

### 3. Sealed installs for releases

A release bundle has no Go, no `cc` and no source, and it cross-builds for
Linux. So a build dep marked `bundle: { targets }` gets a matching
`sealDep(dep, { target, outDir })` step, which `release` calls instead of its
hand-written `go build`:

- The step runs the kind's install into the bundle, passing the target
  (`GOOS/GOARCH`, `CGO_ENABLED`, carried over from `goEnvFor` and
  `release/run.ts`).
- It writes `deps.sealed.json` (id to identity).

At runtime, when `deps.sealed.json` exists at `REPO_ROOT`, the engine uses
that identity and the bundled payload in place of `identityInputs`. This
generalises the gateway prebuilt path, and it lets signal-origin arm in a
release for the first time.

### 4. Per-dependency migration

**Sheet Sage dumps**, declared in `apps/chord/plugins/song-index/deps/index.ts`:
- Declaration: `sheetSageDumps = defineDep({ source: download({ files: [the two pinned files] }), updates: { none: "sheetsage-data is a frozen dataset pinned to a commit" } })`.
- `load-job.ts` calls `ensureDep(sheetSageDumps, exec)` in place of its own
  download. It keeps the `downloading` phase set before the call. The
  snapshot build and its `snapshot.lock` stay, because the snapshot is
  app-owned derived data (backed up, and it has a format version).
- `dump-files.ts`'s fetch/sha code and the `chord-sheetsage` data dir are
  deleted.
- `snapshot.lock` moves to the app's own dir.
- The old cache dir becomes an undeclared dir, and the data-dir orphan audit
  reports it.

**IP-country**, declared in `deploy/analytics/plugins/ip-country/deps/index.ts`:
- Declaration: `ipCountryDb = defineDep({ source: download({ files: [{ url: dbip-country-lite-<pinned month>, sha256 }], derive: { version: SNAPSHOT_FORMAT, run: compile CSV→ip-country.bin } }) })`.
- The pinned month and sha move into a small `core/internal/pin.ts` (plain
  data).
- Its plugin contributes a **`db-ip` updater** in its `server` barrel,
  through `UpdaterDeclare`:
  - `detect`: HEAD the next months' URLs.
  - `apply`: download, sha, rewrite `pin.ts`.
  - `smoke`: compile and look up a known IP.
  - The source's `updater: "db-ip"` makes `updates` implied.
- Boot runs `requestDep(ipCountryDb)`.
- `lookup.ts` reads through `readyNow`. It reloads when the ready identity
  changes, so the `reloadIpCountry` hook goes away. While the dep is not
  ready, it reports `unknown`, as today with no file.
- The `ip-country.refresh` job, its weekly cron, `snapshotNeedsRefresh`, the
  mtime test and the `ip-country` cache dir are deleted.
- Deployed boxes get a new month with the next release. That was accepted.

**signal-origin**, declared in `packages/signal-origin/deps/index.ts`:
- Declaration: `signalOriginShim = defineDep({ source: build({ inputs: ["plugins/packages/plugins/signal-origin/native/**"], tool: cc, output: "signal-origin.<dylib|so>" }), bundle: { targets: all } })`.
- `armSignalOrigin(ready, signals)` takes a `Ready`, which removes its
  internal `cc` compile, the content-addressed naming and the
  `signal-origin-native` data dir.
- `op-runtime/cli/signal-origin-tap.ts` awaits
  `ensureDep(signalOriginShim, cliExecContext())` **before**
  `installFatalSignalExit`, then arms synchronously in `afterInstall` as
  today.
- Fail-open is kept at the call site: an ensure failure becomes the existing
  `arm-failed` sink line. It is also now **visible** as `failed` in
  Settings → Dependencies, instead of silent.

**Gateway**, declared in `infra/launcher/deps/index.ts`:
- Declaration: `gatewayBinary = defineDep({ source: build({ inputs: ["gateway/**/*.go", "gateway/go.mod", "gateway/go.sum"], tool: go, output: "gateway" }), bundle: { targets: all } })`.
- `buildOrLocateGateway` becomes `ensureDep(gatewayBinary, cliExecContext())`
  in `start` (`cli/plugins/start/cli/run.ts`). `bootSelfContainedApp` reads
  the sealed install.
- `gatewayLaunchSpec` and the launchd plist take `ready.dir/gateway`. `start`
  already rewrites the plist each run, so a new identity is picked up there.
- `forceBuild` and `<main>/gateway/gateway` (plus its `.gitignore` line) go
  away. Rebuilding is now automatic whenever a Go source changes.
- `release/run.ts` replaces its `go build` block with `sealDep`.

**Chromium**, declared in `safe-fetch/plugins/browser-fetch/deps/index.ts`:
- Declaration: `chromium = defineDep({ source: playwrightBrowser({ browser: "chromium" }), updates: { none: "follows the playwright npm pin" } })`.
- Both `provision/index.ts` files are deleted (browser-fetch and
  e2e-harness). The `provision` registry keeps working with zero entries.
- The runtime callers:
  - **browser-fetch server** (request path): `readyNow`. When the dep is not
    ready, it calls `requestDep` and throws the existing typed
    `browser-unavailable` error with a new `installing` reason, never a stand-in
    result.
  - **prototype thumbnails render**: same as browser-fetch, or
    `ensureDep(ctx.exec)` if it runs inside a supervised job. Check this
    during implementation.
  - **layout-harness check / measure-page** (the CLI check process):
    `ensureDep(chromium, cliExecContext())`.
  - **e2e harness `withBrowser`**: `readyNow`. When the dep is absent, it runs
    `./equin deps install chromium` as a child process (the e2e
    process is off-loop, and the CLI no longer boots a backend for it), then
    reads again.
- The `e2e-harness:pinned-playwright-invocation` check still covers the new
  kind's spawn.

## Steps (each lands as its own reviewable commit, in this order)

1. **Engine relocation**:
   - Add the `deps/` folder to the vocabulary and the boundary table.
   - Collect `deps.generated.ts`.
   - Move the engine into the `infra/deps/deps` barrel.
   - Add `readyNow`, and put `admit` on `ExecContext`.
   - Move `hello-python` to a `deps/` declaration.
   - Delete `DepDeclare`.
   - Drop `runExec` from list/install/remove.
   - Update `infra/deps/CLAUDE.md` and remove the "not done yet" at-install
     note.
2. **`download` kind**, then Sheet Sage.
3. IP-country: pin, the `db-ip` updater, `readyNow` lookup, and deleting the
   refresh job. **Before pinning, check that db-ip keeps old months
   downloadable.** If it does not, stop and raise it: a stale release would
   404.
4. **`build` kind**, then signal-origin.
5. **Sealed installs**, then the gateway (`start`, launcher boot, `release`).
6. **`playwright-browser` kind**, then Chromium's callers, then delete both
   provisions.
7. `./equin build`, `./equin check`, tests.

These are large. If the session gets long, steps 5 and 6 are natural points
to file with `add_task`, each with this doc as its spec.

## Critical files

- Engine: `plugins/infra/plugins/deps/server/internal/{dep,ensure,store,lock,state,registry}.ts`, moving to `…/deps/deps/internal/`. CLI: `…/deps/cli/internal/{exec,install,list,remove}.ts`.
- Vocabulary and boundaries: `plugins/framework/plugins/plugin-id/core`, `plugins/framework/plugins/tooling/plugins/boundaries/core/boundary-config.ts`. Codegen: see how `tooling/plugins/provision/core/collected-dir.ts` feeds `provision.generated.ts`.
- ExecContext: `plugins/infra/plugins/jobs/plugins/supervised-job/{core,cli,server}`.
- Sheet Sage: `apps/chord/plugins/song-index/server/internal/{dump-files,load-job,snapshot}.ts`, `…/data-dirs/index.ts`.
- IP-country: `apps/deploy/plugins/analytics/plugins/ip-country/server/internal/{refresh,boot,lookup}.ts`.
- signal-origin: `packages/plugins/signal-origin/server/internal/signal-origin.ts`, `framework/plugins/cli/plugins/op-runtime/cli/signal-origin-tap.ts`.
- Gateway: `infra/plugins/launcher/server/internal/boot.ts` (`buildOrLocateGateway`, `gatewayLaunchSpec`, `bootSelfContainedApp`), `framework/plugins/cli/plugins/start/cli/run.ts`, `framework/plugins/cli/plugins/release/cli/run.ts` (~l.1143).
- Chromium: `infra/plugins/safe-fetch/plugins/browser-fetch/{provision,server/internal/browser-fetch.ts,…/errors.ts}`, `framework/plugins/tooling/plugins/e2e-harness/{provision,e2e/browser.ts}`, `apps/prototypes/plugins/thumbnails/server/internal/render.ts`, `primitives/css/plugins/layout-harness/{web/internal/measure-page.ts,check/index.ts}`.

## Verification

- **Unit tests** (`./equin test plugins/infra/plugins/deps`): the
  existing engine suite passes after the move.
  - New `download` tests: sha mismatch throws and leaves the dep absent;
    `derive` output only.
  - `build`: a changed input file gives a new identity.
  - Sealed manifest: it overrides `identityInputs`.
  - `readyNow`: every arm.
  - `@ts-expect-error`: a request handler still cannot call `ensureDep`, and
    `launchChromium` without a `Ready` does not compile.
- **Static registry**: `./equin deps list` with no backend built lists
  all six deps (hello-python plus the five).
- **Each migration, for real:**
  - **Sheet Sage**: `deps remove sheetsage-dumps`, then open the chord
    trainer. The gate shows downloading and then ready, and a second worktree
    reuses the install.
  - **IP-country**: `deps install ip-country-db` gives a `.bin`, and a
    collect call resolves a known IP.
    `./equin deps upgrade db-ip` returns `current` or `upgraded`.
  - **signal-origin**: `./equin check` arms it, and the sink has no
    `arm-failed` line. With `CC=false` and a fresh identity, the op still
    runs, and Dependencies shows `failed`.
  - **Gateway**: edit a comment in a `.go` file, then
    `./equin start --force` (with the user's OK, since it is
    system-level) builds a new identity and the plist points at it. A local
    `./equin release` bundle boots from the sealed gateway.
  - **Chromium**: after `bun install` in a fresh worktree, no Chromium is
    downloaded. The first `screenshot.ts` e2e run installs it once, and a
    second worktree reuses it. browser-fetch while absent returns
    `browser-unavailable/installing` and then succeeds.
- `./equin check` passes, including boundary-rules, plugin-boundaries
  and registry-in-sync.
