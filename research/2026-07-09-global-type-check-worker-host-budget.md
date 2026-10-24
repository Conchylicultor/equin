# Host-wide type-check worker budget

**Date:** 2026-07-09
**Category:** global (tooling / packages)
**Status:** plan

## Context

`./equin build` runs the `type-check` check, which fans out one worker
process per tsconfig target (8 targets today: `central-core`, `cli`, `server-core`,
`tooling`, `web-core`, `web-core-node`, `tools`, `test`). Each worker builds a full
TypeScript program — multi-GB, single-threaded.

The fleet size is computed at
`plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts:186-190`:

```ts
const PER_WORKER_BYTES = 2.7e9;
const limit = Math.max(
  1,
  Math.min(targets.length, os.cpus().length - 1, Math.floor((os.totalmem() * 0.5) / PER_WORKER_BYTES)),
);
```

That formula reads like a **host** budget — "half the machine's RAM, all but one
core" — but it is evaluated **per build process**, each of which assumes it is the
only build on the box. The CLI build pool
(`plugins/framework/plugins/cli/bin/host-semaphore.ts`, `floor(cpus/4)` slots) bounds
concurrent **builds**, not the workers each build spawns. So 4–5 overlapping agent
builds legitimately spawn 8 workers each — 30–40 multi-GB processes.

Measured on 2026-07-09 (see
[`research/2026-07-09-global-interactive-lane-under-load.md`](./2026-07-09-global-interactive-lane-under-load.md)
§2 and §7, which defers this fix explicitly):

- host load 50–63 on 18 cores;
- builds stretched from ~1–3 min to 25+ min — thrash widens the overlap window, so
  the pile-up is self-reinforcing;
- main backend event-loop lag followed the dose-response curve (load 48–56 → ~1,050 ms
  p50), freezing the app.

Note that `backgroundArgv` (darwinbg) demotion is already applied at the worker spawn
site for non-main branches. It changes *how hard* each worker competes for CPU/IO; it
does not change *how many* exist. Memory pressure — 30–40 × 2.7 GB against 64 GB — is
not something a scheduling-priority tier can fix.

**Intended outcome:** the number of type-check workers running concurrently *on the
host* is bounded, whatever the number of overlapping builds. A solo build on an idle
host behaves exactly as it does today (8 workers); the Nth concurrent build degrades
to fewer workers instead of overcommitting the machine.

## Two lanes, not an exemption

The existing code spells "this work is human-blocking, don't throttle it" three
different ways:

| Site | Spelling |
| --- | --- |
| `build.ts:942` | `branch === "main" ? "exempt" : "build"` |
| `type-check/check/index.ts:60` | `branch === "main"` → no demotion |
| `check.ts:45` | `process.env.SINGULARITY_HOST_SLOT_HELD` → `"exempt"` |

Those are three encodings of one fact: **who is waiting on this work.** A `main`
build and a `push` are human-blocking. An agent build or a direct agent
`./equin check` is background.

This matters concretely, and it is the trap in the obvious design. `push` runs its
checks on the *rebased agent branch*, not on `main` — so a naive `branch === "main"`
gate would send **push's type-check fleet into the background pool**, where it can
queue behind 9 darwinbg-demoted agent workers pinned to E-cores. That would silently
destroy the "a push never queues behind builds" property that the reserved single
push slot exists to guarantee (`host-semaphore.ts:46-48`).

So the gate keys on the **lane**, not the branch:

```
interactive  ←  main build,   push (its nested check)
background   ←  agent build,  direct agent check
```

Both lanes get their own pool of size `B`. Pure exemption was rejected: it would put
`9 + 8 + 8 = 25` workers × 2.7 GB = 67 GB on a 64 GB box — the exact swap condition
being fixed, merely made rarer. A bounded interactive lane keeps a **stated host
ceiling of `2·B` = 18 workers**, and in the common case (no main build, no push in
flight) only `B` = 9 run. Both interactive origins are already globally serialized —
`main` by its per-worktree build lock, `push` by `push.lock` — so the interactive
lane is rarely contended by more than one holder.

## Decisions

Resolved with the user:

1. **Two pools, `background` and `interactive`, each of size `B`.** Lane is
   classified by origin, not branch (above).

