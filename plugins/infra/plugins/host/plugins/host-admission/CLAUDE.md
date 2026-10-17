# host-admission

The one place a **host-wide** concurrency pool comes into existence. Every pool
that bounds work across the ~16 worktree backends sharing one box is declared
through `defineHostPool` here, so `createHostSemaphore`
(`packages/host-semaphore`) is imported by **this plugin only** — the
`host-pools-declared` check makes that the structural bar. A 7th pool cannot
appear one incident at a time, out of sight of the table every other pool and
the `host-budget` check read.

## What a pool is, and what `B` is (`core`)

`core/` is runtime-agnostic (pure `node:os`, no `bun:ffi`) so the pools, the
budget check, and — later — the CLI share ONE definition:

```
hostCpuCeiling() = os.cpus().length            // 18 on this box
hostRamCeiling() = os.totalmem() * 0.5         // 34.4 GB
PER_UNIT_BYTES   = 3.6e9                        // one type-check-class worker
```

**A host pool is a cardinality cap on a kind of work, and nothing else.** It
declares how many holders of its kind may run at once — one Chromium page
render, two DB forks, one push — and claims no CPU and reserves no memory. So an
entry in `HOST_POOLS` is `{ size }`; there is no cost to declare, and nothing a
pool says can move any other pool's capacity:

| pool | size | holder | what the cap bounds |
| --- | --- | --- | --- |
| `heavy-read` | `max(1, cpus/4)` = 4 | inherit | concurrent heavy git/fs reads across all backends |
| `worktree-mutate` | `max(2, cpus/6)` = 3 | inherit | concurrent worktree checkout mutations |
| `db-fork` | 2 | inherit | concurrent Postgres template forks |
| `browser-fetch` | 2 | inherit | concurrent headless-Chromium page fetches |
| `layout-geometry` | 1 | inherit | the geometry suite's Vite build + Chromium launch |
| `push` | 1 | foreground | the global push mutex |
| `e2e` | 2 | inherit | concurrent e2e script runs (`./singularity run …/e2e/x.ts`) — their own cap, so a 20 s screenshot never queues in `cpu`'s background window behind 40-min builds |
| `type-check-worker` | 2 | foreground | live repo-program type-check workers (7–14 GB each); laned by its owner (`type-check/server`): background may hold 1 |

