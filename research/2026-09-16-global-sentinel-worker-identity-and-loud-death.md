# Machine-trouble watcher: fix the startup crash, and make its death loud

Track: page `block-6f7976b2-2e4e-449e-90ff-371e4ee6c017` (findings `block-978ca3e1-…`).

## Context

The cluster sentinel is a worker thread inside main's backend. It watches load
and memory compression and raises the duress flag, which holds back new agent
builds when the machine is struggling.

Since 2026-09-15 11:50 UTC it crashes on every start. After 5 quick crashes,
main writes one line to `logs/sentinel.jsonl` and stops trying. Nothing else
happens: no report, nothing on the Timeline, nothing in the health report. On
2026-09-16 builds kept piling onto a machine with ~70 MB free, and Claude Code
killed every background build, twice.

### Root cause (verified)

1. **The trigger.** Commit `92d4d7ee9` (2026-09-15 13:19 +0200 = 11:19 UTC; main
   rebuilt shortly after) retired the inherited `SINGULARITY_WORKTREE` env var.
   Each process now has to *declare* its namespace. A worker thread shares
   no module state with the thread that spawned it, so it starts with no
   namespace declared. The worker does declare one, but only when its `init`
   message arrives. That happens after its whole import graph has already run.
2. **Why that matters: the worker is not lean.** The sentinel's CLAUDE.md says the
   worker only loads a small set of modules, and specifically not config_v2.
   That is no longer true. I bundled `worker/entry.ts` with a metafile. It loads
   **466 modules**, including the job queue and config_v2's server side. The
   shortest chain:

   ```
   worker/entry.ts → worker/sample.ts
     → health-monitor/server (barrel)            ← only wants two zod schemas
     → handle-health-data → read-health-files
     → slow-ops/server → config_v2/server → config-watcher → config-dir.ts
       (config-dir.ts calls runtimeNamespace() as soon as it loads → throws)
   ```

   Before the env var was retired, this bloat stayed hidden, because the env var
   answered the namespace question.
3. **Why it went unnoticed.** When the worker gives up, the only trace is one
   log line.
   Nothing enforces the "lean worker" claim either.

## Plan

### Part 1: the worker knows its namespace before any of its code loads

Take the same approach as a backend (`server-core/bin/declare-namespace.ts`):
the process that spawns the worker passes the namespace in, and the worker's
very first import declares it.

- **`runtime-identity/core`** gains two small helpers, so both entry points use
  one spelling:
  - `namespaceArgv(): string[]` returns `["--namespace", runtimeNamespace()]`
    (for spawners).
  - `readNamespaceArgv(argv): Namespace | undefined` holds the parsing and the
    empty-value error that `declare-namespace.ts` currently does inline.
  `server-core/bin/declare-namespace.ts` switches to `readNamespaceArgv`.
- **`sentinel/server/internal/worker/declare-namespace.ts`** (new) reads
  `process.argv` through `readNamespaceArgv`. If the flag is missing, it throws
  a message aimed at the worker spawner. Otherwise it calls
  `declareRuntimeNamespace`.
  **`worker/entry.ts`** imports it as its literal first statement. The comment
  there matches the backend's.
- **`worker-host.ts`** spawns with
  `new Worker(url, { argv: namespaceArgv() })`.
  **The `worktree` field is removed from the init message.** The worker reads
  `runtimeNamespace()` instead, so there is no second copy of the namespace
  that could disagree with the first.
- **Compiled release.** `release/cli/run.ts` bundles `entry.ts`, and a bundle
  keeps import order, so the side-effect import still runs first. The spawn
  argv is the same in dev and in a release.
- **Verify during implementation:** check that Bun's `Worker` `argv` option
  shows up in the worker's `process.argv`, with a scratch script run through
  `./equin run`. The bun-script guard blocked the bare check during
  planning. If `argv` does not work, use `workerData` from
  `node:worker_threads`; the shape stays the same.

### Part 2: make the worker lean again, and keep it lean

- **health-monitor gets a `core/` barrel** that exports `HealthSampleSchema`
  and `HostSampleSchema`. They are pure zod; their only import is
  `slow-ops/core`. `worker/sample.ts` imports them from there. The server
  barrel keeps its own export for existing users, as a plain re-export of the
  plugin's own `shared/` file.
- Re-bundle, then look through the remaining module list for other heavy
  modules: any module that runs a `runtimeNamespace()`-style read, or
  registers something, as soon as it loads. Cut those edges the same way,
  through a leaf `core` import. Record the before and after module counts.
- **New check `sentinel:worker-closure-lean`** (`plugins/debug/plugins/sentinel/check/`).
  It measures the worker entry's static import closure and fails if the closure
  contains any module under a *forbidden prefix*: `config_v2/server`,
  `infra/plugins/jobs/server`, `database/server` (the pool), and
  `framework/plugins/server-core`. The failure message prints the import chain,
  the same way my metafile script did.
  This turns the CLAUDE.md's "lean closure" claim into a check (rung 3).
  - `importClosure()` already does exactly this measurement, but it lives in
    `framework/cli/check/import-closure.ts`, which is not a barrel. So it moves
    behind a public `core` barrel under tooling, most likely
    `framework/tooling/plugins/import-closure/core`. The CLI checks keep using
    it from there. I'll confirm the right home against `plugins-details.md` when
    implementing.
  - This check also covers Part 1 more broadly. A missing declaration would
    only be one bug. A bloated closure is the whole category.

