# Host-semaphore: wake a waiter on *any* freed slot

**Date:** 2026-07-10
**Category:** global (packages/host-semaphore + framework/cli)
**Status:** plan

## Context

Both host-wide flock gates make a waiter commit to a single **pid-hashed** slot:

- `plugins/packages/plugins/host-semaphore/scripts/broker.ts:56`
- `plugins/framework/plugins/cli/bin/host-semaphore.ts:81`

A blocking `flock(2)` can only wait on one open file description, so once the
non-blocking sweep finds nothing free, the waiter parks on one slot. If a
*different* slot frees, the waiter is never woken and that slot sits idle.

Reproduced 2026-07-09 against the live `type-check-worker-background` pool (size 9)
while a real `./equin check` held 8 slots: a waiter stayed blocked 2.5+ min
with a free slot available. The bound is never violated (concurrency stays ≤ size),
so this is a **utilization and latency defect, not a correctness one**.
`research/2026-07-09-global-type-check-worker-host-budget.md:321-346` records the
original finding.

Severity scales with hold duration × slots held. `acquireShare` lets one caller
hold 8 of 9 slots for a whole check, so a waiter has an ~8/9 chance of committing
to a long-held slot.

`flock` was chosen precisely for its crash-safety — the lock releases when the fd
closes **or the holder dies** — so any fix must still wake a waiter when a holder is
SIGKILLed. That rules out a userspace notification (touch-a-tick-file + watcher
never fires on a hard kill).

**Intended outcome:** a waiter is woken when *any* slot frees, by any means
(graceful release or SIGKILL), in one shared mechanism rather than two divergent
copies.

## Decisions

Resolved with the user:

1. **Turnstile + fan-out.** Keep flock as the truth. A waiter spawns one blocking
   child per slot and takes the first grant; a per-pool turnstile ensures only the
   *head* waiter fans out, host-wide.
2. **Unify the CLI onto the primitive.** Delete the duplicated flock in
   `cli/bin/host-semaphore.ts`; reimplement `withHostSlot` on `createHostSemaphore`.
3. **Fix the size-identity bug** (below). Found while investigating; same mechanism.
4. **Barging stays.** The fast-path sweep does not consult the turnstile. A fresh
   caller can still take a slot a queued waiter was about to win. This is today's
   behavior; the turnstile buys serialized *wakeup*, not FIFO *fairness*. Stated
   explicitly so nobody assumes FIFO.

Not in scope: `push.lock` (`cli/bin/commands/push.ts:279-300`) is a size-1 mutex
with a holder-identity marker probed out-of-band by `pushLockHeld` — not a counting
pool, and it has no stranding defect. It stays for the host-admission unification.

## Measurements that drive the design

Taken on this host (18 cores / 64 GB), 2026-07-10. These are the load-bearing facts;
each replaced an assumption that turned out to be wrong.

| Probe | Result |
| --- | --- |
| `broker.ts` blocked in flock, parent closes stdin (**EOF only**) | **stays blocked — orphan** |
| `broker.ts` blocked in flock, parent sends SIGTERM | exits (143) |
| Worker-thread child, EOF only | exits (0) |
| Worker-thread child, SIGTERM | exits (0) |
| Worker-thread child, holder SIGKILLed → grant latency | **10 ms** |
| Blocked `bun` RSS | 76 MB; `--smol` 42 MB; worker child `--smol` **37 MB** |

Re-measured after implementation, against the real primitive:

| Probe | Result |
| --- | --- |
| Original incident replayed (size 9, holder keeps 8, A releases the 9th) | B granted **36 ms** after a *different* slot freed (was: 2.5 min stall) |
| Fan-out process count, size-9 pool saturated, W=4 waiters | **12** children = `size + (W−1)`; a naive fan-out would be 36 |
| Total RSS of those 12 waiter children | **283 MB** (≈23.6 MB each — *below* the 37 MB estimate) |
| Children remaining after the waiters drain | **0** |
| 9/9 slots held, both holders SIGKILLed (no reaper) | **0/9** held — kernel dropped every flock |
| Concurrent first-acquire on a fresh pool (8 trials × 12 processes) | 96/96 OK (pre-fix: 1 crash per 72) |

Two consequences:

- **The orphan hole is real, and it is exactly the SIGKILLed-parent case.** A child
  blocked in a *synchronous* FFI `flock` on its main thread has no event loop, so it
  cannot observe stdin EOF. When the parent is SIGKILLed nobody is alive to send
  SIGTERM. Today that strands one broker; naive fan-out would strand `N`. Agent
  builds are killed on deploy, so this fires routinely.
- **SIGTERM *does* reach a blocked broker** (`flock` is an interruptible slow
  syscall). Today's `release()` works because it calls `kill()`, not because of the
  stdin-EOF drain. The EOF path is currently decorative.

