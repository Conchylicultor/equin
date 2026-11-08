# blocking-fs

A backend's JS thread never waits on the disk. One synchronous fs call holds
the whole process — every request, live read, job and timer — for as long as
the disk takes to answer, and on a busy or slow disk that is seconds: main
recorded 3–13.6 s `event-loop-stall` reports on `renameSync ← writeAtomic`
(document-head), `openSync` / `readSync ← readTail` (log-files),
`resolveSync ← resolvePlaywright` (deps), `statSync ← fileStamp`
(config_v2), and the timed-fs twins of `readFileSync` / `readdirSync` /
`realpathSync`. While the thread is held, every other op in flight is
recorded as slow too, so one stall reads as a cluster of slow DB calls.

`user-path/no-sync-fs` only refuses a sync call on a path the user chose (a
macOS permission prompt). This rule refuses any.

## The lints

**`blocking-fs/no-sync-fs`** (type-aware) — in a plugin's `server/`,
`machine/`, `central/` or `deps/` folder (tests, `cli/`, `scripts/`, `bin/`,
`provision/` out of scope), no call to — nor a function handed on by reference
(`paths.map(existsSync)`, `{ read: readFileSync }`) of:

- a `node:fs` `*Sync` function — node's own, or the timed-fs twin
  (`@plugins/packages/plugins/timed-fs/core`), which carries node's
  declaration, so an alias (`timedReaddirSync`) is caught too. `closeSync` is
  not one: closing waits on no disk, and `owned-fd/no-raw-fd-close` already
  confines it to `OwnedFd.close()`;
- a `node:child_process` `*Sync` (`spawnSync`, `execSync`, `execFileSync`)
  or `Bun.spawnSync` — the thread waits for the child to exit;
- `Bun.resolveSync` (it stats its way up the `node_modules` chain; Bun's
  async `Bun.resolve` is documented as the same work, so it is no fix either:
  walk `node_modules` with async `realpath` instead), a synchronous glob scan
  (`Bun.Glob#scanSync`);
- a **`core/`, `shared/` or `data-dirs/` function named `*Sync`** — a helper
  that does one of the above on the backend's behalf (timed-fs's
  `scanGlobSync`, `openOwnedFdSync`, `readDeploySpecSync`, …).

Use the async twin: `node:fs/promises` (timed-fs's `readFile`, `readdir`,
`stat`, …), `spawnCaptured` / `spawnExpectOk` (`infra/spawn`), the helper's
async sibling — add one beside it when it has none.

**`blocking-fs/sync-named`** (type-aware) — in a `core/`, `shared/` or
`data-dirs/` folder, a function that blocks its thread is named `*Sync`,
node's own convention. Blocking = it calls, or hands on by reference, anything
in the list above (another repo `*Sync` included, so the name climbs through
every wrapper). A callback runs on its caller's behalf, so
`ps.filter((p) => existsSync(p))` is charged to the enclosing named function;
a method, property or field is named by its key. Blocking work at module
scope, in a constructor or in an anonymous function has no name to carry it:
move it into a named `*Sync` function.

### Why a name, not a call graph

`core/` also serves the CLI, checks and scripts, so the folder cannot say
which thread runs a helper; only its callers can. But a backend's call site
cannot read the helper's body: the type-check lint cache keys a type-aware
result on the file and the *declarations* it can see, never on another file's
source (research/2026-10-17-global-lint-keyed-on-what-it-reads.md), so a body
edit that adds a `readFileSync` three calls down would leave every caller's
cached verdict standing. A name is a declaration: `sync-named` makes it true
in the helper's own file, and `no-sync-fs` reads it at the call — both
per-file, both cache-sound. Design:
research/2026-11-06-global-sync-helpers-on-backends.md.

### Helpers no backend runs

A helper only the CLI, checks or the build call (codegen, web-artifacts, the
check runner) blocks nobody's backend, and naming it `*Sync` buys nothing. Its
plugin declares a `sanctioned` `blocking-fs/sync-named` exemption with that
reason — and **`blocking-fs:sync-named-reach`** holds it to it: the check
walks the runtime import graph from every backend module (static imports that
do not erase, plus literal dynamic `import()`s, read off the tree's text in
about a second) and fails when one reaches a sanctioned file, naming the
chain. A helper a backend does load but whose rename is not done yet (a
method bound by an interface many implement, a barrel the backend loads for
something else) is `debt`, naming its task.

