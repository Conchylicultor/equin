# Deps — one system for optional dependencies: installed on demand, kept current

v2 of [`2026-09-29-infra-audio-analysis-pipeline.md`](2026-09-29-infra-audio-analysis-pipeline.md).
The scope has narrowed to the generic machinery. The audio pipeline (yt-dlp,
Beat This!, chroma) becomes a follow-up and the first real consumer. That doc's
library choices still hold for it.

## Context

equin keeps growing features that need something heavy from outside:
Chromium, a 116 MB dataset, a native shim, and soon a Python env with torch.
Two problems keep coming back:

1. **Everyone pays for everything.** Anything installed at `bun install` is
   downloaded by every user, including users who never open the feature. The
   Python audio env alone is about 500 MB.
2. **Nothing moves by itself.** Versions are pinned (a good thing), but only
   `mise.lock` has an upgrade loop. `bun.lock`, dataset pins and a future
   `uv.lock` go stale until someone notices, and so do their security fixes.

Every instance today solves pieces of this by hand, each differently
(inventory below). This plan builds one system, `infra/deps`. A dependency is
**declared** once. It is **installed on demand**, off the event loop and once
per machine, into a content-addressed cache. Its **state is visible**
(absent, installing, ready, failed). And it **declares how it stays current**,
so an automatic, gated upgrade loop keeps it on the latest release.

## What exists today (inventory)

| Instance | Trigger | "Installed" test | Lock | State visible | Auto-updates |
|---|---|---|---|---|---|
| Chromium (`safe-fetch/browser-fetch/provision`) | install time | stamp in `node_modules` | bun install | terminal only | follows the Playwright bump |
| Sheet Sage dumps (`apps/chord/song-index`) | lazy, supervised job | `existsSync` + sha256 | host flock | **yes**, the `chord.index-status` live resource | no (manual pins) |
| IP-country DB (`deploy/analytics/ip-country`) | boot + weekly cron | mtime + header | job dedup | no | yes (weekly) |
| asset-mirror (soundfonts) | lazy on route miss | `existsSync` | none (atomic write) | 502 | no |
| signal-origin shim (`packages/signal-origin`) | lazy, in process | content-addressed file name | none | silent (fail-open) | rebuilt when the source changes |
| Gateway binary (`infra/launcher`) | boot | `existsSync` | none | boot log | no |
| Toolchain (`mise.lock`, `plugins/toolchain`) | install time | `mise.lock` + a check | — | doctor | **yes**: a daily detect job, then an auto-started task, then `toolchain upgrade` with gates, then push |
| npm (`bun.lock`) | install time | stamp | `.install.lock` | terminal | **no** |

The shared idioms are already there: `defineDataDir({ kind: "cache" })`,
temp-file-then-rename, content-addressed names, `packages/flock`, and
supervised jobs. The only upgrade loop to generalise is the toolchain's. No
generic system exists, so this plan builds one.

## Design

### 1. Declaring a dep

```ts
// plugins/<feature>/server/deps.ts
export const audioPython = defineDep({
  id: "audio-python",
  owner: "infra/audio-analysis",
  description: "Python audio tools: torch, librosa, yt-dlp",
  sizeHint: "≈500 MB",
  source: pythonEnv({ project: "plugins/infra/plugins/audio-analysis/python" }),
  // required: a dep says how it stays current, or why it can't (tsc)
});
```

- **`source` is an installer kind**: an open set of sub-plugins under
  `infra/deps/plugins/<kind>`. Each kind supplies:
  - `identity()`: a string derived from the declared inputs (lock hash, source
    hash, pinned URL + sha256, plus the installer's own version). Nothing is
    typed in by hand. A change in any input is a new identity, and so a new
    install.
  - `install({ dir, log, signal })`: fills a temp dir.
  - optionally `updater`: how the declared inputs move to newer releases (§4).

  Consumers only see `defineDep`, `ensureDep` and `depState` (collection-consumer
  separation). This task ships one kind, `python`. `download` (Sheet Sage,
  IP-country) and `build` (signal-origin, gateway) are migration follow-ups,
  each proven by moving a real user.
- **The install policy is per dep**: `on-demand` (the default) or `at-install`.
  One generic `provision/` contribution from `infra/deps` ensures the
  `at-install` ones, which is the path Chromium can later move onto instead of
  keeping its own provision. Nothing else installs at `bun install`.

### 2. Installing on demand, safely

```ts
const ready = await ensureDep(audioPython, ctx);  // ctx: ExecContext
runPython(ready, { module: "singularity_audio.beat_features", input });
```

- **It never runs on the backend's event loop, by type.** `ensureDep` needs an
  `ExecContext`. Three places mint one: a supervised job's `run` body (a new
  additive field on its context), the `deps` CLI, and the deps provision step.
  A request handler has none, so it cannot spell the call. That is exactly
  the Chromium regression (a 150 MB download blocking the loop) made
  impossible. The request path gets `requestDep(dep)` instead, which enqueues
  the generic `deps.install` supervised job (lock = dep id) and returns at
  once.
