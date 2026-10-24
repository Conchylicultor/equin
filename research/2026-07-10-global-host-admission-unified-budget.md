# Host admission: one registry, one ceiling, one grant

**Date:** 2026-07-10
**Category:** global (infra/host-admission + packages/host-semaphore + framework/cli + tooling)
**Status:** plan

## Context

Host-wide concurrency admission was fragmented across three flock implementations and
six mutually-unaware pools. **The mechanism half has since landed** (`d4dd20a93`,
2026-07-10, planned in
[`2026-07-10-global-host-semaphore-any-slot-wakeup.md`](./2026-07-10-global-host-semaphore-any-slot-wakeup.md)):
`cli/bin/host-semaphore.ts` dropped its duplicated flock and is now pure policy over
`createHostSemaphore`, and `cli/bin/lane.ts` gave the interactive/background fact one
CLI-side spelling.

What remains is the harder half, and it is exactly the two properties the original
task named:

> a resource admitted to a pool has no obligation to declare what it will fan out
> into, and there is no summed budget across lanes.

### The state today

| Pool | Size @18cpu/68GB | Bounds | Fans out into |
| --- | --- | --- | --- |
| `build` | 4 | CPU | vite + `runChecks`, which enters the **type-check pool it cannot see** |
| `push` (capacity) | 1 | — | vestigial (below) |
| `push.lock` | 1 | main-worktree serialization | raw FFI **blocking** flock — the surviving 3rd impl |
| `heavy-read` | 4 | git/fs IO | 1 subprocess |
| `worktree-mutate` | 3 | git checkout | 1 subprocess |
| `db-fork` | 2 | pg CPU | `pg_dump` \| `pg_restore` + a pg backend |
| `layout-geometry` | 1 | Chromium | `bun test` → vite + chromium |
| `type-check-worker-interactive` | 9 | RAM+CPU | 9 × 2.7 GB workers |
| `type-check-worker-background` | 9 | RAM+CPU | 9 × 2.7 GB workers |

Five findings drive the design. Each replaced an assumption.

1. **The lane split *doubled* the type-check ceiling instead of partitioning it.**
   Two disjoint slot dirs ⇒ the stated host ceiling is `2·B` = 18 workers ×
   2.7 GB = **48.6 GB** on a 68.7 GB box, and an idle interactive pool cannot lend
   capacity to a saturated background one. The fix for the 2026-07-09 incident is
   itself an overcommit.

2. **"Host-wide occupancy is not cheaply readable from the flock slot files" is
   false.** That comment appears verbatim in `host-read-pool/server/internal/pool.ts:37-39`,
   `worktree/server/internal/mutate-gate.ts:36-37`, and `database/admin/server/internal/fork-gate.ts:33-34`.
   But `pushLockHeld` (`worktree-op.ts:272-287`) already reads exactly this — an
   `openSync` + `flock(LOCK_EX|LOCK_NB)` + `closeSync` probe — and its test
   (`worktree-op.test.ts:106-128`) asserts it detects a holder **on a separate fd in
   the same process**. flock locks attach to the open file description, not the
   process. A real `hostOccupancy()` is a few syscalls.

