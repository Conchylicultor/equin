# Spawned children die with their parent

## Context

On 2026-10-09 the host was memory-thrashing: about 11 concurrent `./equin check type-check` runs in one worktree, each type-check worker at 15–20 GB. During cleanup, the qcx5 session SIGTERMed CLI pids 78331 and 78533. Their type-check workers (84034, 84035) **survived, reparented to pid 1**, still at about 16 GB each. Nothing would ever read their result, and they kept running until a human found and killed them by hand.

Why this happens:

- The type-check worker is spawned through `spawnCaptured` (`plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/core/spawn-worker.ts`). The spawn primitive (`plugins/infra/plugins/spawn/core/internal/spawn-captured.ts`) only kills a child on its own deadline or abort. Nothing ties the child's life to the parent's.
- On SIGTERM, INT, HUP or QUIT, an op CLI runs `installFatalSignalExit` (`plugins/framework/plugins/cli/plugins/op-runtime/cli/fatal-signals.ts`), which calls `process.exit(128+n)`. Exit hooks run (markers, receipt), but **no hook kills the in-flight children**.
- On SIGKILL, including jetsam, which is likely under exactly this kind of memory pressure, no handler runs at all.

This is not specific to type-check. `test` (`spawnPassthrough` of the test runner), the e2e branch of `run`, and the nested check subprocess that build and push start (`op-runtime/cli/check-subprocess.ts`) all orphan the same way.

**Intended outcome:** a child spawned through the spawn chokepoint cannot outlive the process that spawned it. For a graceful death (TERM-class signals, `process.exit`, uncaught throw) this holds for every child, with no opt-in. For a hard death (SIGKILL, crash) it holds for the heavyweight bun children we own, starting with the type-check worker.

## Design — two layers, both in `infra/spawn`

### Layer 1 — parent-side: the chokepoint reaps its live children on exit (every child, automatic)

In `plugins/infra/plugins/spawn/core/internal/`, add a module-level **live-children registry**, `live-children.ts`:

- `spawnCaptured` and `spawnPassthrough` register `{ pid, kill }` right after `Bun.spawn` and deregister in their existing `finally`, once the child has been reaped.
- The first registration installs one `process.on("exit", reapLiveChildren)`. It sends `SIGTERM` to every still-registered child, synchronously; `process.kill` is a syscall, so it is legal inside an exit handler. It cannot wait for a SIGKILL escalation: the process is ending, and Layer 2 covers children that won't die from TERM.
- Because `installFatalSignalExit` turns TERM, INT, HUP and QUIT into `process.exit`, the CLI's graceful-death path reaches this hook with **no change to op-runtime**. The same holds for an uncaught exception and for a normal `process.exit(1)` after a failed verdict.
- Daemons are unaffected. `defineDaemon`'s `supervise.ts` calls `Bun.spawn` directly and does not go through `spawnCaptured` or `spawnPassthrough`, so supervised and detached children never enter the registry. That is correct: they are meant to outlive any one call. Implementation must confirm no other long-lived child goes through the two functions; the exempt list in `spawn/exempt` names the candidates.
- Use SIGTERM, not SIGKILL. A nested `./equin check` child has its own exit hooks (op marker, op-log `completed`), and TERM lets them run, which then cascades through that child's own Layer 1.

This is rung 1 of the fix ladder: there is no option to forget. Every child spawned through the chokepoint is covered, and the chokepoint is already lint-enforced (`spawn-safety/no-raw-bun-spawn`).

### Layer 2 — child-side: a flock lifeline for SIGKILL and crashes (owned bun children)

A parent killed by SIGKILL runs no code, so only the child can notice. Use the same mechanism the repo already trusts for "released on death, SIGKILL included": a kernel `flock`.

