# spawn

The wedge-proof child-process primitive: every async spawn routes through here
so **piped child stdio cannot exist** outside one owned chokepoint.

## The bug this exists for

bun 1.3.13 (unfixed through 1.4-canary) has a race where a `Bun.spawn` child
with piped stdio exiting **during a pending stream pull** wedges the event loop
in a permanent native microtask storm: ~100% CPU, kevent starved, children
zombify, the op never completes. Every field `./singularity build/check/push`
wedge was this bug. Producer chain symbolicated from live specimens:
`research/2026-07-22-global-cli-op-wedge-symbolication.md`,
`research/2026-07-22-global-cli-op-wedge-producer-fingerprint.md`; plan:
`research/2026-07-22-global-spawn-plugin-wedge-mitigation.md`.

Load-bearing fact (empirically verified on 1.3.13): a bare `Bun.spawn(cmd)`
defaults stdout to **`"pipe"`** — even option-less calls are exposed. That is
why the `spawn-safety/no-raw-bun-spawn` lint rule (contributed by this plugin's
`lint/`) is a chokepoint ban on the member expression itself.

## Mechanics

`spawnCaptured` removes the stream instead of racing it: per call,
`mkdtempSync(os.tmpdir(), "sg-spawn-")` → write the stdin buffer to a file if
given → `openSync` numeric fds for in/out/err (`mergeStderr` reuses the out fd)
→ `Bun.spawn(argv, { stdin: inFd ?? "ignore", stdout: outFd, stderr: errFd })`
→ `await proc.exited` → capture rusage → close fds, read the files, `rmSync`
in `finally`. Raw numeric fds are a plain kernel dup2 — **zero JS stream
machinery in either direction**, so there is nothing for the exit-during-pull
race to wedge. Temp files orphaned by a hard crash are reclaimed by the OS
tmpdir sweep (repo convention).

**Every child runs with `GIT_OPTIONAL_LOCKS=0`** (`core/internal/child-env.ts`),
on top of whatever `env` it gets. Don't remove it: otherwise a `git status` in
main's checkout (main's auto-build) takes `.git/index.lock` and a concurrent
push's merge into main fails. Real writes still lock.

## Children die with their parent

A child started here cannot outlive the process that started it. Before
2026-10-09 nothing tied the two together: a `./singularity check` killed with
SIGTERM ran its exit hooks and left its ~16 GB type-check worker running,
reparented to pid 1, with nobody left to read its result
(`research/2026-10-09-infra-spawn-children-die-with-parent.md`). Two layers,
both automatic for every `spawnCaptured` / `spawnPassthrough` call:

- **Parent side: the exit reaper** (`core/internal/live-children.ts`). Each
  child is registered from spawn until reap; one `process.on("exit")` hook
  SIGTERMs whatever is still registered. Every graceful death ends there: op
  CLIs turn TERM/INT/HUP/QUIT into `process.exit`, and an uncaught throw or a
  plain exit gets there anyway. SIGTERM rather than SIGKILL so a child that is
  itself an op CLI runs its own exit hooks, and its own reaper, in turn.
- **Child side: the lifeline** (`holdParentLifeline` / `exitWithParent`,
  `packages/flock`). Each spawn holds an exclusive flock on `lifeline` in its
  private tmpdir and hands the path down as `SINGULARITY_PARENT_LIFELINE`. The
  kernel drops that lock when the parent dies, SIGKILL and OOM included, so a
  child that called `exitWithParent()` dies at that moment even while its main
  thread is busy. Opt-in, because only a child we wrote can call it. Today the
  type-check worker does, as the heavyweight one. Any bun script we spawn that
  is costly to orphan should add the one line.

Supervised and detached children (`defineDaemon`) spawn outside these two
functions on purpose: they are meant to outlive any one call.

## API (`@plugins/infra/plugins/spawn/core`)

- **`spawnCaptured(argv, opts) → Promise<SpawnResult>`** — capture-shaped
  spawn. `opts` is REQUIRED (see *A bound is mandatory* below): `cwd`, `env`
  (FULL replacement, same contract as `Bun.spawn`), `stdin` (whole
  `string | Uint8Array` buffer, EOF at the end), `background` (argv :=
  `backgroundArgv(argv)` from `spawn-priority/core`), `mergeStderr` (2>&1;
  `result.stderr === ""`), plus exactly one bound — `timeoutMs`, `signal`, or
  the prose `unbounded`. The result's `exitCode` **≠ 0 is a
  legitimate result** — the caller branches. `stdout`/`stderr` are lazy cached
  utf8 decodes of `stdoutBytes`/`stderrBytes` (the raw bytes exist for
  byte-offset parsers like `git cat-file --batch` framing).
  `resourceUsage` is the child's `getrusage`, read after exit: `maxRssBytes`
  (true peak RSS), `cpuTimeMicros` (user+system CPU, microseconds) and
  `cpuSystemMicros` (its system share — what memory pressure inflates: page
  faults and compressor work are charged there). All are `undefined` when the
  runtime reported no rusage. CPU time is the load-independent
  cost of a run — wall clock on a shared host varies 2.5x for the identical work.
  `timedOut` is `true` iff OUR deadline fired and we killed the child (never
  inferred from `signalCode` — anyone can SIGTERM a child).