2. **`B = max(1, min(floor(cpus/2), floor(0.5·totalmem / 2.7 GB)))`** — the CPU term
   tightens from `cpus−1` to `cpus/2`. On this host (18 cpu / 64 GB): `min(9, 12) = 9`.
   The old `cpus−1 = 17` left one core for ~16 worktree backends, postgres, and up to
   4 concurrent vite builds. `cpus/2` targets the incident doc's "load < 24 → ~1 ms
   lag" band.

   No env override. `B` **must** be identical in every process, because it names the
   set of flock slot files (`slot-0 … slot-(B−1)`); an env var makes a mismatch
   possible, and a mismatch silently drops the bound. `os.cpus()` / `os.totalmem()`
   are stable per host.

3. **Greedy share acquired up-front**, not a slot per worker.
   `createHostSemaphore.run()` spawns one broker subprocess per *waiting* caller;
   wrapping each `runWorker` would put up to 8 brokers per build (~40 host-wide) on
   the box precisely when it is already under memory pressure. Instead the check
   acquires its whole share once, before fanning out: block for the first slot, then
   take any additional free slots with a non-blocking sweep. **At most one broker per
   build.**

   Trade-off accepted: slots stay held until the whole check finishes, so there is
   some tail waste once the slowest target is the only one left. Releasing slots as
   targets drain is a possible later refinement.

## Design

### 1. Extend `packages/host-semaphore` with `acquireShare`

`plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts`

The primitive today exposes only `run(fn, onWait?)` — acquire exactly one slot, hold
it across `fn`. The new caller needs "give me between 1 and `max` slots". That belongs
in the primitive (it owns the fd bookkeeping and the broker lifecycle), not in the
check.

```ts
export interface HostShare {
  /** Slots actually held — always ≥ 1, never > the requested max. */
  readonly slots: number;
  /** Idempotent. Closes local fds and reaps the broker (if one was spawned). */
  release(): Promise<void>;
}

export interface HostSemaphore {
  run<T>(fn: () => Promise<T>, onWait?: (waitMs: number) => void): Promise<T>;
  /**
   * Block until at least ONE slot is held, then greedily take any additional free
   * slots up to `max` with a non-blocking sweep. Never spawns more than one broker.
   */
  acquireShare(max: number, onWait?: (waitMs: number) => void): Promise<HostShare>;
  depth(): number;
}
```

Algorithm:

1. `mkdirSync(slotsDir)`; open all `B` fds.
2. Non-blocking `flock(LOCK_EX | LOCK_NB)` sweep; keep the first `max` fds that lock,
   close the rest.
3. If ≥ 1 held → return `{ slots, release }`. No broker, no subprocess. (This is the
   whole story on an idle host.)
4. Otherwise every slot is busy: close all fds, spawn **one** `scripts/broker.ts`
   (unchanged), `await awaitGranted(...)` — incrementing/decrementing `waiting` in a
   `finally`, exactly as `run` does today, so `depth()` keeps its meaning. Once
   granted, re-run the non-blocking sweep for up to `max − 1` extra slots that freed
   during the wait. Return `{ slots: 1 + extra, release }`.
5. `release()` closes local fds (flock auto-releases), then `broker.stdin.end()` +
   `kill()` + `await broker.exited` — the existing teardown, lifted out of `run`'s
   `finally`.

`run(fn, onWait)` is then reimplemented as
`acquireShare(1, onWait)` → `try { fn() } finally { share.release() }`, which
deduplicates the fast/slow acquire and keeps `depth()` and crash-safety identical.
Existing behavior is unchanged and the existing tests
(`host-semaphore.test.ts`, 4 tests) must keep passing untouched.

Crash safety is inherited: flock releases when the fd closes **or the holding process
dies**, so a SIGKILLed build never leaks slots — no lease, heartbeat, or reaper.

### 2. Classify the lane at the CLI, consume it in the check

The CLI already knows the origin; the check should not re-derive it. Add an explicit
signal rather than overloading `SINGULARITY_HOST_SLOT_HELD` (which means "don't take a
CLI slot", a different fact that merely happens to correlate today).

- `plugins/framework/plugins/cli/bin/commands/push.ts` — set
  `SINGULARITY_LANE: "interactive"` in the child check's `env` (alongside the existing
  `SINGULARITY_HOST_SLOT_HELD`).
- `plugins/framework/plugins/cli/bin/commands/build.ts` — set
  `process.env.SINGULARITY_LANE` from the branch it already resolved for `slotKind`,
  before calling `runChecks` in-process.