The fix for both: run the blocking `flock` on a **worker thread** so the child's main
thread stays responsive to EOF and signals. Verified above at no RSS cost.

## Design

### 1. `scripts/flock-wait.ts` replaces `scripts/broker.ts`

A generic child that blocks on **one** lock file, named by env
(`HOST_SEM_LOCK_FILE`). Used for both slot waits and the turnstile — one script, two
roles. Imports nothing cross-plugin (only `node:*` + `bun:ffi`), as `broker.ts` does
today.

- **Main thread:** spawns a `node:worker_threads` Worker; awaits its `granted`
  message; writes `granted\n` (guarding EPIPE exactly as `broker.ts:64-72`); then
  drains `Bun.stdin.stream()` to EOF and exits. Also handles SIGTERM.
- **Worker thread** (`scripts/flock-block.ts`): `openSync(file, "w")`,
  `flock(fd, LOCK_EX)` — blocks *this thread only* — then `postMessage("granted")`.
  The fd is process-wide, so process exit closes it and the lock auto-releases.

This closes the orphan hole: a still-blocked loser whose parent was SIGKILLed sees
stdin EOF on its main thread and exits before ever taking a lock.

Spawn children with `bun --smol` (37 MB vs 76 MB).

### 2. `acquireShare` slow path: turnstile, then fan out

`plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts`

The fast path (`sweepKeep`, `:122-134`) is unchanged — a non-blocking `LOCK_NB`
sweep, microseconds, no subprocess. Only the slow path (every slot busy) changes:

1. **Take the turnstile.** `flock(<dir>/turnstile.lock, LOCK_NB)` in-process. If it
   fails, another waiter is queued: spawn one `flock-wait(turnstile.lock)` child and
   await its grant. The turnstile is a **single file**, so blocking on it is an
   ordinary flock queue — immune to the stranding bug by construction.
2. **Re-sweep.** A slot may have freed while queued. If ≥1 acquired → release the
   turnstile and return.
3. **Fan out.** Spawn `size` `flock-wait(slot-i.lock)` children, one per slot.
   `Promise.race` over all `size` stdout readers — *all attached before awaiting*, or
   a sequential read deadlocks on the wrong child.
4. **SIGKILL the `size − 1` losers and `await Promise.all(losers.map(l => l.exited))`.**
   SIGKILL cannot be caught, and process death cancels a blocked `flock` cleanly. A
   loser that had *already* acquired a different slot releases it by dying. The await
   is mandatory: unreaped killed children become defunct, and the extras sweep must
   not run until their slots are actually back.
5. **Release the turnstile**, then re-sweep for up to `max − 1` extras (`:182`).

`release()` closes the parent's own fds and reaps the winner via the existing
`stdin.end()` + `kill()` + `await exited` (`:195-203`).

**Deadlock:** none. The turnstile is only ever held by *waiters*; a slot-holder never
needs it, and a turnstile-holder waits only for a slot, which holders always release.
The wait-for graph is acyclic — the same argument as
`research/2026-07-09-…-host-budget.md:253-263`.

**Process count.** Per contended pool: `size` fan-out children for the single head, plus
one turnstile child per other waiter = `size + (W − 1)`, versus today's `W`. The
marginal cost is a fixed `size − 1` per contended pool, *not* `size × W` — the turnstile
is what buys that. Pools of size 1 (`push`, `layout-geometry`) degenerate to today's
single child and are unaffected. `run()` (max = 1) still fans out to all `size` slots
— that is the fix; a `max=1` waiter blocking on one slot strands exactly as today.
The `run()` consumers are all small pools (`heavy-read` 4, `worktree-mutate` 3,
`db-fork` 2, `layout-geometry` 1); `type-check` (9) uses `acquireShare`.

### 3. Size is part of the pool's identity

**A second, live defect.** `~/.singularity/build-slots/` currently holds
`build-0.lock … build-11.lock`, while today's `buildSlotCount()` is
`floor(18/4) = 4`. A process once ran this pool at size 12. `size` names the slot-file
set but is **not** part of the pool's identity, so an old-size process holding
`build-7.lock` is invisible to new-size processes that only sweep `build-0..3` — the
bound is silently exceeded. Four pools take an env override for `size`
(`SINGULARITY_{BUILD,HEAVY_READ,DB_FORK,WORKTREE_MUTATE}_CONCURRENCY`), so this is
reachable today, not hypothetical. `type-check` already forbids an env override for
exactly this reason (`type-check/check/index.ts:148-163`).

Two changes, per *fix the structural issue, not the instance*:

- **Delete the four env overrides.** Size becomes a pure function of stable host facts
  (`os.cpus()`, `os.totalmem()`), identical in every process — the `hostWorkerBudget()`
  precedent. This is what actually prevents mismatch.
