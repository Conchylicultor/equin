# deps

Optional dependencies — a Python env, later a dataset or a built binary —
declared once, **installed on demand** off the event loop into a
content-addressed host-wide cache, with their **state visible**, and **kept
current** by gated updaters. Design: `research/2026-09-29-infra-deps-v2.md`.

## Using it

```ts
// plugins/<feature>/deps/index.ts — the plugin's `deps/` barrel
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { pythonEnv } from "@plugins/infra/plugins/deps/plugins/python/deps";

export const audioPython = defineDep({
  id: "audio-python",
  owner: "infra/audio-analysis",
  description: "Python audio tools",
  sizeHint: "≈500 MB",
  source: pythonEnv({ project: "plugins/infra/plugins/audio-analysis/python" }),
  // a source with no updater must say `updates: { none: "<why frozen>" }` (tsc)
});
export default [audioPython];   // what codegen collects into the registry

// in a supervised job's run body (or a CLI command) — never a request handler:
const ready = await ensureDep(audioPython, exec);        // exec: ExecContext
const out = await runPython(ready, { module: "pkg.mod", input, output: Schema, timeoutMs });

// from a request handler (event-loop safe):
const now = await readyNow(audioPython);                 // { kind: "ready", ready } | absent | installing | failed
if (now.kind !== "ready") await requestDep(audioPython); // server barrel: enqueues deps.install, returns at once
const state = await depState(audioPython);               // absent | installing | ready | failed
onDepInstallSettled(audioPython, () => resync());        // server barrel: that request's install ended

// from a check or an e2e script (host process, no ExecContext of its own):
const ready = await ensureDepViaCli(audioPython, { stdio: "inherit", grant: null }); // `./singularity deps install` child
// a check passes the grant its op holds: ensureDepViaCli(dep, { stdio: "capture", grant: ctx.grant })
```