### Part 3: a dead watcher is loud

A status that main holds, pushed to every surface that needs it:

- **`worker-host.ts` tracks a status**: `starting` → `running` (on `ready`) →
  `respawning {deaths, lastError}` → `down {since, lastError}` (on give-up), and
  `stopped` on shutdown. `lastError` is the message from the most recent worker
  `error` event. Today that message is only logged.
- **Report `sentinel-down`** (new `ReportKind` in `sentinel/server`, variant
  `error`, `duressExempt: true`, fixed fingerprint per host). It is filed when
  the worker gives up, with the last error and the death count. Reports already
  show up in the bell, in Debug → Reports, and **on the Timeline** (the
  `timeline/…/sources/reports.ts` source). So one report covers "loud",
  "Timeline" and "notification" together. Its `renderTask` points at
  `logs/sentinel.jsonl` and this doc.
- **Health report row "Machine watcher"** (web contribution in `sentinel/web`,
  `order` near Database): `critical` while the watcher is down ("The machine
  watcher is not running — builds are not held back when memory runs out"),
  `attention` while it is restarting, `ok` while it is running.
  - The status reaches the page as a small push live-state resource,
    `sentinel.status`. It is a single value, bounded by definition.
  - **Worktree backends.** The watcher only runs in main, but agents mostly look
    at their own worktree's health report. So the status is also written to a
    small **host-global status file** next to the duress latch. It is written
    only when the status changes (a handful of writes a day), and holds
    `{state, since, lastError, pid}`. The resource on every backend is served
    from that file, through the `infra/file-watcher` primitive (push, no
    polling). If the recorded pid is not alive when the file is read, the row
    shows `critical`: "main is not running its watcher".
- **Update the sentinel CLAUDE.md**: the declare-first entry, the check that
  keeps the closure small, and how a death is reported. Delete the stale "no
  config_v2" claim, or better, point it at the check.

### Out of scope (to be filed as tasks, per the track findings)

- The build admission valve fails open silently when there is no watcher. It
  could print a warning ("duress guard not running") by reading the same status
  file. It is a small follow-up, but it is a CLI change with its own review.
- Host-admission memory budget gaps (the 3.6 GB average, unbudgeted processes,
  the fixed budget): those are separate tasks on the track.

## Critical files

- `plugins/debug/plugins/sentinel/server/internal/worker-host.ts` (spawn argv, status, report)
- `plugins/debug/plugins/sentinel/server/internal/worker/{entry,sample,protocol}.ts`
- `plugins/debug/plugins/sentinel/server/internal/worker/declare-namespace.ts` (new)
- `plugins/debug/plugins/sentinel/{check,web}/…` (new), `server/index.ts` (report kind, resource)
- `plugins/infra/plugins/runtime-identity/core/internal/runtime-identity.ts` (argv helpers)
- `plugins/framework/plugins/server-core/bin/declare-namespace.ts` (use the shared parser)
- `plugins/debug/plugins/health-monitor/core/index.ts` (new; schemas)
- `plugins/framework/plugins/cli/check/import-closure.ts` → public barrel
- `plugins/framework/plugins/cli/plugins/release/cli/run.ts` (confirm the vendored bundle still works)

## Verification

1. **Reproduce first.** Before any fix, on this worktree's backend,
   `logs/sentinel.jsonl` should show the same crash, but only if this worktree
   starts the sentinel. It does not: the sentinel runs only in main. So:
   `./equin test plugins/debug/plugins/sentinel`, with a new test that
   spawns the real worker through `worker-host` in a process whose namespace is
   declared. The test asserts that `ready` arrives. It fails before the fix and
   passes after.
2. **Checks.** `./equin check sentinel:worker-closure-lean` fails on the
   current tree, printing the health-monitor → slow-ops → config_v2 chain, and
   passes after the fix. Then run the full `./equin check`.
3. **Loudness.** A test uses a worker URL that throws when it loads. It asserts
   5 deaths → status `down` → one `sentinel-down` report recorded → status file
   written. On the deployed worktree
   (`screenshot.ts --click` on the health dot), the Machine watcher row reads
   the status file.
4. **After push** (main rebuilds): `logs/sentinel.jsonl` shows no new crash,
   `duress-episodes` gets lines again when the machine is under load, and
   `query_db` on `singularity` shows no `sentinel-down` report.
5. **Release.** `./equin release` builds a vendored `sentinel/worker.js`
   that boots, if releases are exercised locally. Otherwise, bundle
   `entry.ts` and run the closure check against the bundle.

## Afterwards

Update the track page: add a checked sub-task and a short agent note pointing
here. File follow-up tasks with `add_task` for the valve warning and the memory
budget gaps, passing the track page id and the track instructions block id.