- **Persist a `<dir>/size` sentinel** so any residual mismatch is *loud*. On first
  acquire, under `flock(<dir>/.size.lock)`: absent → write it. Present and equal →
  proceed. Present and different → `LOCK_NB`-sweep `slot-0 … slot-(max(old,new)−1)`;
  if every slot is free the pool is idle and it is safe to rewrite the sentinel and
  unlink the extras; otherwise **throw** (`pool "build" is live at size 12; this
  process was built for 4`). A silent overcommit becomes a crash.

Migration: the stale `build-0..11.lock` files are inert once filenames change to
`slot-i.lock`; delete the directory once.

### 4. Hooks: the primitive grows `onWaitStart`

The CLI's `HostSlotHooks` (`cli/bin/host-semaphore.ts:37-40`) needs *"the wait has
begun"* to **open** a span — `build.ts:1078` prints "Waiting for a build slot" and
opens `buildSlotWait`; `push.ts:113` closes `stepStart("slot-wait")`. The primitive's
`onWait(waitMs)` fires *once, at acquisition* (`host-semaphore.ts:185`) and can never
express that. This is the crux of the CLI unification, not an options-bag reshuffle.

```ts
export interface AcquireHooks {
  /** Slow path entered (all slots busy), before any child is spawned. Never on the fast path. */
  onWaitStart?(): void;
  /** Always, fast or slow, once, at acquisition, before the body runs. */
  onAcquired?(waitMs: number): void;
}
run<T>(fn: () => Promise<T>, hooks?: AcquireHooks): Promise<T>;
acquireShare(max: number, hooks?: AcquireHooks): Promise<HostShare>;
```

`onAcquired` replaces the positional `onWait` and keeps its semantics (type-check's
`waitedMs >= 100` threshold at `check/index.ts:235` still works).

### 5. CLI unification

`cli/bin/host-semaphore.ts` keeps `HostSlotKind`, `buildSlotCount()` (now env-free),
and reimplements:

```ts
const pools = {
  build: createHostSemaphore({ name: "build", size: buildSlotCount() }),
  push: createHostSemaphore({ name: "push", size: 1 }),
};
export async function withHostSlot<T>(kind, fn, hooks?) {
  if (kind === "exempt") { hooks?.onAcquired?.(); return await fn(); }
  return pools[kind].run(fn, { onWaitStart: hooks?.onWaitStart, onAcquired: () => hooks?.onAcquired?.() });
}
```

`withHostSlot` is already `async`, and `cli/bin` already imports `@plugins/*`
(`build.ts:31` → `spawn-priority/server`), so the edge `cli/bin →
packages/host-semaphore/server` is established and cycle-free (the barrel imports only
`infra/paths/server`).

> **Transient over-admission across the deploy.** Lock files move from
> `build-slots/build-i.lock` → `build-slots/slot-i.lock`, and
> `build-slots/push-0.lock` → `push-slots/slot-0.lock`. A pre-change build still
> running does **not** contend with a post-change one, so the build bound is doubled
> until it drains. Push is unaffected (already serialized by `push.lock`). Drain
> in-flight builds before merging, or accept one bounded window.
>
> **Observed live during implementation**, not just predicted. Mid-rollout, a probe of
> actual flock state showed:
>
> ```
> build-slots:  HELD(4): build-0..3.lock     <- processes started pre-rewrite
>               FREE:    slot-0..3.lock      <- new-code processes sweep these
> ```
>
> Two `./equin check` processes begun before the CLI rewrite held the old files
> while new-code processes saw an empty pool. Both bounds were individually respected;
> the host ran 2× the intended build concurrency. This is precisely the window above,
> and it confirms the fence is required rather than optional. The stale
> `build-0..11.lock` files must also be removed as part of the migration, or they will
> linger forever as inert clutter that a future `size` sentinel cannot explain.

## Files