- **Proof of readiness.** A `Ready<Dep>` value, the dir with its identity, is
  returned only by `ensureDep`. Runners like `runPython` take it as an
  argument, so "forgot to ensure" is a type error.
- **Layout, content-addressed and host-wide.** Everything lives under
  `cache/deps/<id>/<identity>/`. `ready.json` is written last, after a temp
  dir has been renamed into place. Its presence is the whole definition of
  "installed", so an interrupted install is simply absent. Worktrees on the
  same identity share one install. A worktree trialling an upgrade gets its
  own, without touching main's.
- **Once per machine.** On the slow path, `ensureDep` takes a host flock
  (`locks/deps/<id>-<identity>`, `packages/flock`, waiting on a worker thread
  as `host-semaphore` does), rechecks `ready.json`, then installs. Big
  installs also take a 1-unit `withHostGrant`, so they yield to builds.
- **Garbage collection.** `ensureDep` touches `last-used`. A daily main-only
  `deps.sweep` job removes identities that are not current for any
  checkout's declaration and have not been used in 14 days. The sweep never
  removes an identity whose flock is held.

### 3. State is visible

- `depState(dep)` is `absent | installing { since, logTail } | ready { identity, bytes, lastUsed } | failed { message, at }`.
  It is read from the dep's cache dir (`installing.json` is written while the
  lock is held, `failed.json` on a throw) and pushed as a `liveValue` driven
  by `infra/file-watcher` on `cache/deps`. It is external-source and push
  based, with no polling.