3. **The `push` capacity pool bounds nothing.** `push.lock` already serializes pushes
   host-wide, so the size-1 `push` pool is never contended — its own comment concedes
   this (`cli/bin/host-semaphore.ts:46-49`). Its stated purpose ("a push never queues
   behind builds") is achieved by *not being the build pool*; the pool itself is
   ceremony.

4. **`kind: "exempt"` and `SINGULARITY_HOST_SLOT_HELD` are the same workaround twice.**
   Both exist only because a nested child would re-acquire a pool its parent already
   holds (`check.ts:46`, `push.ts:76`). If admission returned a **grant** the child
   *spends* rather than a permission it *re-takes*, both disappear — and so does the
   deadlock they were dodging.

5. **`B` is computed from host facts in isolation.** `hostWorkerBudget()` reads
   `min(cpus/2, 0.5·totalmem/2.7 GB)` as if the type-check fleet were the only thing
   on the box. Every other pool does the same. Six independent reads of `os.cpus()`,
   no sum.

### Intended outcome

- Every host pool is declared in one registry; `createHostSemaphore` becomes private
  to it, so a 7th pool cannot appear without taking budget from the others.
- The CPU pool's size `B` is the **residual** of the summed budget, not an independent
  formula — the sum sets `B` rather than merely policing it.
- Admission returns a **token grant**. A holder subdivides it among everything it
  spawns; nothing it spawns acquires again.
- One host-wide occupancy readout.

## Decisions

Resolved with the user:

1. **Registry + grant** (both stages). Not registry-only.
2. **Reserved floor inside one pool**, not two disjoint lane pools.
3. **Demotion stays keyed on `branch === "main"`.** Admission and OS scheduling
   priority remain orthogonal axes; folding demotion into the lane is a separate
   change with its own measurement (as `2026-07-09-…-host-budget.md` §3 argued).

## The budget

One ceiling, in two dimensions. Every pool declares what **one admitted holder costs
the host, including everything it spawns.**

```
hostCpuCeiling() = os.cpus().length            // 18
hostRamCeiling() = os.totalmem() * 0.5         // 34.4 GB
PER_UNIT_BYTES   = 2.7e9                       // one type-check-class worker
```

| Pool | size | cpuCost | Σ cpu |
| --- | --- | --- | --- |
| `heavy-read` | `max(1, cpus/4)` = 4 | 0.5 (IO-bound) | 2.0 |
| `worktree-mutate` | `max(2, cpus/6)` = 3 | 0.5 (IO-bound) | 1.5 |
| `db-fork` | 2 | 1.0 (2 procs + a pg backend) | 2.0 |
| `layout-geometry` | 1 | 1.0 (vite + chromium) | 1.0 |
| `push` (mutex) | 1 | 0 (waits on git/network) | 0.0 |
| | | **reserved** | **6.5** |

`B` is what is left:

```
B = max(1, min( floor(hostCpuCeiling - reservedCpu),
                floor(hostRamCeiling / PER_UNIT_BYTES) ))
  = min(floor(18 - 6.5), floor(34.4 / 2.7)) = min(11, 12) = 11

reservedInteractive = max(1, floor(B / 3)) = 3
backgroundLimit     = B - reservedInteractive = 8
```

**What this buys, on this host:**

| | today | after |
| --- | --- | --- |
| Host worker ceiling | `2·B` = 18 | `B` = 11 |
| Worst-case worker RAM | 48.6 GB | 29.7 GB |
| Solo agent build | 8 workers | 8 workers (`backgroundLimit`) |
| Main build / push floor | ungated (`exempt`) | ≥ 3 units, always immediately |
| Σ cpu cost of all pools | unbounded, unsummed | 17.5 ≤ 18, asserted by a check |

The agent-build worker count is unchanged — the ceiling drop comes entirely from
deleting the double-count, not from throttling the common case. `reservedInteractive`
and the `cpuCost` figures are the knobs to retune after measurement; they are declared
in one file.

## Design

### 1. `plugins/infra/plugins/host-admission/` — the registry

The one place a host pool comes into existence. `core/` holds the runtime-agnostic
`Lane` type and the ceiling arithmetic (pure `os` reads, no `bun:ffi`), so the CLI,
the checks, and the server all share one definition. `server/` holds the pools.

```ts
// core
export type Lane = "interactive" | "background";
export interface PoolCost { cpu: number; ramBytes?: number }

// server
export function defineHostPool(spec: {
  id: string;                    // names ~/.singularity/<id>-slots/
  size: number;
  cost: PoolCost;                // what ONE holder costs the host, incl. fan-out
  laned?: boolean;               // reserved-floor partition (only `cpu` today)
}): HostPool;
```

`createHostSemaphore` is imported by **`host-admission` only**, enforced by a new
`host-pools-declared` check (`grepImports`, the shape `no-relative-server-imports`
already uses) plus the `exclude`-list precedent in `boundary-config.ts:38`. That is
the structural bar against adding a pool one incident at a time.

`hostOccupancy(): Promise<Array<{ id, lane, held, size }>>` — probes each slot file
**serially** with the `pushLockHeld` technique. Serial matters: probing a *free* slot
momentarily holds it, so a parallel probe of a whole pool could make a concurrent
`sweepKeep` see zero free slots and needlessly fan out. One slot at a time bounds the
transient hold to one slot. Never called from an acquire path; wired to the
health-monitor's 10 s tick and a Debug row. The three false comments get deleted and
their `registerGateGauge` `active` values become true host occupancy.

### 2. `packages/host-semaphore` grows the reserved floor

```ts
createHostSemaphore({ name, size, backgroundLimit? })
acquireShare(max, { lane, ...hooks })
```

- **background** sweeps `slot-0 … slot-(backgroundLimit-1)`.
- **interactive** sweeps all `size` slots, **in reverse order** — high slots first.
  Without the reversal, interactive holders take the low slots in file order and the
  reserved floor sits empty while background starves. This is the whole trick and it
  costs one `.reverse()`.
- The size sentinel's identity becomes `"<size>:<backgroundLimit>"`, so a process
  built for a different split is as loud as one built for a different size.
- Fan-out children are spawned over the caller's window only.
- The turnstile stays per-pool (shared across lanes): an interactive waiter can queue
  behind a background waiter's fan-out for the wakeup, which is milliseconds. Slot
  *capacity* is still strictly partitioned. Worth stating, not fixing.

Deadlock argument is unchanged: the turnstile is held only by waiters; a
turnstile-holder waits only for a slot; slot-holders always release. Acyclic.

### 3. The grant — admission returns tokens, not permission

This is the property the task asked for. A holder does not *declare* its fan-out; it
**subdivides** the tokens it was given. Declaration would be a comment; subdivision is
enforced by arithmetic.

```ts
export interface Grant {
  readonly units: number;                     // slots actually held (>= 1)
  run<T>(fn: () => Promise<T>): Promise<T>;   // spend one unit (in-process semaphore)
  env(): Record<string, string>;              // SINGULARITY_HOST_GRANT + SINGULARITY_LANE
}

export function withHostGrant<T>(
  opts: { lane: Lane; max: number },
  fn: (grant: Grant) => Promise<T>,
): Promise<T>;

/** In-process grant, else SINGULARITY_HOST_GRANT, else undefined. */
export function inheritedGrant(): Grant | undefined;
```

`withHostGrant` calls `cpuPool.acquireShare(max, { lane })`, then wraps the returned
`slots` in a plain in-process `createSemaphore(slots)` (`packages/semaphore`). Every
heavy child the holder spawns goes through `grant.run(...)`. A subprocess child
inherits the *number* via `grant.env()` and rebuilds its own semaphore — exact,
because it is the only spender of its parent's tokens.

**Degradation is graceful, not a special case.** `acquireShare` guarantees `≥ 1` unit,
never more. Under a 1-unit grant, `build.ts`'s vite and the type-check workers — which
run concurrently under `Promise.all` today — simply serialize on the semaphore. No
`min > 1` acquire (which would livelock two builds each holding 1 and waiting for a
2nd), no starvation branch.

Consequently:

- **`build` pool: deleted.** A build holds ≥ 1 cpu unit for its whole heavy section,
  so concurrent builds are bounded by `backgroundLimit` (8) rather than by a separate
  size-4 pool. Its `bun install` / dist-swap work rides that unit.
- **`type-check-worker-{lane}` pools: deleted.** The check calls `inheritedGrant()`
  and runs `mapConcurrent(targets, grant.units, t => grant.run(() => runWorker(t)))`.
  It acquires nothing. Standalone invocation (no inherited grant) falls back to
  `withHostGrant` — bounded, never exempt.
- **`kind: "exempt"` and `HostSlotKind`: deleted.** A main build takes the interactive
  lane, whose floor of 3 is unreachable by background work, so it is never blocked by
  agent builds. It *can* contend with a push; both request 1 and both progress
  (already the accepted trade in `…-host-budget.md` §"Deadlock check").
- **`SINGULARITY_HOST_SLOT_HELD`: deleted.** The push-nested check sees an inherited
  grant and never acquires. The double-acquire deadlock is gone structurally, not by
  env-var convention.
- **`cli/bin/host-semaphore.ts`: deleted.** `cli/bin/lane.ts` keeps `Lane`
  classification and `publishLane`, importing the type from `host-admission/core`.

### 4. The obligation reaches checks

`runChecks` runs every check under `Promise.all`, and two of them spawn heavy children
(`type-check` → 8 workers; `layout-geometry` → vite + chromium). Today neither is
accountable to the build that invoked it. Make the grant part of the check contract:

```ts
// framework/tooling/core/types.ts
export interface CheckContext { grant: Grant }
export interface Check { run(ctx: CheckContext): Promise<CheckResult>; /* … */ }
```

Existing checks ignore the argument. `type-check` and `layout-geometry` spend
`ctx.grant.run(...)` around each spawned child. `layout-geometry` **keeps** its size-1
pool — a grant unit bounds cost, but Chromium needs host-wide *mutual exclusion*,
which is a different guarantee — and additionally spends a unit.

### Deadlock check

- `cpu` holders spawn only grant-spending children; no host re-acquire. No nesting.
- `push` mutex → then a `cpu` grant (interactive). Mutex-holders wait for units;
  unit-holders never wait for the push mutex. Acyclic.
- A `cpu` unit-holder waits for `layout-geometry` (size 1); the `layout-geometry`
  holder holds a unit but waits for nothing. Acyclic.
- `heavy-read` / `worktree-mutate` / `db-fork` are server-side and never nest in each
  other. `warmup` and `corpus-index` wrap `heavy-read` behind their own *in-process*
  semaphores (in-process → host is a one-way edge).

### 5. `push.lock` folds onto the primitive

Declared as `defineHostPool({ id: "push", size: 1, cost: { cpu: 0 } })`. The slot file
moves to `~/.singularity/push-slots/slot-0.lock`; `PUSH_LOCK_PATH` is re-exported from
`host-admission` as the single owner and `pushLockHeld` probes it unchanged, so the
op-status derivation keeps its authoritative kernel truth.

This also removes the last **blocking** `flock(LOCK_EX)` on a caller's own thread
(`push.ts:292`): the primitive's size-1 fan-out is a single `flock-wait` child. The
"Another push is in progress — waiting for lock…" line moves to the existing
`onWaitStart` hook.

> **Migration fence.** As in the previous rollout, slot-file paths change
> (`push.lock` → `push-slots/slot-0.lock`, `build-slots/` → gone,
> `type-check-worker-*-slots/` → `cpu-slots/`). A pre-change process holds the old
> file and is invisible to a post-change one. Drain in-flight builds and pushes before
> merging, and delete the stale dirs — the same window observed live last time.

## Files

| File | Change |
| --- | --- |
| `plugins/infra/plugins/host-admission/core/index.ts` | **new** — `Lane`, `PoolCost`, `hostCpuCeiling`/`hostRamCeiling`, `B`/`reservedInteractive` arithmetic |
| `plugins/infra/plugins/host-admission/server/index.ts` | **new** — `defineHostPool`, `withHostGrant`, `inheritedGrant`, `hostOccupancy`, `PUSH_LOCK_PATH` |
| `plugins/infra/plugins/host-admission/CLAUDE.md` | **new** — the budget table, the grant contract, the reversal trick |
| `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts` | `backgroundLimit`; lane-windowed sweep + fan-out; reverse sweep for interactive; sentinel identity `size:backgroundLimit` |
| `plugins/framework/plugins/cli/bin/host-semaphore.ts` | **delete** |
| `plugins/framework/plugins/cli/bin/lane.ts` | import `Lane` from `host-admission/core`; drop the local type |
| `plugins/framework/plugins/cli/bin/commands/build.ts` | `withHostGrant` around the heavy section; drop `slotKind`/`exempt`; vite via `grant.run` |
| `plugins/framework/plugins/cli/bin/commands/check.ts` | `inheritedGrant() ?? withHostGrant`; drop `SINGULARITY_HOST_SLOT_HELD` |
| `plugins/framework/plugins/cli/bin/commands/push.ts` | `withPushLock` → the `push` pool; child env from `grant.env()`; drop the raw `dlopen`/`flock` |
| `plugins/infra/plugins/worktree/server/internal/worktree-op.ts` | `PUSH_LOCK_PATH` re-homed; `pushLockHeld` unchanged |
| `plugins/framework/plugins/tooling/core/types.ts` | `CheckContext`; `run(ctx)` |
| `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` | thread the grant into each `check.run(ctx)` |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts` | delete `hostWorkerBudget`/pool; spend `ctx.grant` |
| `plugins/primitives/plugins/css/plugins/layout-harness/check/index.ts` | `defineHostPool`; spend `ctx.grant` |
| `plugins/infra/plugins/host-read-pool/server/internal/pool.ts` | `defineHostPool`; delete the false occupancy comment; true gauge |
| `plugins/infra/plugins/worktree/server/internal/mutate-gate.ts` | ditto |
| `plugins/database/plugins/admin/server/internal/fork-gate.ts` | ditto |
| `plugins/debug/plugins/profiling/plugins/boot-bench/server/internal/load-generator.ts` | occupy via `defineHostPool` handle |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/host-budget/` | **new check** — Σ cost ≤ ceiling; `B ≥ 1` |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/host-pools-declared/` | **new check** — only `host-admission` imports `createHostSemaphore` |
| `plugins/debug/plugins/health-monitor/server/internal/host-sampler.ts` | sample `hostOccupancy()` on the 10 s tick |

`./equin build` regenerates `docs/plugins-*.md`; `plugins-doc-in-sync` covers drift.

## Order of work

1. `host-admission` core+server with `defineHostPool` + `hostOccupancy`; port the four
   server pools onto it verbatim (no behavior change). Land the two new checks.
2. `backgroundLimit` + reverse sweep in `packages/host-semaphore`, with tests.
3. `withHostGrant` / `Grant` / `inheritedGrant`; `CheckContext`.
4. Cut over `build`/`check`/`type-check` to the `cpu` pool; delete
   `cli/bin/host-semaphore.ts`, `exempt`, `SINGULARITY_HOST_SLOT_HELD`.
5. Fold `push.lock`; delete the vestigial `push` capacity pool.

Steps 1–2 are independently shippable and reversible. Step 4 is the behavior change.

## Verification

**Unit** — `bun test plugins/packages/plugins/host-semaphore`. The 9+ existing tests
must pass **unmodified** (the regression gate). New:

- background `acquireShare` never takes a slot at index ≥ `backgroundLimit`;
- with background saturating its window, an interactive `acquireShare` is granted
  immediately from the floor (no fan-out, no wait);
- interactive sweeps high-first: with an idle pool, `acquireShare(1, {lane:"interactive"})`
  holds `slot-(size-1)`;
- a pool constructed with a different `backgroundLimit` on a live pool throws;
- `hostOccupancy()` reports `held` correctly for a slot held by another process, and
  probing does not steal a slot from a concurrent acquirer (probe while a `run` body
  is in flight; assert the body never sees a reduced share).

`bun test plugins/infra/plugins/host-admission` — grant arithmetic: `units ≥ 1`;
`grant.run` bounds concurrency to `units`; `inheritedGrant()` reads
`SINGULARITY_HOST_GRANT` and never acquires.

**Budget check** — `./equin check host-budget` passes; adding a throwaway
`defineHostPool({ size: 8, cost: { cpu: 1 } })` makes it fail with the residual `B`
going non-positive. That failure *is* the convergence property; assert it explicitly.

**Solo build unchanged** — `./equin build` on an idle host: 8 concurrent
type-check workers (`backgroundLimit`), wall time within noise, zero `flock-wait`
children (pure fast path).

**Concurrent builds bounded** — the real test. `./equin check` in 3–4 worktrees
at once:

```bash
pgrep -fl 'type-check/shared/worker.ts' | wc -l   # must never exceed 8 (background)
ls ~/.singularity/cpu-slots/                      # slot-0 … slot-10 + turnstile.lock + size
pgrep -fl 'flock-wait.ts' | wc -l                 # <= size + (W-1) per contended pool
```

Sample `uptime` across the run against the 50–63 load baseline in
[`2026-07-09-global-interactive-lane-under-load.md`](./2026-07-09-global-interactive-lane-under-load.md) §2.
Before this change the same probe reads up to 18 workers.

**The floor is reachable** — saturate the background window with agent checks, then
`./equin build --allow-main` on main. It must acquire ≥ 3 units from
`slot-8..10` without waiting. This is the test that `exempt`'s deletion did not cost
the main build its head-of-line position.

**Push does not queue behind builds** — `./equin push` from a worktree while
agent checks saturate the background lane. Its nested check must inherit the grant
(never re-acquire) and land in the interactive lane.

**Occupancy is true** — hold a `heavy-read` slot from one worktree backend; from
*another* backend, `hostOccupancy()` must report `held: 1`. Today's gauge reports 0.
This is the assertion that retires the "not cheaply readable" claim.

**Crash-safety end-to-end** — SIGKILL a backend mid heavy-read and a build mid
type-check; confirm slots release (`hostOccupancy()` drops to 0), no `flock-wait`
children survive, and the next acquire is immediate.

## Out of scope

- **Lane-driven demotion.** `workerDemotion()` keeps `branch === "main"`; push's
  workers stay darwinbg-demoted. Same axis-separation argument as
  `…-host-budget.md` §3. Flagged, not folded in.
- **Nesting the IO pools inside the CPU ceiling at runtime.** They statically reserve
  against it instead. Nesting an interactive backend's git read inside a pool agent
  builds can saturate trades a bounded host for an unbounded p99, and adds
  priority-inversion surface.
- **Unifying `Lane` with `runtime-profiler`'s `OriginClass`.** They are the same
  partition at two layers (host processes vs. DB connections), but `runtime-profiler`
  → `host-admission/core` would close a cycle against the gauge edge, and cross-plugin
  re-export of the type is banned. Worth a follow-up that moves the type to a leaf.
- **Load-reactive admission** (reading `health-monitor`'s loop lag or
  `infra/contention`'s snapshot to admit adaptively). The static budget must be shown
  correct first; a feedback loop on top of a wrong ceiling is a worse ceiling.
- **Barging.** Unchanged — the fast-path sweep does not consult the turnstile, so a
  fresh caller can still beat a queued waiter. Not FIFO. Documented, not fixed.