The `holder` column is declared at each `defineHostPool` call (see *A scarce
slot's holder runs in the foreground* below), not in `HOST_POOLS`. The
`inherit` pools are decided from their measured waits (op log `waits[]` by
kind).

`HOST_POOLS` is the single source both the pools and the `host-budget` check
read, so their numbers can never drift. **Every key stays listed** even for a
pool whose only other reader is elsewhere:
[`data-dirs/index.ts`](./data-dirs/index.ts) derives the `locks/<id>`
declarations from its keys, so dropping one would un-declare that lock dir and
make `paths:no-undeclared-data-dirs` report the on-disk directory as an orphan.

Sizes are pure functions of stable host facts and are never env-overridable: a
size names the flock slot-file set (`slot-0 … slot-(N-1)`), so it must be
identical in every backend — a process sized to 4 sweeps only `slot-0..3` and is
blind to one holding `slot-7`, silently exceeding the bound.

### `B` — the elastic fleet

The only thing actually *budgeted* is the type-check/vite fleet, because it is
the only holder that both fills the box and can shrink. Its size `B` is a pure
function of host facts and one measured constant. **Nothing from the pool table
enters it**, so adding, removing or resizing a pool cannot move it:

```
B = max(1, min(hostCpuCeiling(), floor(hostRamCeiling() / PER_UNIT_BYTES)))
  = max(1, min(18, floor(34.4e9 / 3.6e9))) = min(18, 9) = 9
reservedInteractive = max(1, floor(B / 3)) = 3
backgroundLimit     = max(1, B − reservedInteractive) = 6
```

`rawFleetCeiling()` is the pre-floor value. It drops below 1 only when the host
has less than one quantum of usable RAM — a 2-core / 4 GiB VPS gives `0` — and
that reads "this box is smaller than one worker", not "the pools overcommitted
the ceiling". The `max(1, …)` floor and the lane collapse below it handle that
host; nothing a pool declares can produce it.

### Why a pool no longer costs CPU, and why the quantum moved

Until 2026-09-09 each pool declared a `PoolCost { cpu, ramBytes? }`, and
`reservedCpuCost()` subtracted `Σ size × cost.cpu` = 8.5 cores from the ceiling
before `B` was taken. Two things were wrong with that.

**The same core could be reserved twice, and no declaration could say so.** The
`layout-geometry` check runs `ctx.grant.run(() => browserPool.run(…))` — it
spends a unit of `B` *and* its pool's `cpu: 1` had already been subtracted from
the ceiling that produced `B`. The push mutex avoided this with `cost: { cpu: 0 }`,
so the correct pattern existed in the table, but a bare number cannot say which
of the two regimes it is in. With `PoolCost` deleted the double count has no
spelling at all: a pool bounds concurrency, `grant.run` is the one and only CPU
charge. Rung 1 — inexpressible, not checked.

**And the reservation was buying almost nothing.** Across every recorded
`slow_op`, `worktree-mutate` has waited twice ever, `db-fork` once,
`browser-fetch` and `layout-geometry` never. A representative `heavy-read` hold
is 75 ms, while a build holds its grant across its whole heavy section (p50
137 s, max 20 min). The box was permanently withholding 8.5 cores for the
millisecond work and rationing the minute work.

**But that reservation was, accidentally, doing memory admission's job.** `B`
was 9 because `floor(18 − 8.5)` won the `min()`; the RAM term alone said 12.
Deleting the reservation without re-basing the quantum would have raised the
concurrent-worker ceiling by 33 % on the axis that is actually binding — this
box sampled at 58.6 GB used of 65.5 (p50), with live compressor thrash. So
`PER_UNIT_BYTES` moved `2.7e9 → 3.6e9`, chosen to hold `B` at exactly 9. The
structural change therefore lands throughput- and memory-neutral: its effect is
attributable, and the open sizing question (a mean quantum vs the 5.3 GB cold
tail, which would give `B = 6`) stays a separate, measured decision rather than
a re-tuning smuggled in here.

`3.6e9` is **not a fresh measurement.** It is the value that lands the
memory-only formula on the `B` the old formula produced. `B = 9` requires
`Q ∈ (3.436e9, 3.818e9]`, and `3.6e9` sits near that interval's centre (0.54
above the `B = 9` boundary, 0.46 below `B = 10`), so a small change in host
memory or in the ceiling fraction cannot flip it. `3.8e9` also yields 9 but sits
**0.04** from flipping to 8 — do not use it. Whoever re-tunes this next must
recompute that interval rather than assume the margin is still there, and should
know that nothing subtracts from the ceiling any more: a change to the constant
moves the fleet ceiling directly and visibly. See the constant's own comment in
[`core/internal/budget.ts`](./core/internal/budget.ts) and
[`research/2026-09-09-global-host-pools-stop-reserving-cpu.md`](../../../../../../research/2026-09-09-global-host-pools-stop-reserving-cpu.md).

**Resizing is a live operation.** A pool's `size` names its flock slot *files*,
so editing a size in this table — or moving `PER_UNIT_BYTES`, which resizes the
`cpu` pool through `B` — changes a slot set every checkout on the box shares.
That is safe: an out-of-date checkout adopts the live identity and the new one
lands once the pool is idle (see `packages/host-semaphore`). Expect a transition
window where `liveSize()` ≠ the declared size. The 2026-09-09 change moved no
size and did not move `B`, so no slot set moved and it needed no drain window —
that warning is for the next change, not for this one.

## `defineHostPool` (`server`)

`defineHostPool({ id, size, holder, laned? })` wraps `createHostSemaphore` and
returns a `HostPool` (`run` / `acquireShare` / `depth` / `slots`). It is a **registry**:
one handle per id per process, so a repeat call for the same id — an occupant
contending for the same physical slots — returns the one handle rather than
building a second semaphore or double-registering the gauge. A mismatching spec
throws.

On first definition it **auto-registers** the pool's `<id>-acquire` gate gauge
(same vocabulary as the `chargeWait` layer names) whose `active` is **true
host-wide occupancy** — probed from the flock files across every backend, not
this process's local held count. The ported pools deleted their hand-rolled
`heldByThisProcess` counter and the false "host-wide occupancy is not cheaply
readable" comment along with it.

### A scarce slot's holder runs in the foreground

**Invariant:** a process holding a slot of a pool others queue on does its held
work in the foreground. Every waiter waits out the whole hold, and an agent
session is darwinbg as a whole, so a demoted holder on the E-cores stretches
every wait behind it — the push lock's normalize took 109 s instead of 13 s,
and the background `type-check-worker` slot (a single-server queue) reached a
median 13.5 min wait for a median 153 CPU-s job.