## Where a sync call is legitimate

Only where a held thread blocks no backend. The file's plugin declares it — a
`sanctioned` exemption in its `exempt/index.ts`, with the reason:

- **its own process** — a hook entry, a worker or probe entry point, a
  fixture spawned as a child: it stalls only itself;
- **a synchronous exit path** — a `process.on("exit")` handler or a crash
  latch, which must finish before the process dies and cannot await;
- **before the backend listens** — boot code that provably runs only before
  the socket opens, so nothing is waiting on the thread yet.

Not legitimate: "it is a small file", "it runs rarely", "it is in a job" (a
job runs on the backend's thread), "it is the CLI's code too" (an async
function serves both).

A call behind a synchronous API that many sync consumers read (the daemon
primitive's pid-file getters) needs that API redesigned — push the value
instead of re-reading it on every get. Until then it is `debt`, naming the
task that removes it: `./equin exempt list --rule blocking-fs/no-sync-fs
--debt` is the burndown.

## Not covered

- A blocking helper reached through a value whose type names no `*Sync`: a
  method on an interface many implement (`Guard.check`), a callback typed as
  a plain function. The name is read from the declaration the call resolves
  to; such a contract is `debt` until it is split.
- A blocking function re-exposed under a property not named `*Sync` / `native`
  (`o.read = fs.readFileSync; o.read()`): the rules ask the checker about a
  member call only when its name can be a blocking one, so their cost stays
  proportional to the candidate calls (lint `CLAUDE.md`, *A type-aware rule
  asks the checker the narrowest question*). An identifier callee (an import
  alias, a twin `const`) is always asked.
- The check thread: `check-thread-safety/no-blocking-check-work`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: No synchronous fs call or child process on a backend's JS thread: the type-aware blocking-fs/no-sync-fs lint refuses node:fs / node:child_process *Sync calls (timed-fs's twins included), Bun.resolveSync / spawnSync, sync glob scans and core/shared/data-dirs *Sync helpers in server/, machine/, central/ and deps/ code; blocking-fs/sync-named makes every helper there that blocks carry the *Sync name, and the blocking-fs:sync-named-reach check holds a helper excused as tool-only to no backend loading it. A file that blocks no backend (its own child process, pre-listen boot, a sync exit handler) declares a sanctioned exemption.
- Exemptions:
  - Exempted by:
    - `build/server-build-id` (0 debt)
    - `config_v2/ledger` (0 debt)
    - `database/migrations` (0 debt)
    - `debug/boot-events` (0 debt)
    - `debug/paging-probe` (0 debt)
    - `debug/profiling/fs-wait` (0 debt)
    - `framework/cli` (0 debt)
    - `framework/cli/release` (0 debt)
    - `framework/cli/test` (0 debt)
    - `framework/tooling/boundaries` (0 debt)
    - `framework/tooling/checks` (0 debt)
    - `framework/tooling/checks/type-check` (0 debt)
    - `framework/tooling/codegen` (0 debt)
    - `framework/tooling/format` (0 debt)
    - `framework/tooling/guards` (0 debt)
    - `framework/tooling/import-closure` (0 debt)
    - `framework/tooling/lint` (0 debt)
    - `framework/tooling/web-artifacts` (0 debt)
    - `infra/asset-mirror/bundle` (0 debt)
    - `infra/file-sink` (0 debt)
    - `infra/git/tree-lock` (0 debt)
    - `infra/launcher` (0 debt)
    - `infra/paths` (2 debt)
    - `infra/worktree` (0 debt)
    - `packages/signal-origin` (0 debt)
    - `packages/single-flight` (0 debt)
    - `plugin-meta/barrel-import` (0 debt)
    - `plugin-meta/relocate` (0 debt)
    - `plugin-meta/token-usage` (0 debt)
    - `primitives/icon-picker` (0 debt)
    - `reports/engine` (0 debt)
    - `reports/outbox` (0 debt)

<!-- AUTOGENERATED:END -->
