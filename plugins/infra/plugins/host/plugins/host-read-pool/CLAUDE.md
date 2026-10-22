# host-read-pool

One shared, **host-wide** budget for CPU/IO-heavy git-subprocess and filesystem
read operations. `withHeavyReadSlot(fn)` admits at most a small number of heavy
reads at once **across all worktree servers on the box** — not per-worktree — so
no cross-worktree storm (a `main` ref advance fanning `commits-graph` out to ~16
worktrees, a burst of review / code-explorer navigations) can saturate every
core and starve cheap interactive queries (and the shared embedded Postgres).

It is a thin composition over two existing pieces:

- the host pool declared through `defineHostPool`
  (`@plugins/infra/plugins/host/plugins/host-admission/server`) — the registry that owns the
  cross-process `createHostSemaphore` flock slot-broker and auto-registers the
  `heavy-read-acquire` occupancy gauge (with true host-wide occupancy);
- the `runtime-profiler` — each acquire **charges** its lock-wait to the
  enclosing entry (loader/http) via `chargeWait("heavy-read-acquire", ms)`, so a
  heavy git/fs loader's span reads as wait-vs-work directly (e.g. edited-files
  4032ms = lock 3500 / git diff 532) and a saturated gate stays attributed to the
  resource that waited in `get_runtime_profile` / the durable slow-ops store,
  rather than hiding queue-wait in a label-shared bucket. Context-less callers
  (no active entry) fall back to a standalone `db [heavy-read-acquire]` span
  inside `chargeWait`. See
  research/2026-06-19-global-wait-attribution-instrumentation.md.

The pool *instance* (fixed name `heavy-read` + size) lives here rather than in
the bare primitive because its name/size and the wait charging are policy, not
mechanism.

**Size:** `floor(cpus/4)`, with **no env override**, declared in
`host-admission/core`'s `HOST_POOLS` table (the single source the pool and the
`host-budget` check both read). It is a cardinality cap — how many heavy reads
may run at once — and claims no share of the host's CPU budget. The size names
the flock slot *files* (`slot-0 … slot-(N-1)`), so it must be identical in every
backend — a process sized to 4 sweeps only `slot-0..3` and is blind to one
holding `slot-7`, silently exceeding the bound. Keeping it a pure function of
`os.cpus()` is what prevents that. Conservative start; can rise toward
`floor(cpus/2)` if profiling shows the gate is the bottleneck while CPU is
unsaturated — by editing the constant, in one place.

**Two-tier gate (per-worktree fairness).** In front of the host-wide flock gate
sits a small **in-process per-worktree `createSemaphore`** (size
`max(1, ceil(host/2))`, env-overridable via
`SINGULARITY_HEAVY_READ_LOCAL_CONCURRENCY`, clamped to `1 ≤ local ≤ host`). It
wraps *outside* the host gate, so each backend can only ever present a bounded
slice of work to the shared flock queue — under a cross-worktree storm (a `main`
advance fanning `commits-graph` out to ~16 backends) no single worktree can
monopolize the host gate and starve the others; each must drain its own local
budget before queuing more. The host gate size is unchanged. The local
queue-wait is charged as a `heavy-read-local` span sitting beside the host-wide
`heavy-read-acquire` span in the profiler, so each tier's contention stays
separately attributable. See
research/2026-06-19-global-incremental-git-loaders.md (Stage 1).

**Cancellation.** `withHeavyReadSlot(fn, signal?)` takes an optional ambient
`AbortSignal` — a job handler passes its `ctx.signal`. Both tiers honour it, but
with different sharpness, and the difference is worth knowing rather than papering
over:

- The **host** tier honours it properly (`AcquireHooks.signal`): a pending flock
  acquire unwinds with `signal.reason`, and an abort while `fn` runs releases the
  host slot without waiting for `fn` to settle. That is the tier that matters —
  it is the one holding a resource every backend on the box shares.
- The **local** tier (`createSemaphore`) takes no signal, deliberately (its
  consumers elsewhere are request-scoped leases). So an abort landing while we are
  queued *locally* is not observed until the local gate grants; we then throw at
  the top of the body rather than going on to take a host slot for a caller that
  has been written off. The exposure is bounded by the local queue, which holds
  nothing host-wide.

The reentrant fast path checks the signal too, so a nested acquire cannot be the
one place a cancelled read still runs.

**Occupancy gauges.** Both tiers surface a `registerGateGauge` under their
`chargeWait` layer names (`heavy-read-local`, `heavy-read-acquire`) so the flight
recorder's gate snapshot joins occupancy to span waits. The local tier registers
its own gauge here; the host-wide `heavy-read-acquire` gauge is auto-registered by
`defineHostPool` and reports **true host-wide occupancy** — every backend's held
slots, probed from the flock files — retiring the old "not cheaply readable"
limitation (`host-admission`'s `hostOccupancy()` uses the same probe).

Gate at the **operation level** — one slot per logical job. The gate never lives
inside `runGit` (the canonical thin spawn stays ungated so cheap interactive git
is never serialized behind a 14s archive). See
`research/2026-06-16-global-host-wide-cpu-admission-flock-broker.md` (Changes
2–4).

**Reentrant.** An ambient `AsyncLocalStorage` flag marks the async context that
holds a slot; a nested `withHeavyReadSlot` inside it runs its body directly —
same logical job, no second acquisition. Neither tier's semaphore is reentrant on
its own, so without this a holder that acquired again parked on a gate only it
could free: with the local tier at 2 slots, two outer holders that each nest
deadlock the entire heavy-read path (lived 2026-07-10 — the warmup executor wraps
each warm-up in `withHeavyReadSlot` and the corpus-index refresh acquires again
per parsed file; the moment a second corpus warmup existed, every live-state sub
froze). Pinned by `server/internal/pool.test.ts`. See
`research/perfs/2026-07-10-read-admit-wedge-stuck-git-loaders.md`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Shared host-wide budget for CPU/IO-heavy git/filesystem reads: withHeavyReadSlot admits at most a few heavy reads at once across all worktree servers.
- Server:
  - Uses: `infra/host/host-admission.defineHostPool`
  - Exports (values):
    - `heavyReadQueueDepth`
    - `heavyReadSlotCount`
    - `withHeavyReadSlot`
- Cross-plugin:
  - Imported by:
    - `apps/file-explorer/git`
    - `code-explorer`
    - `conversations/conversation-view/code`
    - `debug/health-monitor`
    - `debug/profiling/boot-bench`
    - `debug/worktree-cleanup`
    - `infra/corpus-index`
    - `infra/host-fs`
    - `infra/warmup`
    - `plugin-meta/plugin-tree`
    - `review/plugin-changes`
    - `tasks/attempt-work`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/pool.ts` (debt)

<!-- AUTOGENERATED:END -->