So `holder: "foreground" | "inherit"` is **required** on every spec — tsc makes
every pool decide — and `pool.run(fn)` hands `fn` the held `Slot`, whose
`spawn(argv, opts)` (`spawnCaptured`) is the spawn the holder's work goes
through:

- `foreground` → a `ForegroundSlot`: `spawn` takes no `tier` and starts the
  child at `tier: "foreground"` — `spawn-priority`'s `spawnInForeground`, a
  lift of this process around the synchronous fork alone, so the child (and
  its subtree) leaves darwinbg while nothing else this process runs is lifted.
  A holder of a scarce slot has no spelling for spawning its work demoted.
- `inherit` → an `InheritSlot`: `spawnCaptured` as the caller asks, the tier
  left to the spawner — unchanged behaviour. The elastic `cpu` pool is
  `inherit` by construction: it IS the fleet, and lifting it would lift every
  agent (its interactive lane is lifted through `withHostGrant` instead).

A repeat `defineHostPool` for an id must state the same holder (it throws
otherwise). See `research/2026-10-16-global-scarce-slot-holders-run-foreground.md`.

### Where the slot files live

`createHostSemaphore` no longer derives its own directory — it is handed one, and
this plugin supplies it. The seven `locks/<id>` directories are declared in
[`data-dirs/index.ts`](./data-dirs/index.ts), **derived from `HOST_POOLS`**
(plus `cpu`, which is the elastic fleet and so is absent from the table by
construction). There is no second list of pool ids to keep in sync: a pool that is
in the table gets a lock directory, and a pool that is not gets a loud throw from
`defineHostPool` instead of an unowned directory nobody can enumerate.

`pool.slots` exposes that directory, for a consumer that must name one specific
slot file. None does today.