- **Declare in `deps/index.ts`.** `deps/` is a barrel folder of its own
  (`plugin-id`'s `RUNTIME_FOLDERS`): host-only, reachable from `server`,
  `central`, `cli`, `check`, `e2e`, `scripts` and `bin`, never from `web` or
  `core` (the engine reads `paths/core`, `homedir()` at module eval). Its row
  reaches `deps`, `core` and `data-dirs`. Codegen collects every
  `deps/index.ts` with a `default` array into `core/deps.generated.ts`
  (`defineCollectedDir("deps")`, `core/collected-dir.ts`), committed and held by
  `plugins-registry-in-sync`. `declaredDeps()` / `declaredDep(id)` (async: they
  load the declarations once) read it, so a CLI op, a check or
  `./singularity start` knows the set without booting a backend.
- **The engine is the `deps/` barrel** (`@plugins/infra/plugins/deps/deps`):
  `defineDep`, `ensureDep`, `readyNow`, `depState`, `removeDep`,
  `declaredDeps` / `declaredDep`, `ensureDepViaCli`, `sealDep`, `holdDep` and
  `sweepUnusedDeps` (below). The `server/` barrel holds only server work: `requestDep` and the
  `deps.install` job (plus `onDepInstallSettled`, called when a run of it
  ends, so a request path that answered "not yet" resumes by push), the
  `deps.states` live value and the endpoints. An installer kind exports from its
  own `deps/` barrel too (`plugins/python/deps`).

- **`ensureDep` demands an `ExecContext`** (`supervised-job/core`). Only a
  supervised job's `run` body (`ctx.exec`) and a CLI command
  (`cliExecContext`, from the supervised-job `cli` barrel, which no `server/`
  file may import) have one, so a request handler cannot spell the call —
  `server/internal/types.test.ts` holds the `@ts-expect-error`.
- **Host admission comes with the `ExecContext`** (`exec.admit`, one
  background unit of `withHostGrant`, filled by both mints). The engine cannot
  import `host-admission/server` from `deps/`, and a caller cannot forget it.
- **`Ready<S>`** is returned only by `ensureDep` and `readyNow`'s `ready` arm;
  runners take it, so "forgot to ensure" is a type error. `readyNow` never
  installs: it is `ensureDep`'s fast path for a request path, which pairs it
  with `requestDep` for the other arms and answers "not available yet" —
  never a stand-in result.
- **`ensureDepViaCli(dep, { stdio })`** is for a host process that holds no
  `ExecContext` and must not mint one: a check (inside an op already holding
  its host grant, where an in-process `exec.admit` could wait on itself) and an
  e2e script. One `readyNow`; if not ready, a `./singularity deps install <id>`
  child (its own CLI process and admission, the same host flock), then
  `readyNow` again for the proof. `grant` (required) is the host grant the
  caller holds, or `null`: the child inherits it and its `exec.admit` spends one
  of those units instead of queueing host-wide behind its own parent
  (`admitBackground` honours `inheritedGrant()`). On a host whose whole fleet is
  one unit (8 GB: `B = 1`) that queue never ended — a build's check timed out
  installing Chromium that took 20 s alone. `"inherit"` streams the child's output,
  `"capture"` puts its tail in the error. Host code that cannot import the
  `deps/` barrel at all (a `web/`-row test driver) runs
  `./singularity deps install <id> --json` itself: one line
  `{ id, identity, dir }` on stdout, progress on stderr.
- The Dependencies view, the CLI, the install job and the sweep read the
  generic declared set and name no dependency.

## Layout on disk

`cache/deps/<id>/<identity>/`: `env/` (the payload), `ready.json` (written
**last** — its presence, plus the kind's optional `isIntact(env)`, is the whole
definition of "installed"), `install.log`, `installing.json` (while the lock is
held), `failed.json`, `last-used`, `holds/`. The lock is `locks/deps/<id>-<identity>.lock`
(a kernel flock: released on death, no pid consulted).

- **Identity** = sha256 of the kind plus every declared input the kind reports
  (`identityInputs(root)`: lock hashes, the installer's own version). Nothing is
  typed in by hand; a changed input is a new identity, so a new install.
  Worktrees on one identity share an install; a worktree trialling a bump gets
  its own.
- **Install in place, not temp-dir-then-rename.** A venv is not relocatable
  (its scripts and `pyvenv.cfg` name its own path), so the kind fills the final
  `env/` under the lock, after removing any partial one. `ready.json` last keeps
  "interrupted reads as absent" exactly as a rename would.
- **Once per machine.** Slow path: take the flock (waiting re-tries `flockTry`
  every 500 ms — only ever in an out-of-process context), re-check, install
  under `exec.admit` (one background unit of `withHostGrant`).
- **`admission: { none: "<why>" }`** on a source skips `exec.admit`: for an
  install too small to be worth a grant that a caller awaits on the way INTO
  an op of its own (the signal-origin shim, before `build` / `check` / `push`
  ask for theirs). Queuing there would hold the op behind the whole background
  lane, and inside a process already holding the host's slots it could wait
  for ever. The reason is required, like `updates.none`.
- **Sweep.** Daily `deps.sweep` (main-only by its schedule; the `sweep`
  sub-plugin, so the engine imports no `infra/worktree`) removes an identity
  that is current for no checkout `git worktree list` knows AND unused for 14
  days, never one whose lock is held, and never one that is **held**.
- **Holds.** `holdDep(ready, holder)` writes `<identity>/holds/<holder>`: a
  durable reference from outside any checkout — the launchd job naming the
  gateway binary by path, which relaunches it at the next login long after main's
  source moved on. One hold per holder per dependency: holding a new identity
  releases the holder's old one to the sweep (`./singularity start` holds
  `machine-gateway`).

## Sealed installs (release bundles)

A release host has no source, no toolchain and no network, so nothing can be
installed there. A declaration that must travel with a release says so:

```ts
defineDep({ …, source: build({ …, targets: "any" }), bundle: "required" });
// or bundle: { optional: "<what the app does without it>" }
```

- `bundle` type-checks only on a source with `forTarget(target)` — a kind whose
  payload is relocatable and that can install FOR a platform (`build` today;
  a venv is not relocatable). `forTarget` answers `{ ok: true, source }` (whose
  identity names the target) or `{ ok: false, reason }`, honestly.
- `sealDep(dep, { target, outDir, exec })` (what `release` runs for every
  declared `bundle` dependency, naming none) installs through the host cache
  under the target's own identity — same lock, log and `ready.json`; a second
  release reuses it — copies the payload to `<outDir>/deps/<id>/`, and records
  `{ kind, identity, dir, bytes }` in `<outDir>/deps.sealed.json` (with the
  bundle's `target`). A target the kind cannot produce fails the release for a
  `"required"` dependency and is recorded under `unsealed` (with the reason) for
  an optional one.
- **At run time**, when `deps.sealed.json` exists at the root the engine reads
  (`opts.root`, default `REPO_ROOT`), every entry point resolves from it and
  derives nothing: `ensureDep` / `readyNow` return the sealed `Ready` (no git, no
  toolchain, no cache, no `last-used`), `depState` says `ready`, and a dependency
  the bundle does not carry — or a bundle read on another platform — is `failed`
  with the reason (`ensureDep` throws it). `removeDep` refuses. The release
  launcher passes the bundle root (`bundledGateway(bundleRoot)`), because a
  compiled binary's `REPO_ROOT` is its virtual FS; a backend-side bundled
  dependency would need that root forwarded to the backend too (none exists
  yet).

## State

`depState(dep)` reads the files above (safe on the event loop). The
`deps.states` live value (external source) pushes every declared dep's row; a
`file-watcher` on `cache/deps` (payloads ignored) notifies while anyone is
subscribed. Settings → Dependencies (`web/`) is a DataView over it with
Install / Remove row actions. An identity that cannot be derived (uv missing)
is `failed`, never `absent`.

## CLI

`./singularity deps list | install <id> [--json] | remove <id> | upgrade <updater> [--only a,b]`.
`list`, `install` and `remove` import the `deps/` barrel directly — the
declarations are a generated registry and the engine is host-only code, so no
backend is booted and nothing needs to have been built (`install` passes
`cliExecContext()`). `upgrade` still boots this checkout's backend in `exec`
mode (`runExec`), because updaters are server contributions: it loads its
server-barrel imports only INSIDE the exec body (a relative
`await import("./…-body")` — plugin-boundaries R9 bans a dynamic
`import("@plugins/…")` of another plugin), since evaluating one before
`runExec` declares the runtime namespace throws (config_v2 resolves its dir at
module eval).

## Sub-plugins

- `updates` — the `Updater` contract (`core/`) and the generic runner (its
  `cli/` barrel, shared CLI machinery: baseline gates → move → candidate gates
  → retry-to-confirm → narrow → prove → verdict `current | upgraded | partial |
  regressed | aborted | holds-to-review`), lifted from `plugins/toolchain`. A crash in `apply` is
  a regression, not an abort; anything else that throws is `aborted`, and the
  receipt always ends on a verdict. A regressed batch is bisected by unit (a
  `Move.unit` — a lockstep group — never splits), each probe re-running only the
  confirmed regressions; what passes is proven by the full gates and lands
  (`partial`), each culprit is named with what it broke. Every exit that lands
  nothing puts the files back and runs each updater's `sync` (npm: `bun
  install` + `regen-generated`), so the installs match the files again. Design:
  `research/2026-10-16-global-deps-upgrade-always-reaches-a-verdict.md`. The
  runner takes a SELECTION of updaters: `./singularity
  deps upgrade` with no updater moves every one behind one baseline
  (receipt `deps-upgrade.json`); naming one moves only it
  (`deps-upgrade-<updater>.json`, `--only` allowed). **Holds** are one model
  for every updater (`Hold` in `core/`: `names`, `version` | `below`, `reason`,
  `issue?`, required `reviewBy` at most 90 days out): a hold is honoured until
  a diff deletes it — never released by its date. Each updater exposes its own
  through `holds.read`; the runner and the detect job refuse one set past the
  bound, and a hold past `reviewBy` (lapsed) is work: the detect job files the
  task for it ("Holds to review") and `deps upgrade` ends `holds-to-review`,
  touching nothing, until each is lifted or renewed. Each
  updater's check holds the bound statically (`deps-npm:policy`,
  `toolchain:resolved`, `deps-uv:holds`), and a held release is always
  detected as a HELD row (`heldWaiting`), never dropped. Design:
  `research/2026-10-17-global-deps-bounded-holds-every-updater-v2.md`. The `UpdaterDeclare` registry and the **Dependency upgrades
  automation** (`deps-upgrades`, a `tasks/automations` `defineAutomation`; its
  job `automation.deps-upgrades` runs on the schedule its automation config
  sets, weekly by default): ONE auto-started task covering every outdated
  INCLUDED updater, filed only while no task it filed is open, Dependencies
  category. Enabled, schedule, push policy, model, prompt template and which
  updaters take part are the automation's settings (Agent manager →
  Automations); the push policy decides whether the task's text authorizes a
  push.
- `npm` — every npm package a workspace `package.json` declares, as an
  updater (ranges + `bun.lock`, 3-day cooldown), plus the `dependencyPolicy`
  (lockstep groups, holds bounded to 90 days) and the `deps-npm:*` checks that
  forbid exact pins. See its `CLAUDE.md`.
- `mise` — the toolchain as the first updater (`toolchain upgrade` is its
  alias; `toolchain:resolved` stays in `plugins/toolchain`).
- `python` — the `python` kind (`pythonEnv`, `runPython`, `PythonEntryError`,
  its `deps/` barrel), its `cache/uv` + `cache/uv-python` dirs, and the `uv`
  updater (`server/`; every `python/` project's `uv.lock` and its exact
  `.python-version` pin — the CPython release, moved as `<plugin>:cpython` to
  the newest stable build the pinned uv offers — under one 3-day cooldown).
- `download` — the `download` kind (`download`, `downloadedFile`, its `deps/`
  barrel): `download({ files: [{ name, url, sha256 }], derive?, timeoutMs? })`.
  Identity = every url + sha256 (+ `derive.version`); install = `curl` into
  `env/<name>.part` through `ctx.run` (the progress meter lands in the install
  log), sha256 check (a mismatch throws, nothing is left under the name), rename;
  then `derive.run(ctx)` post-processes inside `env/` and must leave its declared
  `outputs`, which are what `isIntact` checks. No updater: a frozen dataset says
  `updates: { none }` (first user: `apps/chord/song-index`'s `sheetsage-dumps`).
- `build` — the `build` kind (`build`, `builtFile`, its `deps/` barrel):
  `build({ inputs: [globs], tool: { versionArgv }, output, run, targets?, admission? })`.
  Identity = sha256 of every file the `git ls-files` globs match at the root
  (tracked + untracked-not-ignored, read from the working tree; a glob matching
  nothing throws), the tool's version output, and the target platform/arch.
  `run(ctx)` builds into `ctx.output` (`env/<output>`) for `ctx.target`;
  `isIntact` = the output exists. `targets` (`"any"` or a per-target answer;
  omitted = this host only) is what `forTarget` — and so sealing — consults.
  No updater: `updates: { none: "built from this checkout's own source" }`
  (users: `packages/signal-origin`'s `signal-origin-shim`, host only;
  `infra/launcher`'s `gateway-binary`, `targets: "any"`, `bundle: "required"`).
- `playwright-browser` — the `playwright-browser` kind (`playwrightBrowser`,
  `launchChromium`, its `deps/` barrel; the `env/executables.json` record and
  its reader `readBrowserExecutables` in its `core/`):
  `playwrightBrowser({ browser: "chromium" })`. Identity = the
  `playwright-core` version resolved through the kind's own module graph (the
  one `launchChromium` imports `playwright` from) + the platform; install =
  the workspace's own playwright CLI (`process.execPath <cli> install
  chromium`, never a package runner) with `PLAYWRIGHT_BROWSERS_PATH` = `env/`,
  then a one-line child records the headed and headless-shell executables as
  Playwright's registry reports them; `isIntact` = both still exist.
  `launchChromium(ready, opts)` launches the headless shell (or, with
  `headless: false`, the headed binary). No updater of its own: it
  follows the `playwright` npm package, which the `npm` updater moves (user: `safe-fetch/browser-fetch`'s `chromium`, ~280 MB
  download, ~600 MB on disk). The shared `~/Library/Caches/ms-playwright` is
  not used; the deps sweep replaces Playwright's stale-browser GC.

Consumers of the `python` kind (outside this plugin): `audio-python`
(`plugins/infra/plugins/audio-analysis`, torch + Beat This! + librosa, ≈950
MB) and `youtube-audio` (`plugins/integrations/plugins/youtube`, yt-dlp for
the audio download and the search, a few MB) — two projects, so a weekly yt-dlp bump never reinstalls
torch.

## Not done yet (by design, follow-ups)

- A way for a `download` declaration to name an updater (IP-country is
  blocked: db-ip serves only the current and previous month, so a pinned month
  would 404 within ~2 months) — see
  `research/2026-09-30-infra-deps-migrate-adhoc-deps.md`. Every dependency is
  on demand; no at-install policy is planned (Chromium is on demand too).

## Traps

- **`mise install` in a worktree whose `mise.toml` declares a tool the lock
  lacks WRITES `mise.lock`** (mise 2026.9.10 appended the whole `[[tools.uv]]`
  entry). The mise updater computes the new lock from the text it read before
  installing and overwrites whatever mise wrote.
- **`UV_NO_CONFIG` also ignores the project's own `pyproject.toml` `[tool.uv]`
  and `.python-version`** — never set it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Settings → Dependencies: a DataView over every declared optional dependency (state, size, identity, last used, the install's latest log line) with Install / Remove row actions, pushed live from deps.states. The server half of on-demand dependencies: requestDep enqueues the deps.install supervised job (ensureDep in a detached child) from a request, the pushed deps.states live value says absent / installing / ready / failed for every declared dependency, the install/remove endpoints back Settings → Dependencies. The daily deps.sweep is its sweep sub-plugin.
- Web:
  - Slots:
    - `item-actions`
    - `dependencies.actions`
  - Slot contributors:
    - `item-actions` ← `infra.deps`
    - `dependencies.actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "dependencies"
    - `Settings.Sidebar` "Dependencies"
    - `item-actions` "install" → `InstallDepAction`
    - `item-actions` "remove" → `RemoveDepAction`
  - Uses:
    - `apps/settings/shell.Settings`
    - `infra/endpoints.useEndpointMutation`
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/data-view.DataView`
    - `primitives/data-view.defineDataView`
    - `primitives/data-view.defineItemActions`
    - `primitives/data-view.FieldDef`
    - `primitives/data-view.ItemActionProps`
    - `primitives/icon-button.IconButton`
    - `primitives/live-state.foldResource`
    - `primitives/pane.defineRoute`
    - `primitives/pane.Pane`
    - `primitives/pane.PaneChrome`
    - `primitives/relative-time.RelativeTime`
- Server:
  - Contributes: `resource.declare` "deps.states"
  - Uses:
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/file-watcher.defineFileWatcher`
    - `infra/jobs/supervised-job.defineSupervisedJob`
    - `network/live.serveValue`
    - `primitives/log-channels.defineLogSink`
  - Exports (values):
    - `onDepInstallSettled`
    - `requestDep`
  - Register:
    - `defineSupervisedJob('deps.install')`
    - `defineFileWatcher('deps.cache')`
  - Resources: `deps.states` (push, notified)
  - Routes:
    - `POST /api/deps/install`
    - `POST /api/deps/remove`
- Core:
  - Uses:
    - `framework/tooling/collected-dir.defineCollectedDir`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
  - Exports (types):
    - `DepRow`
    - `DepState`
    - `DepUpdates`
  - Exports (values):
    - `DepRowSchema`
    - `depsStates`
    - `DepStateSchema`
    - `DepUpdatesSchema`
    - `installDepEndpoint`
    - `removeDepEndpoint`
- Cli:
  - Uses:
    - `framework/server-core.runExec`
    - `infra/deps/updates.upgradeThisWorktree`
    - `infra/jobs/supervised-job.cliExecContext`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/font-family --font-mono`
  - Imported by:
    - `apps/chord/song-index`
    - `apps/prototypes/thumbnails`
    - `apps/sonata/transcription`
    - `infra/audio-analysis`
    - `infra/deps/build`
    - `infra/launcher`
    - `infra/mcp/browser`
    - `infra/safe-fetch/browser-fetch`
    - `integrations/youtube`
    - `packages/signal-origin`
- Deps:
  - Exports (types):
    - `BundleSpec`
    - `DefineDepSpec`
    - `Dep`
    - `DepSource`
    - `DepTarget`
    - `EnsureOptions`
    - `InstallContext`
    - `Ready`
    - `ReadyNow`
    - `RemoveOutcome`
    - `SealOutcome`
    - `SweepReport`
    - `TargetedSource`
  - Exports (values):
    - `declaredDep`
    - `declaredDeps`
    - `defineDep`
    - `depState`
    - `ensureDep`
    - `ensureDepViaCli`
    - `holdDep`
    - `hostTarget`
    - `readyNow`
    - `removeDep`
    - `sealDep`
    - `SEALED_MANIFEST`
    - `sweepUnusedDeps`
    - `UnknownDepError`
- Test helpers:
  - Deps: `@plugins/infra/plugins/deps/deps/testing`
    - `readyForTests`
- Sub-plugins:
  - **`build`** — The build installer kind of infra/deps: build({ inputs, tool, output, run }) (its deps barrel) declares something built from this checkout's own source — identity = sha256 of every file the git…
  - **`download`** — The download installer kind of infra/deps: download({ files: [{ name, url, sha256 }], derive? }) (its deps barrel) declares a dependency on pinned files — identity = every url + sha256 plus…
  - **`mise`** — The mise toolchain as an updater: contributes `mise` to the updater registry, so the Dependency upgrades automation includes it in the batched upgrade task and `./singularity deps upgrade mise`…
  - **`npm`** — The `npm` updater: moves every npm package a workspace package.json declares (its range and bun.lock) to the newest release past a 3-day cooldown, lockstep groups together, honouring reviewed holds…
  - **`playwright-browser`** — The playwright-browser installer kind of infra/deps: playwrightBrowser({ browser: "chromium" }) (its deps barrel) declares the browser build the workspace's playwright-core pins — identity = that…
  - **`python`** — The python installer kind of infra/deps (pythonEnv, runPython, PythonEntryError) over uv, with its caches as declared data dirs Its uv-updater sub-plugin keeps every python/ project's uv.lock and…
  - **`sweep`** — The daily deps.sweep job: removes installed optional-dependency identities that no checkout of this repo declares and that sat unused for 14 days (sweepUnusedDeps over the git worktree list).
  - **`updates`** — Registers the Dependency upgrades automation's config (schedule, push policy, model, prompt template) for the Automations pane and Settings → Config. The updater registry (UpdaterDeclare) and the…

<!-- AUTOGENERATED:END -->
