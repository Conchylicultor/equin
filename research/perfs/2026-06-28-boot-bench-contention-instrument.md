# Make boot-bench a trustworthy contention/waiting instrument

**Date:** 2026-06-28
**Category:** perfs
**Plugin:** `plugins/debug/plugins/profiling/plugins/boot-bench/`
**Companion:** [`research/perfs/archive/2026-06-28-boot-and-git-loader-slowness-assessment.md`](./archive/2026-06-28-boot-and-git-loader-slowness-assessment.md)

## Context

The 2026-06-28 assessment found the dominant cost of slow boot/git loaders is **contention and waiting**, not per-op work: `commits-graph`'s 4.89s avg is only ~126ms real work (the rest is heavy-read-slot wait), and a 0.12ms indexed query is *recorded* at 1.2s because the event loop is jammed. The new `boot-bench` harness (`benchmark_boot` MCP tool + `POST /api/debug/boot-bench/run`) measures the four headline metrics, but as built it **reports per-op work and hides the wait/queueing signal** — so it would point a fix at the wrong layer. Four concrete gaps:

1. **Wait-vs-work split discarded.** Each runtime-profiler loader aggregate carries `waits?: Record<layer, ms>` (`loader-acquire`, `heavy-read-acquire`, `heavy-read-local`) plus `totalMs`/`count`; `workMs = (totalMs − Σwaits)/count`. `handle-run.ts:82` trims to `{label, avgMs, maxMs, count}`, so a 96%-slot-wait loader is indistinguishable from a 96%-real-work one. (The runtime MCP tool already computes `workMs` with a duplicated local `sumWaits` — `runtime/.../mcp-tools.ts:~109`.) Worse: `aggregate.ts` drops `topLoaders` entirely — it never even reaches the report.
2. **No concurrent load.** A single isolated, sequential run on an idle worktree does not reproduce the head-of-line blocking that is the real problem (a storm of concurrent subscribers serializing on the host-wide `withHeavyReadSlot` gate). This worktree measured boot-snapshot ~400ms / edited-files ~382ms vs the assessment's 7.77s / 7.71s on loaded main — ~20× rosier.
3. **No db-kind capture.** Assessment task 5 ("confirm event-loop starvation is gone") needs to watch the phantom slow db-query recordings clear; the harness only captures loader-kind top-N.
4. **Bloat constraint implicit.** The `live_state_snapshot` bloat metric (1.88s persisted read) only reproduces in **warm** mode against the actually-bloated DB (main, via the `worktree` param). Cold-clearing rows does not synthesize dead-tuple bloat, so a fresh worktree shows misleadingly low-ms reads.

**Outcome:** the harness surfaces the wait/work split for loaders *and* db ops, can deterministically manufacture host-wide gate contention on demand, exposes the persisted-read + table-bloat signal, and documents the warm-against-main constraint — so it becomes a trustworthy instrument for the contention root cause.

## Design decisions

- **Load generator = host-wide occupants** (user-selected). Occupy the *real* shared host gate by constructing a same-named host semaphore — `createHostSemaphore({ name: "heavy-read", size })`. Because the flock slot files are keyed by name (`~/.singularity/heavy-read-slots/slot-N.lock`), occupants compete for the identical physical slots the live `withHeavyReadSlot` pool uses, so they genuinely force the measured burst onto the broker wait path and reproduce the 16-worktree storm's `heavy-read-acquire` wait. Bounded + auto-released; momentarily contends with other live worktrees during the run (acceptable, realistic). **No CPU spin** — the backend is single-threaded; a spin would stop the measured burst's own JS and fabricate event-loop lag that gate contention alone never produces, making the gap-3 phantom-db signal fire unconditionally. Occupants are async slot-*holders* only.
- **Shared wait-split helper.** Extract `waitSplit(agg)` into `runtime-profiler/core` (single source of truth) and reuse it in both the runtime MCP tool and boot-bench, killing the duplication. Pure numeric, no rounding — callers format — so the runtime tool's wire shape stays byte-identical.
- **Capture all loader + db entries, not top-8.** A boot burst touches only a handful of labels; capturing the full (small) lists avoids ragged per-label sample counts when union-aggregating across iterations.
- **Keep `maxMs`** through aggregation — for gap 3 the phantom slow query is a tail max, not an average.
- **MCP/endpoint schema is internal-only** (debug); the MCP response is freeform `JSON.stringify`. Replacing `topLoaders` with the richer shape is safe. The MCP tool *description* is the real contract for the agent and must be rewritten.

## Implementation plan (ordered)