- **Parent:** for each spawn, `spawnCaptured` already makes a private `mkdtemp` dir. It opens `dir/lifeline`, takes `flockTry` **exclusive** (`plugins/packages/plugins/flock/core`) before `Bun.spawn`, and passes the path to the child as `SINGULARITY_PARENT_LIFELINE` in `childEnv`. It releases the lock in the existing `finally`. This needs no new DataDir: the file lives in the per-spawn temp dir that is already created and removed. `spawnPassthrough` gets the same treatment, using a temp dir of its own.
- **Child:** a new helper, `exitWithParent()`, exported from the **`packages/flock` core barrel**. It owns flock and has no npm or cross-plugin dependencies, so a bare worker script can import it. The helper:
  - reads the env var; with no variable it returns, so the child still runs standalone;
  - starts a `node:worker_threads` Worker that opens the file and calls **blocking** `flock(fd, LOCK_SH)` through `bun:ffi`. This is the same pattern as `plugins/packages/plugins/host-semaphore/scripts/flock-block.ts`, whose doc explains why the block must sit on a worker thread;
  - when the lock is granted, the parent is gone. The worker thread calls `process.kill(process.pid, "SIGKILL")` itself, without posting a message. **This is load-bearing:** the type-check worker's main thread is stuck in synchronous TypeScript program construction for minutes and would never process the message;
  - `unref()`s the Worker, so a child that finishes normally still exits.
- **Call sites:** add one line at the top of `type-check/shared/worker.ts`, the 16 GB case. Other bun scripts we spawn can adopt it with the same line. Making it automatic, for example by having the primitive inject `--preload` for `process.execPath` children, is a possible follow-up, not part of this change.

No polling anywhere: the parent learns of a child's death from `await child.exited`, and the child learns of the parent's death when the kernel releases the flock.

### Before building

Confirm two assumptions, each with a tiny throwaway script under `./equin run`:

1. Bun lets a `worker_threads` Worker call `process.kill(process.pid, …)` while the main thread is stuck in a synchronous loop.
2. A `LOCK_SH` waiter is granted when an `LOCK_EX` holder is SIGKILLed on darwin.

If (1) fails, fall back to an `EVFILT_PROC`/`NOTE_EXIT` kqueue on `getppid()` from the same worker thread. Same shape, darwin-only.

## Files

- `plugins/infra/plugins/spawn/core/internal/live-children.ts` (new): the registry and the exit reaper.
- `plugins/infra/plugins/spawn/core/internal/spawn-captured.ts` and `spawn-passthrough.ts`: register and deregister each child; create the lifeline and pass it in the child env.
- `plugins/infra/plugins/spawn/core/internal/child-env.ts`: add `SINGULARITY_PARENT_LIFELINE`.
- `plugins/packages/plugins/flock/core/internal/exit-with-parent.ts` (new) and `lifeline-block.ts` (the worker body); export `exitWithParent` from `flock/core/index.ts`.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/worker.ts`: call `exitWithParent()`.
- `plugins/infra/plugins/spawn/CLAUDE.md`: a "Children die with their parent" section covering both layers and the daemon exclusion. `packages/flock/CLAUDE.md`: document the lifeline.

## Verification

- **Unit tests**, run with `./equin test plugins/infra/plugins/spawn plugins/packages/plugins/flock`. Each test uses a small harness process, run via `process.execPath`, that calls `spawnCaptured` on a long-sleeping bun child, prints the child's pid, then blocks:
  - SIGTERM the harness: the child is dead within about 1 s (Layer 1).
  - SIGKILL a harness whose child calls `exitWithParent()` while spinning synchronously: the child is dead within about 1 s (Layer 2).
  - The harness exits normally: the child is dead.
  - A child that exits first: nothing is left registered, and no error.
  - Without the env var, `exitWithParent()` is a no-op.
- **Live check:**
  1. Run `./equin build`.
  2. In this worktree, start `./equin check type-check` in the background and wait for `type-check/shared/worker.ts` to appear in `ps`.
  3. `kill -TERM <cli pid>`, and confirm with `ps -axo pid,ppid,command | grep type-check/shared/worker` that the worker is gone.
  4. Repeat with `kill -KILL <cli pid>`.
- **Run `./equin check`** (boundaries: `packages/flock` core stays npm-free; `infra/spawn` still imports only `spawn-priority` and `flock`).