- **A Dependencies view** lives in the Settings app, as a DataView over every
  declared dep: state, size, identity, last used, Install, Remove, and the
  install log. Features render their own first-use line ("Preparing audio
  tools…") from `depState`.
- **`./equin deps list | install <id> | remove <id>`** prewarms or cleans
  up from a terminal. It uses the same `ensureDep`.

### 4. Kept current: one generic upgrade loop

This generalises `plugins/toolchain`'s proven loop instead of writing a second
copy.

```
daily deps.detect-outdated (main only)
   └─ for each updater with something newer, and no open task for it:
        file ONE auto-started task (Dependencies category)
            └─ agent runs `./equin deps upgrade <updater>`
                 baseline gates → move the lock → gates again → verdict (current | upgraded | regressed)
            └─ on `upgraded` + an ok build: push.  on `regressed`: lock restored, hold recorded with a reason
```

- **An `Updater` is a contribution**: `{ id, detect(): Outdated[], apply(worktree): Moved[], smoke?(), holds }`.
  The runner owns the gates (every check uncached, every test, the updater's
  smoke tests, retry-to-confirm), the verdict file, the task text and the
  push permission. These are lifted from `toolchain/cli/internal/{upgrade,gates}.ts`
  and `server/internal/detect-job.ts`.
- **Contributors in this task:**
  - `mise`: the existing toolchain logic moves in as an updater.
    `./equin toolchain upgrade` stays as an alias, and `toolchain:resolved`
    stays.
  - `uv`: every `python/` project, via `uv lock --upgrade`. It uses uv's
    `exclude-newer` with a **3-day cooldown**: a release has to survive 3 days
    before it is adopted. That is the cheapest defence against a hijacked
    fresh release, while still landing security fixes within days.
- **Follow-up contributor:** `npm` (`bun update` within ranges, then majors
  each as its own item). It is the biggest gap and its own task.
- **Dataset pins** (`download` deps with a hardcoded commit) must still
  declare `updates: { none: "<reason>" }`, so being frozen is a visible
  decision, never an omission.
- **Why keep lockfiles at all?** Resolving "latest" at run time would give
  every machine an untested mix, and would ship a bad or hijacked release to
  everyone at once. With the loop, updates arrive as small commits within a
  day, each proven by the gates before it lands.

### 5. The Python kind (`infra/deps/plugins/python`)

- **uv itself** goes in `mise.toml` `[tools]` (`latest`). It is a ~35 MB
  binary, the one piece small enough to give everyone, and the mise updater
  keeps it current. Shim auto-install stays off
  (`research/2026-09-27-global-mise-shim-self-loop.md`).
- **`pythonEnv({ project })`**: the identity is the hash of
  `pyproject.toml`, `uv.lock` and `.python-version`, plus the uv version.
  The install runs
  `UV_PROJECT_ENVIRONMENT=<dir> UV_CACHE_DIR=cache/uv UV_PYTHON_INSTALL_DIR=cache/uv-python uv sync --frozen`.
  uv downloads its own CPython, and the macOS system Python is never touched.
  The uv caches are declared data dirs (`reclaim: safe`), so they show up and
  can be reclaimed.
- **A `python/` leaf folder** is added to the plugin vocabulary
  (`framework/plugin-id/core`), with a boundary row that imports nothing. It
  holds one uv project. `__pycache__/` goes in `.gitignore`.
- **`runPython(ready, { module, input, signal | timeoutMs, log })`**: JSON on
  stdin, exactly one JSON document on stdout, stderr streamed to `log`, over
  `spawnCaptured`. A non-zero exit or unparseable stdout throws
  `PythonEntryError`, carrying the stderr tail. A schema parameter parses the
  output (`ZodParser`), never casts it.
- **Shared runtime.** Every Python project goes through this one kind. Whether
  extractors share an env is up to each consumer: one project means one env,
  and a conflicting torch pin means a second project.

## Layout

```
plugins/infra/plugins/deps/
  core/        Dep / DepState / Ready types, ExecContext brand
  server/      defineDep, ensureDep, requestDep, depState + live value, deps.install / deps.sweep jobs,
               Updater registry + deps.detect-outdated job, the Dependencies task category
  web/         Settings → Dependencies DataView
  cli/         deps list | install | remove | upgrade
  provision/   ensures `at-install` deps
  data-dirs/   cache/deps, locks/deps
  plugins/python/     pythonEnv kind, runPython, uv updater, cache/uv + cache/uv-python dirs
  plugins/mise/       the toolchain updater (moved from plugins/toolchain, which keeps its check + alias)
  plugins/hello-python/   a tiny real python/ project + dep (numpy only), exercised by the tests and the e2e check;
                          deleted once the audio pipeline lands as the first real consumer
```

Also touched:
- `infra/jobs/supervised-job`: `ExecContext` on the `run` context.
- `framework/plugin-id/core` and `tooling/boundaries/core`: the `python` leaf folder.
- `mise.toml` and `mise.lock`: add `uv`, via `./equin toolchain upgrade`.

## Steps

1. Add the `python/` leaf folder and give the supervised-job `run` context an
   `ExecContext`.
2. Build `infra/deps` core and server: declaration, ensure (flock, temp dir and
   rename, `ready.json`), state files, live value, the install and sweep jobs.
3. Build the `python` kind: add uv to mise, then `pythonEnv`, `runPython` and
   `hello-python`.
4. Add the CLI verbs and the Settings Dependencies view.
5. Build the updater registry and generic runner, lifted from `plugins/toolchain`.
   Move the mise logic in as the first updater, and keep `toolchain upgrade`
   plus the check working. Add the `uv` updater with its cooldown.
6. Update the audio vision doc: the runtime is now on demand, and A's audio half
   is a follow-up on top of `infra/deps`.
7. `./equin build`, `./equin check`, tests.

Follow-up tasks (filed with `add_task` at the end, grouped so each fits one session):
1. **The audio pipeline on `infra/deps`**: yt-dlp fetch with a bounded cache,
   the Beat This! + librosa extractor, and the beat-features job. Replaces
   `hello-python`. Library choices are in the v1 doc.
2. **Migrate the existing ad-hoc deps**:
   - add a `download` kind, then move the Sheet Sage dumps and the IP-country DB onto it;
   - add a `build` kind, then move the signal-origin shim and the gateway binary onto it;
   - make Chromium an `at-install` dep.
3. **The `npm` updater**: `bun.lock` within ranges, with majors as separate items.

## Verification

- **Unit tests** (`./equin test plugins/infra/plugins/deps`):
  - identity changes with each input;
  - an interrupted install (killed before `ready.json`) reads as `absent` and reinstalls;
  - two concurrent `ensureDep` calls install once;
  - `depState` covers every arm, including `failed`;
  - the sweep keeps current and in-use identities;
  - the updater runner reaches each verdict with fake updaters (current, upgraded, regressed, flaky baseline).
- **Real first use, `hello-python`:**
  - with the dep's cache empty, `bun install` downloads no Python;
  - `./equin deps install hello-python` fetches CPython and numpy, and a second run returns instantly;
  - `runPython` round-trips JSON;
  - the Dependencies view shows installing, then ready (screenshot via the e2e harness);
  - `deps remove` puts it back to absent.
- **Type-level:** a request handler calling `ensureDep` fails `tsc`, kept as a
  `@ts-expect-error` test.
- **Upgrade loop:**
  - `./equin deps upgrade uv` in the worktree moves `hello-python`'s `uv.lock` (with the cooldown respected) and returns `upgraded` or `current`;
  - `./equin toolchain upgrade` still gives the same verdicts as before;
  - running the detect job by hand files one task per outdated updater and none when a task is already open.
