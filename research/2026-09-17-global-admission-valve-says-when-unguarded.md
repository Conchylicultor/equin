# Build admission valve: say when the duress guard is off

Track: page `block-6f7976b2-2e4e-449e-90ff-371e4ee6c017` ("Builds killed when memory runs out").
Follows: `research/2026-09-16-global-sentinel-worker-identity-and-loud-death.md` (its "Out of scope" item).

## Context

An agent build waits before starting its heavy work when the machine is in
trouble. That wait only happens if the machine-trouble watcher (the cluster
sentinel, running inside main's backend) is alive to raise the duress flag.

When the watcher is dead, the flag can never go up. The build walks straight in
and prints nothing about it. On 2026-09-16 the watcher had been dead for a day,
builds piled onto a machine with ~70 MB free, and no build output said "your
safety guard is off".

Since the fix above, main writes the watcher's state to a shared file,
`~/.singularity/locks/sentinel/status.json` (`{status, pid}`), and every app's
health report reads it. The build CLI does not read it yet.

**Outcome:** an agent build whose guard is off prints one warning line when it
reaches the valve, and its final `BUILD OK — deployed (…)` headline carries a
short note, e.g. `duress guard off: machine watcher is down`. The build still
proceeds — a dead watcher must not block every deploy.

## The obstacle: the CLI cannot import the reader today

The reader (`readSentinelWatch`, in `sentinel/server/internal/status-file.ts`) is
behind the sentinel's `server` barrel, which loads config_v2, live-state and the
jobs machinery. The schemas it parses with live in `sentinel/core`, which imports
`config_v2/core` (the sentinel config). The CLI must not load those — the same
reason the duress latch is its own leaf plugin (`infra/host/duress/latch`).

So the status file gets the same treatment: its own leaf sub-plugin.

## Plan

### 1. New leaf sub-plugin `debug/sentinel/plugins/status-file`

Everything about the file, and nothing else. Module-eval depends only on `zod`,
`node:fs`, `node:path` and `infra/paths` — no config, DB, live-state or
namespace. Its CLAUDE.md states this, like the latch's.

- `data-dirs/index.ts` — `sentinelStatusDir` moves here from `sentinel/data-dirs`
  (owner becomes `debug/sentinel/status-file`; the build regenerates
  `data-dirs.generated.ts`).
- `core/` — the pure zod schemas and types, moved from `sentinel/core/status.ts`:
  `SentinelStatusSchema`, `SentinelStatusRecordSchema`, `SentinelWatchSchema`
  (and the shared death fields). Plus one new pure function:

  ```ts
  type DuressGuard =
    | { kind: "on" }
    | { kind: "off"; why: string }; // "machine watcher is down", "…turned off in config", "main is not running it", "…is restarting", "no watcher status recorded", "status file unreadable: …"
  export function duressGuard(watch: SentinelWatch): DuressGuard;
  ```

  `on` only when a status is recorded, its writer pid is alive, and the state is
  `running`. Every other case is `off` with a plain reason — including
  `starting` / `respawning` / `stopped`, since the flag really cannot go up at
  that moment.
- `server/` — the file I/O, moved from `sentinel/server/internal/status-file.ts`:
  `readSentinelWatch`, `createStatusWriter`, `isPidAlive`, `STATUS_FILENAME`,
  `statusFilePath`.

The parent sentinel keeps what is backend-only: the `sentinel.status` resource
descriptor, `SENTINEL_DOWN_KIND` and the down-report payload in `core`; the
status sink, file watcher resource and sampler in `server`; the health row in
`web`. Its files import the moved pieces from the leaf's barrels directly (no
re-exports — boundary rule). Only the sentinel plugin itself uses these today,
so no outside call site changes.

### 2. The valve reads the guard once per gated build

`plugins/framework/plugins/cli/plugins/op-runtime/cli/admission-valve.ts`:

- `ValveDeps` gains `duressGuard(): DuressGuard`. Production:
  `() => duressGuard(readSentinelWatch(sentinelStatusDir.path))`.
- New exported `checkValveGuard(opts: { gated: boolean }, deps): string | null`.
  Not gated (main's interactive build, the detached auto-build) → `null` —
  those are never held anyway, and main's auto-build runs exactly while main
  restarts, when the watcher is legitimately `stopped`. Gated and `off` → prints

  ```
  build admission: duress guard OFF (<why>) — this build will not be held if the machine runs out of memory
  ```

  and returns the short note `duress guard off: <why>`. `on` → `null`.
- `op-runtime/cli/index.ts` exports it.

`plugins/framework/plugins/cli/plugins/build/cli/run.ts`: right after
`const gated = valveGates(lane, process.env)`, call it once with the build's
valve deps and push a non-null note into `softNotes`, so it shows in the
`BUILD OK — deployed (…)` headline — the line an agent actually reads.

Checked once at the start, not on every requeue of the hold loop: one warning per
build, no repeated file reads. A watcher dying mid-build is still shown by the
health report and the `sentinel-down` report.

A missing status file (`none`) warns too: on a machine where main never ran a
watcher, the guard is off, and saying so is the point of this task.

### 3. Docs

- `sentinel/CLAUDE.md` "When the watcher dies": the file's reader/writer now live
  in `plugins/status-file`, and the build CLI is a third reader.
- Valve module comment: one paragraph on the guard check and why it never holds.
- Track page: check off this item in the agent note.

## Critical files

- `plugins/debug/plugins/sentinel/plugins/status-file/{core,server,data-dirs}/…` (new; moved code)
- `plugins/debug/plugins/sentinel/{core/status.ts,core/index.ts,data-dirs/index.ts}`
- `plugins/debug/plugins/sentinel/server/internal/{status-file.ts (removed),status-resource.ts,status-sink.ts,sampler.ts,worker-host.ts}`
- `plugins/debug/plugins/sentinel/web/internal/machine-watcher-health.ts` (type import path)
- `plugins/framework/plugins/cli/plugins/op-runtime/cli/{admission-valve.ts,admission-valve.test.ts,index.ts}`
- `plugins/framework/plugins/cli/plugins/build/cli/run.ts`

## Verification

1. **Unit tests.**
   - Leaf: `duressGuard` for none / unreadable / disabled / dead owner / down /
     respawning / running; the moved `readSentinelWatch` / writer tests follow
     the code.
   - Valve: `checkValveGuard` returns `null` when not gated or guard on, and the
     note (plus one printed line) when gated and off.
   - `./equin test plugins/debug/plugins/sentinel plugins/framework/plugins/cli/plugins/op-runtime`.
2. **Real file.** A scratch script under `./equin run` calls the production
   deps' `duressGuard()` against the live `locks/sentinel/status.json` and prints
   the result (main runs the fixed watcher since `9c4686dba`, so expect `on`).
3. **Lean import.** Measure the leaf's server barrel with `importClosure`
   (`tooling/import-closure`) and confirm no `config_v2`, `live-state`, `jobs`
   or `database` module. `./equin build` passing (it runs the CLI's own
   lightness checks and `plugin-boundaries`) confirms the CLI edge is legal.
4. **Deploy.** `./equin build` for this worktree: with the watcher running,
   the headline has no guard note.