| File | Change |
| --- | --- |
| `plugins/packages/plugins/host-semaphore/scripts/broker.ts` | **delete** |
| `plugins/packages/plugins/host-semaphore/scripts/flock-wait.ts` | **new** — one lock file, worker-thread blocking flock |
| `plugins/packages/plugins/host-semaphore/scripts/flock-block.ts` | **new** — worker body |
| `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts` | turnstile + fan-out; size sentinel; `AcquireHooks` |
| `plugins/packages/plugins/host-semaphore/server/index.ts` | export `AcquireHooks` |
| `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.test.ts` | new tests (below) |
| `plugins/packages/plugins/host-semaphore/CLAUDE.md` | replace the "Known limitation" block; document fan-out + turnstile + process math |
| `plugins/framework/plugins/cli/bin/host-semaphore.ts` | delete flock; reimplement on `createHostSemaphore`; drop `SINGULARITY_BUILD_CONCURRENCY` |
| `plugins/framework/plugins/cli/bin/commands/{build,push}.ts` | hook shape unchanged at the call site (`withHostSlot` keeps `HostSlotHooks`) |
| `plugins/infra/plugins/host-read-pool/server/internal/pool.ts` | `run(fn, hooks)`; drop `SINGULARITY_HEAVY_READ_CONCURRENCY` |
| `plugins/database/plugins/admin/server/internal/fork-gate.ts` | `run(fn, hooks)`; drop `SINGULARITY_DB_FORK_CONCURRENCY` |
| `plugins/infra/plugins/worktree/server/internal/mutate-gate.ts` | `run(fn, hooks)`; drop `SINGULARITY_WORKTREE_MUTATE_CONCURRENCY` |
| `plugins/primitives/plugins/css/plugins/layout-harness/check/index.ts` | `run(fn)` — no hooks, no change beyond types |
| `plugins/debug/plugins/profiling/plugins/boot-bench/server/internal/load-generator.ts` | `run(fn)` — ditto |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts` | `acquireShare(max, { onAcquired })` |

`./equin build` regenerates `docs/plugins-*.md`; `plugins-doc-in-sync` covers drift.

## Verification

**1. Unit** — `bun test plugins/packages/plugins/host-semaphore`. The 9 existing tests
must pass **unmodified** — that is the regression gate. New cases:

- **Stranding (the gate; fails today).** Size-4 pool. Take four `acquireShare(1)`
  handles → they deterministically hold `slot-0…3` (the sweep is in file order).
  Start a waiter, then release handle `k`; assert the waiter resolves in < 2 s.
  Parameterize `k ∈ {0,1,2,3}`. Today the broker parks on `childPid % 4`, so at least
  3 of the 4 cases hang — deterministic as a suite, where a single-`k` test would be
  flaky. (A white-box variant that spawns the script directly and predicts
  `child.pid % N` is possible but couples the test to the pid-hash we are deleting.)
- **SIGKILL wake.** A holder *child process* takes the only slot; SIGKILL it; the
  waiter must be granted (< 2 s). Measured at 10 ms in the spike. This is the test
  that fails for any watcher/tick-file design.
- **Orphan.** Spawn a waiter through an intermediate parent, SIGKILL the parent,
  assert no `flock-wait` children survive after ~1 s. Fails today.
- **No zombies / no undercount.** After a grant, assert the losers are reaped (no
  defunct children), and that a waiter released a full 8-slot share re-sweeps to
  `slots > 1` — i.e. the extras sweep runs *after* the losers actually exit.
- **Size identity.** Create a size-4 pool, hold a slot, construct a size-8 pool on the
  same name → throws loudly. With the pool idle → resizes silently.

**2. Single build unchanged** — `./equin build` on an idle host: 8 type-check
workers, wall time within noise. Zero `flock-wait` children (pure fast path).

**3. The original repro** — saturate `type-check-worker-background` (8 of 9 slots) with
a real `./equin check`, take the last slot from a second process, release it, and
confirm a third, blocked caller is granted promptly instead of hanging 2.5 min.

**4. Concurrent builds bounded** — run `./equin check` in 3–4 worktrees at once:

```bash
pgrep -fl 'type-check/shared/worker.ts' | wc -l     # ≤ 9
pgrep -fl 'host-semaphore/scripts/flock-wait.ts'    # ≤ size + (W-1) per contended pool
ls ~/.singularity/type-check-worker-background-slots/  # slot-0 … slot-8 + turnstile.lock + size
```

Sample `uptime` and compare against the 50–63 load baseline in the incident doc.

**5. Crash-safety end-to-end** — kill a worktree backend mid heavy-read op; confirm
`~/.singularity/heavy-read-slots/*.lock` release and the next acquire succeeds
immediately (`lsof` shows no lingering holders, `pgrep flock-wait` is empty).

## Risks

- **`bun:ffi` `dlopen` inside a `node:worker_threads` Worker.** Verified working on
  darwin-arm64 in the spike (blocked correctly; granted 10 ms after the holder was
  SIGKILLed; clean exit on EOF and SIGTERM). Re-verify on Linux before merge.
- **Fan-out amplifies memory in the pools whose memory pressure motivated the work.**
  Bounded by the turnstile to `size − 1` extra children per contended pool at 37 MB
  each. The steady-state offender is `heavy-read` (size 4 → +3 children ≈ 110 MB),
  not `type-check` (9), which fans out only when its whole pool is saturated.
  If measurement shows otherwise, the fallback is a SysV `SEM_UNDO` semaphore — it
  wakes on any release with **no** fan-out — at the cost of an intricate two-phase
  init whose failure mode (creator SIGKILLed mid-init → value stuck at 0) is a
  permanent host-wide deadlock for that pool.
- **Barging is unchanged**, so a queued waiter can still be beaten by a fresh
  fast-path caller. Not a regression; documented, not fixed.