- **`spawnExpectOk(argv, opts)`** — the same, but THROWS `SpawnFailedError`
  (carrying argv/exitCode/signalCode/stdout/stderr) on non-zero exit, so a
  failed command can never be read as empty success.
- **`spawnPassthrough(argv, { cwd, env, background, stdin, onSpawn }?)`** —
  exec-shaped spawn: stdout/stderr `"inherit"`, stdin `"ignore"` unless
  `stdin: "inherit"` (only for a child that must be indistinguishable from the
  parent — the CLI's post-install re-exec). `onSpawn` exposes `{ pid, kill }`
  synchronously for signal forwarding. Returns
  `{ exitCode, signalCode, resourceUsage }`.
- **`getWorktreeRoot(cwd?)` / `getMainRepoRoot(cwd?)`** — THE canonical git
  root helpers (`git rev-parse --show-toplevel` /
  `dirname(resolve(git rev-parse --git-common-dir))`), collapsing the ~51-file
  `getRoot()` copy-paste epidemic. Memoized per resolved cwd
  (`Map<resolvedCwd, Promise<string>>` — one spawn per process, concurrent
  first callers share it). Outside a git repo they **throw** — the old copies
  absorbed that to `""`, a latent path bug (repo fail-loud rule).

## The two bounds: `timeoutMs` and `signal` (`SpawnBound`)

Both run the same escalation — SIGTERM, SIGKILL after 2s, timers cleared in the
existing `finally` — through one `escalateKill()`, so setting both cannot leak a
timer. They differ in how the kill is reported, deliberately:

- **`timeoutMs` returns `timedOut: true`.** It is the CALLER's own deadline, so
  the caller classifies it. Whatever the child wrote first is still captured.
- **`signal` THROWS `signal.reason`.** An abort is ambient ("everything you are
  doing has been abandoned"); as a result field it would be absorbed by a caller
  that maps a failed probe to a conservative default and then runs a hundred more
  spawns. `spawnExpectOk` needs no special case — the abort propagates before the
  exit-code check. Edges: an abort beats `timedOut` in either order, and an abort
  after a clean exit still throws, discarding a good result.

## A bound is mandatory

`SpawnOptions` is a union, so an unbounded wait has **no spelling**:

```ts
export type SpawnOptions = SpawnBaseOptions &
  ( { timeoutMs: number; signal?: AbortSignal }
  | { signal: AbortSignal; timeoutMs?: number }
  | { unbounded: string } );
```

`opts` is required, and `tsc` rejects a call that names none of the three. This
is rung 2 of the fix ladder rather than rung 5: there is no rule to remember and
no lint to keep in sync, because the wrong thing cannot be written.

**The gate for this flipped, and that is why it landed.** This doc used to set
the criterion as *"the absence of an observed field wedge, diagnosed by hand"*.
A field wedge has now been observed **twice** — including the 2026-08-17 outage,
where an unbounded `git worktree remove` held the host-wide `worktree-mutate`
flock and stopped worktree checkouts on every backend on the machine. Nothing
else catches this: the fleet-level op-wedge watchdog was retired 2026-07-28 as an
all-false-positive instrument
(`research/2026-07-28-global-retire-op-wedge-watchdog.md`), so an unbounded hung
child hangs until a human notices.

Which arm to reach for — the choice is per call site, never one number applied
everywhere:

- **`timeoutMs`** when the caller owns a deadline: an HTTP request, a scheduled
  sampler tick, a reaper holding a host-wide slot. Size it to the command.
  `infra/worktree`'s `worktree.ts` is the house style — named per-operation
  constants, with a calibration comment worth reading before inventing a number.
  Its headline finding: these are **wedge-breakers, not latency police**. What
  git actually suffers on a loaded box is starvation, which no p99 bounds, so
  the values sit two or three orders of magnitude above p50 — a 10 s bound on
  `git worktree list` still false-fired during a real `./singularity check`.
- **`signal`** when the caller already holds one — a job handler's `ctx.signal`,
  which the hold-class deadline aborts. Alone, or together with `timeoutMs`
  when a per-command ceiling is a separate fact from the run's deadline.
- **`unbounded: "<why>"`** only where nothing shorter than the work bounds it.

### `unbounded` is prose on purpose

The third arm carries a **sentence**, not a flag, and it has **no runtime effect
at all** — nothing reads it. Two properties follow, both deliberate:

- It cannot be copy-pasted without being rewritten, so it does not spread the
  way a `bounded: false` would.
- `rg "unbounded:"` enumerates every one of them, with its justification
  attached, in a form a reviewer can audit in one pass.

The honest cases are all in the CLI and its check runner, where the human at the
terminal is the deadline and the child IS the work: the `./singularity check`
subprocess, a cold type-check worker, a build step (`bun install` / vite / the
server bundle), and the DB-fork benchmark whose whole purpose is to time an
unbounded fork. A server-side call site almost never belongs here — its request
or its job has a deadline, and that is the bound.

## Deliberate non-goals

- **No `maxOutputBytes`** — a silent output cap is an absorbed failure.
- **No sync variant** — `Bun.spawnSync` / `execFileSync` buffer natively (no
  JS streams, no wedge). The few existing sync sites are untouched and
  rule-legal; a loop-blocking sync spawn is fine for the CLI, revisit
  server-side in Stage 2.

## Exception policy

A child a backend keeps running for its lifetime is declared with
`defineDaemon` (`plugins/daemon`) — not an exception. A genuinely streaming
child — parsed live, written to live, or meant to outlive a non-backend call —
cannot use after-exit temp files. Those get a file
entry in the exempted plugin's `exempt/index.ts` **with a written justification** (intended
review pressure, mirroring git-grep-safety), never an inline disable.

## Stage 2 — done

The blanket "every plugin server tree" glob went first, replaced by an explicit
31-file list in `lint/index.ts` split into a permanent streaming/long-lived group
and a temporary backlog of plain capture sites. **That backlog is now empty**:
all 20 migrated onto `spawnCaptured`, and each took a bound while it was being
touched — which is what made the mandatory-bound union above expressible at all,
since a union `tsc` enforces cannot be adopted halfway.

What remains exempt is the permanent group alone: files where after-exit
temp-file capture is structurally impossible (a pipe chain, a live log stream, a
supervised child that outlives the call). Anything added there needs a written
justification beside it, and nothing else belongs. A long-lived child a backend
keeps running is not such a file: it is declared with `defineDaemon`
(`plugins/daemon`, inside this chokepoint), which supervises it and lists it in
Debug → Background activity.

The migration was worth doing even ignoring bounds: the pre-migration pattern
(`{stdout: "pipe"}` then `await proc.exited` with stdout never read) is a plain
>64KB pipe-buffer deadlock on top of the bun race.

## Boundaries

**`core/` here means runtime-neutral Node, not web-safe** — it reaches
`node:fs` / `node:path` and composes `spawn-priority/core` for demotion. It
must never be imported from `web/`. `server/` is the plugin's server-runtime
presence only — **no re-exports**; import from `core/`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Wedge-proof child-process primitive: spawnCaptured/spawnExpectOk capture stdout/stderr via temp-file fds (no piped stdio, so bun 1.3.13's exit-during-stream-pull race has nothing to wedge), spawnPassthrough inherits the parent's streams, and getWorktreeRoot/getMainRepoRoot are the memoized canonical git-root helpers. Node-only (no db/jobs) so a CLI process can import it; the spawn-safety lint rule routes every raw Bun.spawn here.
- Core:
  - Uses:
    - `packages/flock.holdParentLifeline`
    - `packages/spawn-priority.backgroundArgv`
  - Exports (types):
    - `ChildResourceUsage`
    - `SpawnBaseOptions`
    - `SpawnBound`
    - `SpawnedChild`
    - `SpawnOptions`
    - `SpawnPassthroughOptions`
    - `SpawnPassthroughResult`
    - `SpawnResult`
  - Exports (values):
    - `getMainRepoRoot`
    - `getWorktreeRoot`
    - `spawnCaptured`
    - `spawnExpectOk`
    - `SpawnFailedError`
    - `spawnPassthrough`
- Cross-plugin:
  - Imported by:
    - `database/migrations`
    - `framework/tooling`
    - `framework/tooling/boundaries`
    - `framework/tooling/checks`
    - `framework/tooling/format`
    - `infra/deps/mise`
    - `infra/git/remotes`
    - `infra/paths`
    - `reports/outbox`
    - `upstream`
- Exemptions:
  - Exempts itself from: `spawn-safety/no-raw-bun-spawn` — `.` (sanctioned)
  - Exempted by:
    - `conversations/runtime-tmux` (0 debt)
    - `framework/cli/migrations` (0 debt)
    - `framework/tooling/checks/bun-runtime` (0 debt)
    - `infra/jobs/supervised-job` (0 debt)
    - `infra/launcher` (0 debt)
    - `infra/spawn` (0 debt)
    - `packages/flock` (0 debt)
- Sub-plugins:
  - **`daemon`** — defineDaemon: the one declared long-lived process or thread a backend runs on its own — a named, described declaration (startedBy boot | on-demand, where every-worktree | main | host-singleton…

<!-- AUTOGENERATED:END -->