A `laned` pool MUST also pass an explicit `backgroundLimit` (the `background`
lane's slot window); `defineHostPool` throws otherwise, since silently falling
back to `backgroundLimit === size` would void the reserved floor the flag
promises. Two pools are laned: `cpu` and `type-check-worker`.

## The grant (`server`)

Admission returns **tokens**, not permission. A build/check/push acquires ONE
host share and subdivides it across everything it fans out into — nothing it
spawns re-acquires host-wide:

```ts
withHostGrant({ lane, max }, (grant) => { … })   // acquire, run, release
inheritedGrant(): Grant | undefined              // the parent's grant, via env
```

`withHostGrant` calls the laned `cpu` pool's `acquireShare(max, { lane })`, wraps
the returned `slots` in an in-process `createSemaphore(slots)`
(`packages/semaphore`), and hands the caller a `Grant`:

- `grant.units` — slots actually held (always `>= 1`, so a 1-unit grant merely
  serializes the holder's children — no starvation branch, no `min > 1` acquire
  that would livelock two builds each holding one slot).
- `grant.run(fn)` — spend one unit through the in-process semaphore. Every heavy
  child (a type-check worker, tsc, vite, the Chromium suite) goes through it.
  `grant.run(fn, { units })` spends more than one — see *Weighted spend* below.
- `grant.lane` — the lane it was admitted in. Children read lane-shaped
  decisions off it (the type-check worker's slot window), never off the
  branch.
- `grant.env()` — `{ SINGULARITY_HOST_GRANT, SINGULARITY_LANE }`, inherited by a
  subprocess child so its `inheritedGrant()` rebuilds the SAME budget and spends
  those units — acquiring NOTHING host-wide, because the parent holds the slots
  and the child is their only spender. This is what deletes the old
  `SINGULARITY_HOST_SLOT_HELD` / `kind: "exempt"` double-acquire dodge.

### An interactive grant runs its holder in the foreground

While `fn` runs under an `interactive` grant, `withHostGrant` takes the process
out of macOS darwinbg (`spawn-priority`'s `withForegroundPriority`) and puts it
back afterwards, so every child spawned meanwhile starts in the foreground. An
agent session is darwinbg as a whole, so before this a push's lane bought it
slots but not cores: its lock-holding type-check ran on the E-cores beside the
fleet it was meant to outrank. Self-promotion is the only form that works from
an agent session (`taskpolicy -B -p` from there is a silent no-op). Safe
because the interactive lane is bounded: one push at a time, the reserved floor.

### Weighted spend

A unit is `PER_UNIT_BYTES` of resident memory, so a child that reliably peaks at
several quanta must occupy several units — otherwise `B × PER_UNIT_BYTES` models a
fleet that cannot exist. `grant.run(fn, { units })` occupies that many, atomically
(`packages/semaphore` weights), and **clamps to `min(units, grant.units)`**: the
grant is the ceiling, so a 1-unit inherited grant runs a 2-unit request at weight
1 rather than waiting for capacity it will never be given — the same rule as "a
reduced grant just runs the fleet at lower concurrency". Declaring more units than
the grant holds is therefore legal and reads "as heavy as this grant can express".

The weight is declared **where the cost is measured**, never here: `type-check/core`
computes `ceil(TYPE_CHECK_WORKER_PEAK_BYTES / PER_UNIT_BYTES)` from its own
transcript mean, so re-tuning the quantum reflows the weight and nothing in this
plugin names a consumer.

The obligation reaches checks through `CheckContext { grant }`
(`framework/tooling/core`): the check runner passes the invoker's grant to every
`check.run(ctx)`, and the two heavy checks (`type-check`, `layout-geometry`)
spend it per child instead of acquiring again.

## The push mutex (`server`)

`pushPool = defineHostPool({ id: "push", size: 1, holder: "foreground" })` is the global push
serialization, folded onto the primitive: `size: 1` says at most one push runs
host-wide, and that is all it says. The push takes an interactive CPU grant
separately, as the first thing inside the mutex, and holds it for the whole
critical section (rebase, install, normalize, checks, merge) — the pool bounds
how many pushes there are, the grant pays for their work and, being
interactive, runs all of it in the foreground: every queued push waits on the
holder for its whole hold, not only its checks.

Its single slot file IS the push mutex. Nothing outside the pool reads it: who
holds the mutex and who queues on it is the op log's answer (a push's
`push-mutex` wait and its `granted`), which is what the op-status banner renders.
The old holder file and its flock probe (`pushLockHeld`) are gone.

## `hostOccupancy()`

`hostOccupancy()` probes every registered pool's slots and reports
`{ id, held, size }` per pool. Probing is a non-blocking
`flock(LOCK_EX|LOCK_NB)` that releases immediately, which detects a holder even on a separate fd in the same process
(flock attaches to the open file description, not the process).

Probes run **serially** — across pools and within each pool — because probing a
*free* slot momentarily holds it: a parallel probe of a whole pool could make a
concurrent acquirer's sweep see zero free slots and needlessly fan out. Serial
bounds that transient hold to one slot at a time. Never call it from an acquire
path; it is for the health-monitor tick and a Debug row.

See `research/2026-07-10-global-host-admission-unified-budget.md`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Host-admission registry: one place a host-wide concurrency pool comes into existence, wrapping createHostSemaphore with a summed CPU/RAM ceiling and true host occupancy.
- Server:
  - Uses:
    - `packages/host-semaphore.AcquireHooks`
    - `packages/host-semaphore.createHostSemaphore`
    - `packages/host-semaphore.HostShare`
    - `packages/spawn-priority.withForegroundPriority`
  - Exports (types):
    - `ForegroundSlot`
    - `HostPool`
    - `HostPoolSpec`
    - `InheritSlot`
    - `PoolHolder`
    - `PoolOccupancy`
    - `RepoPushLock`
    - `Slot`
  - Exports (values):
    - `cpuPool`
    - `defineHostPool`
    - `e2ePool`
    - `hostOccupancy`
    - `inheritedGrant`
    - `pushPool`
    - `repoPushLock`
    - `withE2eGrant`
    - `withHostGrant`
- Cross-plugin:
  - Imported by:
    - `database/admin`
    - `debug/profiling/boot-bench`
    - `framework/tooling/checks/type-check`
    - `infra/host/host-read-pool`
    - `infra/jobs/supervised-job`
    - `infra/safe-fetch/browser-fetch`
    - `infra/worktree`
- Exemptions:
  - Exempts itself from: `host-pools-declared` — `server` (sanctioned)
- Core:
  - Exports (types):
    - `CpuBudget`
    - `Grant`
    - `GrantHooks`
    - `HostPoolEntry`
    - `Lane`
  - Exports (values):
    - `cpuBudget`
    - `HOST_GRANT_ENV`
    - `HOST_LANE_ENV`
    - `HOST_POOLS`
    - `hostCpuCeiling`
    - `hostRamCeiling`
    - `PER_UNIT_BYTES`
    - `rawFleetCeiling`

<!-- AUTOGENERATED:END -->