### 1. `runtime-profiler/core` — shared wait-split helper
- `plugins/infra/plugins/runtime-profiler/core/recorder.ts`: add
  ```ts
  export function waitSplit(agg: Aggregate): {
    avgMs: number; workMs: number; waitMs: number; waits: Record<string, number>;
  }
  ```
  `avgMs = totalMs/count`; per-call `waits[layer] = (agg.waits?.[layer] ?? 0)/count` (note `Aggregate.waits` is summed across records — recorder.ts:78-79); `waitMs = Σ waits`; `workMs = avgMs − waitMs`. Raw floats.
- `core/index.ts`: export `waitSplit`.

### 2. Runtime MCP tool — adopt the helper (no shape change)
- `plugins/debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts`: delete the local `sumWaits`; compute `avgMs`/`workMs` via `waitSplit(agg)`, keeping the existing `Math.round(...)` at the call site and still emitting `agg.waits` (summed map) unchanged. Confirm emitted keys are identical.

### 3. `host-read-pool` — expose the gate size
- `plugins/infra/plugins/host-read-pool/server/internal/pool.ts` + barrel: export `heavyReadSlotCount(): number` (returns `heavyReadSize()`), so boot-bench can default the occupant count to "exactly saturate the gate" without re-deriving `floor(cpus/4)`/env.

### 4. `boot-snapshot` — expose `persistedReadMs`
- `plugins/infra/plugins/boot-snapshot/server/internal/handle-boot-snapshot.ts`: add `persistedReadMs` (already computed, line ~26) to `assembleBootSnapshot`'s return type + object. `handleBootSnapshot` and the `GET /api/resources/boot-snapshot` wire are unaffected (`timings` is already not shipped; this sits beside it). Do **not** double-read via a separate `readPersistedSnapshots`.

### 5. Load generator (new file)
- `plugins/debug/plugins/profiling/plugins/boot-bench/server/internal/load-generator.ts`:
  - `startHostGateLoad(concurrency: number): Promise<{ stop(): Promise<void> }>`.
  - Build a private `createHostSemaphore({ name: "heavy-read", size: heavyReadSlotCount() })` (same name as the live pool → same flock slots).
  - Launch `concurrency` occupants; each does `sem.run(async () => { signalAcquired(); await untilStopped(); })` — acquire a slot **once and hold continuously** (no acquire/hold/release loop, so there are no release windows the measured burst could slip through). Wrap each occupant body in `runWithoutProfiling` so they hold real slots but emit no spans into the measured profile.
  - The returned promise resolves only after **all** occupants have acquired (barrier), so the caller knows the gate is saturated before opening the measurement window.
  - `stop()` resolves every `untilStopped` and awaits all `sem.run` bodies to settle (fds closed → slots released).

### 6. Snapshot-bloat query (new file)
- `plugins/debug/plugins/profiling/plugins/boot-bench/server/internal/snapshot-bloat.ts`: one read-only `db.execute` returning `{ tableBytes, deadTuples, liveTuples }` from `pg_stat_user_tables` (`relname = 'live_state_snapshot'`, `n_dead_tup`, `n_live_tup`) + `pg_total_relation_size('live_state_snapshot')`. Raw SQL on `db` (matches `fixtures.ts`).

