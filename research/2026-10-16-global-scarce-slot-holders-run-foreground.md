# A scarce slot's holder runs in the foreground

Track: "Track: build and push speed" (wiki block-e5afc5b1-15f2-4614-a49a-c7b4e6fe1851).
Supersedes the measurement-only plan in 2026-10-15-global-push-queue-confirmation-and-worker-footprint.md.

## Context

Builds took 40–60 min on 2026-10-15 although their own work was small. Measured from
the op log, build-progress and the per-check logs:

- Build att-1792071205 (16:23Z, 59 min): host-grant wait 17 min, type-check-worker slot
  wait 38 min, worker work **40 CPU-s**.
- All type-check worker runs, 10-15 01:55Z → 10-16 00:33Z (deduplicated; each run is logged
  twice): 140 runs, 10.9 CPU-h working, **16.8 h waiting for a slot**.
- Background lane since the lint fix (14:50Z): 63 runs, worker CPU median 169 s, slot wait
  **median 7.6 min, p90 37 min**, max 47 min. Interactive lane: 0 wait.
- A darwinbg holder's hold ≈ its CPU time (hold/CPU median 0.97–1.27): the slow cores show up
  as inflated CPU-seconds, not idle wall. The speed-up factor is therefore unknown until the
  interleaved benchmark measures it.
- Hold-and-wait is **confirmed**: a build keeps its greedy CPU share (up to the 6-slot
  background window) while parked on the worker slot, overlapping 67 % of CPU-grant waiting time
  (2.8× chance). Step-0 scripts: scratchpad step0/.
- Pools other than push / type-check-worker record no wait history (in-memory profiler only).
  A spot sample shows ≈ 0 ms, so they stay `inherit` ("unmeasured, spot sample ≈ 0 ms").
- Builds since 00:00Z: 163, median 7 min, p90 51 min, 56 over 20 min.

Phase 1 capped type-check workers at 2 and gave the background lane (every agent build)
**one** slot. That slot is now a single-server queue, ~80 % busy, so waits run at several
times a job's length. A 40 s job waits behind 800 s ones. The slot's holder runs
darwinbg (`lane background, priority background (taskpolicy -b)`), on the E-cores, so
every hold is stretched while the whole fleet waits on it. It is the same bug the push
lock had (normalize 109 s → 13 s once its holder ran in the foreground), fixed there by
hand and still present everywhere else.

Second-order effect, to verify: a build keeps its CPU-pool share while parked in the
worker-slot queue, which plausibly explains its 17 min host-grant wait (other builds
queue for CPU slots held by idle waiters).

**What this changes in the model:** it shortens the hold time of the bottleneck lane (a
constant factor, ~2–3×). Because wait ∝ ρ/(1−ρ), that cuts the wait far more than the hold.
It does **not** change the scaling law (busy = agents × whole-repo work ÷ slots). The
structural fix is rung 2, filed separately: per-plugin units checked against contracts.

## Design

**Invariant:** a process that holds a slot of a cardinality pool (a bottleneck others
queue on) does its held work in the foreground. The elastic CPU pool is excluded: it IS
the fleet, and lifting it would lift every agent.

1. **Spawn-scoped lift in spawn-priority** (`packages/plugins/spawn-priority/server`):
   `spawnInForeground(spawn)` runs a **synchronous** spawn call between `setDarwinBg(false)`
   and `setDarwinBg(true)`. darwinbg is inherited at spawn, so the child starts in the
   foreground and stays there, while the parent is back in darwinbg before any other
   callback runs. Self-promotion is the only form that works (the module doc records
   that `taskpolicy -B -p` silently fails). Why not `withForegroundPriority`: it lifts the
   whole process for the body, and the check runner runs many checks concurrently in one
   process, so the lift would leak to every one of them for 15 min.
2. **Pool spec states its holder tier** (`host-admission/server/internal/pool.ts`):
   `HostPoolSpec.holder: "foreground" | "inherit"` is required, so tsc makes every pool
   decide. `HostPool.run(fn)` passes `fn` a `Slot` whose `spawn(argv, opts)` is the only
   spawn the body is given. For a `foreground` pool it goes through `spawnInForeground`
   and never through `backgroundArgv`. So "a scarce slot's holder spawned demoted" has no
   spelling at the call site.
   - `type-check-worker`: `foreground`.
   - `push`: `foreground` (it already lifts the whole process through its interactive
     grant; this states it in the table).
   - The others (`db-fork`, `browser-fetch`, `layout-geometry`, `heavy-read`,
     `worktree-mutate`): decided from their measured wait (op log `waits[]` by kind,
     last 7 days) in step 0. A pool nobody waits on stays `inherit`, with that reason in
     the table.
3. **Type-check worker uses it**: `spawn-worker.ts` drops `background: grant.lane ===
   "background"` and spawns through the slot. The lane still decides *which* slot (the
   background window stays 1, so foreground worker concurrency ≤ 2 by construction), not
   the tier.
4. **Logging**: the worker line says `priority foreground (slot holder)`, and the cost
   line adds the worker's wall time beside its CPU, so hold time is readable directly.
5. **Docs**: spawn-priority's caller contract and host-admission's pool doc name the
   invariant. The darwinbg comment in `worker-pool.ts` is updated.

Out of scope (noted on the track page): lending the idle interactive slot to the
background lane; releasing the CPU share while parked on another pool (hold-and-wait),
measured in step 0 and filed if confirmed.

## Steps

0. Measure the before, from logs only:
   - per-pool wait distribution (op log `waits[]`, 7 days)
   - background worker slot wait and hold (cost lines + file mtimes)
   - build wall p50/p90
   - whether host-grant waits coincide with holders parked on the worker slot.
1. Implement 1–5, with tests:
   - spawn-priority: a spawned child reports `readDarwinBackground()` = foreground, and the
     parent is darwinbg again right after;
   - host-admission: a foreground pool's slot spawn is not prefixed with taskpolicy.
2. `./singularity build`, then the benchmark below.
3. Track page: before/after table, overview item.

## Benchmark (before/after on the page)

- **Micro, same tree, real fleet load, interleaved 3+3:**
  - one background-lane worker run as darwinbg (old) vs slot-foreground (new), on the
    warm program plus one lint group;
  - record wall, CPU-s and the host load;
  - main's latency probed throughout (`/api/search` every 250 ms, p50/p95, as for normalize).
- **Fleet, after landing:** background slot wait median/p90 and build wall p50/p90 over the
  next busy window, against the step-0 numbers. Expected: hold 2–3× shorter, slot wait
  median 13.5 min → ~1–3 min, p90 38 → ~5–10 min. The fleet number belongs to the next
  task if the window hasn't happened before this one ends.

**Stop rule:** if main's p95 latency degrades by more than 20 % during foreground worker
runs, the foreground tier is wrong for workers. Record it, keep the worker pool at `inherit`,
and report it. Don't reach for `-c utility`: spawn-priority measured that it protects
nothing.

## Verification

- `./singularity test plugins/packages/plugins/spawn-priority plugins/infra/plugins/host/plugins/host-admission`
- `./singularity check` (pool table changes go through `host-pools-declared` / `host-budget`)
- In a background build: the worker line shows the foreground tier, and `ps -o pid,pri` /
  a self-read in the worker confirms it is out of darwinbg.