- `plugins/framework/plugins/cli/bin/commands/check.ts` — same, for a direct
  `./equin check` (main worktree → interactive; otherwise background).

Unset defaults to `background`, which is the safe direction: a check invoked by any
other path gets bounded, never exempted.

### 3. Gate the type-check fleet

`plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts`

```ts
const PER_WORKER_BYTES = 2.7e9;
const hostWorkerBudget = () =>
  Math.max(1, Math.min(
    Math.floor(os.cpus().length / 2),
    Math.floor((os.totalmem() * 0.5) / PER_WORKER_BYTES),
  ));

const lane = process.env.SINGULARITY_LANE === "interactive" ? "interactive" : "background";
const pool = createHostSemaphore({
  name: `type-check-worker-${lane}`,        // ~/.singularity/type-check-worker-{lane}-slots/
  size: hostWorkerBudget(),
});
```

Note `targets.length` is deliberately **not** a term in `B`: it bounds this build's
request (`max`), not the host's slot-file set.

Then, replacing the `limit` computation:

```ts
const max = Math.min(targets.length, hostWorkerBudget());
const share = await pool.acquireShare(max, (waitMs) => noteContention(waitMs));
try {
  await mapConcurrent(targets, share.slots, async (t) => { /* unchanged */ });
} finally {
  await share.release();
}
```

- **Demotion is deliberately unchanged.** `workerDemotion()` keeps its
  `branch === "main"` rule, so push's workers stay darwinbg-demoted as they are today.
  Making demotion lane-driven (interactive ⇒ undemoted) is the consistent end-state
  and would let push's fleet run on P-cores, but it is a behavior change on a
  different axis than admission, and belongs with its own measurement. Flagged, not
  folded in.

- **Observability:** when the share is contended (`share.slots < max`, or the wait
  exceeds a `WAIT_NOTE_MS` threshold), write one line to stderr:
  `type-check: 3/8 worker slots in the background lane (waited 12.4s)`. Checks run
  under `Promise.all` (`checks/core/runner.ts:74`), so this must be a plain stderr
  line, not a blocking log or a progress bar. Without it a reduced share reads as an
  unexplained slowdown.

  > Corrected during implementation: the plan originally said `waitMs > 0`. That is
  > wrong — `onWait` also times the in-process fast-path sweep (~0.25 ms on a fully
  > idle pool), so `> 0` fires on every single run. A threshold is required.

### Why not blocking flock, like the CLI's `withHostSlot`?

`plugins/framework/plugins/cli/bin/host-semaphore.ts` blocks the event loop with a
synchronous `flock(LOCK_EX)` — safe there because nothing else is in flight at that
instant. Inside `type-check` it is not: `runChecks` runs every check under
`Promise.all` (`runner.ts:74`), and `build.ts` runs the vite build concurrently in the
same process, draining its stdout. Freezing the loop would stall those pipes. Hence
the broker.

### Deadlock check

An agent build holds a build-pool slot, then waits for background worker slots. A push
holds the single push slot, then waits for interactive worker slots. Worker slots are
only ever held by processes that are *running workers* — never by a process waiting for
a build-pool or push slot. No worker-slot holder ever waits for the push slot. No
cycle; every holder makes progress and releases.

Within the interactive lane, a `main` build and a `push` can contend for the same `B`
slots. Both request `min = 1`, so both make progress; the loser waits at most one
worker's duration. This needs a concurrent `build --allow-main`, so it is rare.

## Files

| File | Change |
| --- | --- |
| `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts` | Add `acquireShare` + `HostShare`; reimplement `run` on top of it |
| `plugins/packages/plugins/host-semaphore/server/index.ts` | Export `HostShare` type |
| `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.test.ts` | Add `acquireShare` tests (below) |
| `plugins/packages/plugins/host-semaphore/CLAUDE.md` | Document the share API |
| `plugins/framework/plugins/cli/bin/commands/{build,check,push}.ts` | Set `SINGULARITY_LANE` from the origin each already knows |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts` | `hostWorkerBudget()`, lane-keyed pool, share around `mapConcurrent` |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/CLAUDE.md` | Document the two lanes + host budget |

Unchanged: `shared/worker.ts`, `checks/core/discover.ts`, the CLI build pool, and
`scripts/broker.ts` (its env contract already carries slot dir + size).

`./equin build` regenerates `docs/plugins-*.md` from the barrels, so the
`plugins-doc-in-sync` check covers the doc drift.