### 7. `shared/endpoints.ts` — schema
- Replace `topLoaderSchema` with `profileEntrySchema = { label, count, avgMs, workMs, maxMs, waits: z.record(z.string(), z.number()).optional() }`.
- `runtimeProfile: { loaders: profileEntry[], db: profileEntry[] }`.
- `bootSnapshot`: add `persistedReadMs: z.number()`.
- `IterResult`: add optional `load: { concurrency: number; peakLocalWaitMs?: number }` (present only when `loadConcurrency > 0`; derived from the burst's own `heavy-read-acquire`/`heavy-read-local` wait — the host queue-depth gauge is the wrong tier to read here).
- `bootBenchRunResponseSchema`: add per-mode `snapshotBloat` (captured once per mode).
- Body: add `loadConcurrency: z.number().int().nonnegative().optional()` (default 0 = current isolated behavior).

### 8. `handle-run.ts`
- Capture `snap.persistedReadMs`.
- Replace the `topLoaders` block: map **all** `profile.aggregates.loader` and `profile.aggregates.db` through `waitSplit`, emit `{label, count, avgMs, workMs, maxMs, waits}` (round at the edge), sort by `avgMs` desc. Drop `TOP_LOADERS`.
- When `loadConcurrency > 0`: per iteration → (cold clear) → `start = await startHostGateLoad(concurrency)` → `resetEldProbe()/resetRuntimeProfile()` → burst → read probes/profile → `await start.stop()`. Occupants stay out of the measured profile via `runWithoutProfiling`.
- Capture `snapshotBloat` **once at the start of each mode set, before any cold delete** (the cold-clear DELETEs churn `live_state_snapshot` — the very table being measured), and thread it through.

### 9. `aggregate.ts`
- Add `bootSnapshotPersistedReadMs: Stat`.
- Add `loaders` / `db: Record<label, { avgMs: Stat; workMs: Stat; maxMs: Stat; waits: Record<layer, Stat> }>` via union-by-label (mirror `bootSnapshotPerKey`; union the per-layer wait keys too).
- Carry `snapshotBloat` + the `load` summary through `ModeAggregate` / `buildReport`.

### 10. boot-bench MCP tool + docs
- `boot-bench/server/internal/mcp-tools.ts`: add `loadConcurrency` to `inputSchema`, thread into `reqBody`. Rewrite the description to cover: the wait/work split, loader **and** db top-N, `persistedReadMs`, that **bloat only reproduces in warm mode against main** (`worktree: "singularity"`) and cold-clearing churns the table, and that `loadConcurrency` saturates the **host-wide** `heavy-read` gate (contends with other live worktrees during the run). Cross-reference `firstSubscribe.loaderMs` (end-to-end) vs `loaders[key].workMs` + waits (split).
- Update `boot-bench/CLAUDE.md` (new `Uses` entries: `host-read-pool`, `runtime-profiler/core.waitSplit`) and run `./equin build` to regenerate the autogen doc/registry blocks.

## Files to modify
- `plugins/infra/plugins/runtime-profiler/core/recorder.ts`, `core/index.ts` — `waitSplit`
- `plugins/debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts` — adopt helper
- `plugins/infra/plugins/host-read-pool/server/internal/pool.ts` + barrel — `heavyReadSlotCount`
- `plugins/infra/plugins/boot-snapshot/server/internal/handle-boot-snapshot.ts` — `persistedReadMs`
- `plugins/debug/plugins/profiling/plugins/boot-bench/shared/endpoints.ts` — schema
- `plugins/debug/plugins/profiling/plugins/boot-bench/server/internal/handle-run.ts` — capture + load wiring
- `plugins/debug/plugins/profiling/plugins/boot-bench/server/internal/aggregate.ts` — aggregation
- `plugins/debug/plugins/profiling/plugins/boot-bench/server/internal/mcp-tools.ts` — params + description
- **New:** `boot-bench/server/internal/load-generator.ts`, `boot-bench/server/internal/snapshot-bloat.ts`
- `boot-bench/CLAUDE.md` (+ regenerated docs/registry)

## Reused primitives
- `waitSplit` (new, `runtime-profiler/core`) — single source for avg/work/wait.
- `withHeavyReadSlot` / `heavyReadSlotCount` (`host-read-pool/server`), `createHostSemaphore({name:"heavy-read"})` (`packages/host-semaphore/server`) — host-wide gate occupancy.
- `runWithoutProfiling`, `getRuntimeProfile`, `resetRuntimeProfile`, `Aggregate` (`runtime-profiler/core`).
- `assembleBootSnapshot`, `bootCriticalKeys` (`boot-snapshot/server`); `clearPersistedSnapshots` (`live-state-snapshot/server`); `measureSubscribeCycle` (`server-core/core`); `db` (`database/server`).

## Verification
1. `./equin build` (regenerates migrations/docs; runs checks). Confirm `plugin-boundaries`, `type-check`, `plugins-doc-in-sync` pass.
2. `bun test plugins/debug/plugins/profiling/plugins/boot-bench/server/internal/aggregate.test.ts` — extend fixtures for the new shape (union-by-label loaders/db, per-layer wait Stats, `persistedReadMs`, `snapshotBloat`).
3. **Wait-split visible (gap 1+3):** run `benchmark_boot` against this worktree → confirm `runtimeProfile.loaders[edited-files]` shows `workMs` ≪ `avgMs` with a `heavy-read-*` wait, and `db` top-N is populated.
4. **Load generator (gap 2):** `benchmark_boot { loadConcurrency: <≥ slot count>, mode: "warm" }` → confirm the measured loaders' `heavy-read-acquire` wait (and ELD max) rise materially vs `loadConcurrency: 0`, proving the gate is saturated. Confirm occupants release after the run (`heavyReadQueueDepth()` returns to 0; no leaked slot files).
5. **Bloat constraint (gap 4):** `benchmark_boot { worktree: "singularity", mode: "warm" }` → `snapshotBloat.tableBytes`/`deadTuples` reflect main's bloat and `bootSnapshotPersistedReadMs` is high; the same run on a fresh worktree shows low bloat + low read — the report makes the difference explicit.
6. Confirm the runtime MCP tool (`get_runtime_profile`) output is unchanged after the `waitSplit` refactor (diff a before/after JSON).