## Verification

1. **Unit** — `bun test plugins/packages/plugins/host-semaphore`. New cases:
   - `acquireShare(4)` on an idle size-4 pool returns `slots === 4`, no broker spawned;
   - with 3 of 4 slots held by another process, `acquireShare(4)` returns `slots === 1`;
   - with all 4 held, `acquireShare(4)` blocks, then returns once one frees (broker path);
   - two concurrent `acquireShare(4)` callers never hold more than 4 slots in total;
   - `release()` is idempotent and leaks no slot when the body throws.

   The 4 pre-existing `run` tests must pass **unmodified** — that is the regression
   gate on the `run`-on-`acquireShare` rewrite.

2. **Single build unchanged** — `./equin build` in this worktree on an
   otherwise-idle host. Expect 8 concurrent workers (share = `min(8, 9)` = 8) and a
   wall time within noise of today's.

3. **Concurrent builds bounded** — the real test. Run `./equin check` in 3–4
   worktrees at once, and while they run:
   ```bash
   pgrep -fl 'type-check/shared/worker.ts' | wc -l          # must never exceed 9
   ls ~/.singularity/type-check-worker-background-slots/     # slot-0 … slot-8
   pgrep -fl 'host-semaphore/scripts/broker.ts' | wc -l      # ≤ 1 per build
   ```
   Before the fix this reads ~24–32; after, ≤ 9. Sample `uptime` across the run and
   compare against the 50–63 baseline in the incident doc.

4. **Lanes are separate** — `./equin build --allow-main` on the main worktree
   while agent checks saturate the background lane. The main build must acquire from
   `type-check-worker-interactive-slots/` and must not wait on background workers.

5. **Push does not queue behind builds** — `./equin push` from a worktree while
   agent checks saturate the background lane. Its nested check must land in the
   interactive lane (this is the case a `branch === "main"` gate would have broken).

6. **Contention is legible** — confirm the stderr note lands in
   `~/.singularity/worktrees/<wt>/logs/…/check.log` for a build that got a reduced
   share.

## Found during verification: waiters commit to one slot

Contending against the live pool while a real check held 8 of 9 slots showed a waiter
blocked for 2.5+ minutes **while a free slot existed**:

```
A: slots=1 waited=5ms          # took the last free slot
B: (blocked, brokers=1)        # zero free slots -> broker
A: released                    # slot-8 is now FREE
B: still blocked after 2.5min  # broker was waiting on one of the 8 held slots
```

Cause: `broker.ts:56` blocks on a single pid-hashed slot, because `flock(LOCK_EX)`
can only wait on one open file description. A slot freeing elsewhere never wakes it.
The identical line is at `cli/bin/host-semaphore.ts:81`, so this predates this change.

**It does not violate the bound** — concurrency stays ≤ `B`; it costs utilization and
latency. It is more exposed here because a share can hold 8 of 9 slots for a whole
check. In the dominant case a holder releases its entire share at once, so a waiter
has an 8/9 chance of being woken; the stranding window is bounded by another holder's
check duration, which is roughly the throttle this change intends anyway.

Tracked as `task-1783635702105-q3ipa7`, filed as a prerequisite of the host-admission
unification task — the defect is a property of the shared mechanism, currently
duplicated in two implementations, so fixing it inside `acquireShare` would leave the
build pool exposed.

## Out of scope

- **Unifying the three flock implementations and the six unrelated pools.** Filed as
  its own task (`task-1783631270948-xpqrc3`): one mechanism is reimplemented in
  `cli/bin/host-semaphore.ts`, `packages/host-semaphore`, and `push.lock`, and the
  pools they define (`build`=4, `push`=1, `heavy-read`=4, `db-fork`=2,
  `worktree-mutate`=3, `layout-geometry`=1) are mutually unaware — nothing sums them,
  and an admitted slot-holder has no obligation to declare what it fans out into.
  This change adds a 7th and 8th pool; adding pools one incident at a time does not
  converge. Doing that surgery while fixing a live thrash bug mixes two risks.
- Making demotion lane-driven rather than branch-driven (see §3).
- Resizing the CLI build pool (`floor(cpus/4)`). Once workers are bounded, its job is
  bounding vite + `bun install`; retuning it is a separate measurement.
- Gating vite / `bun install` on the same budget.
- The DB-lane partitioning fix from the incident doc §4 — the downstream half of the
  same incident, tracked separately.
