# Observability: frequency + delivery instrumentation, and dead-job GC

**Date:** 2026-06-19
**Category:** global (runtime-profiler, resource-runtime, server-core, host-semaphore, host-read-pool, jobs, events, debug/{queue,profiling,live-state-health,health-monitor})
**Successor to:** [`research/2026-06-19-global-wait-attribution-instrumentation.md`](./2026-06-19-global-wait-attribution-instrumentation.md). That chapter measured **wait** (per-entry `chargeWait`, `sub`/`push` origins, durable slow-ops). This chapter measures **frequency** and **delivery**, and reaps dead jobs. Mirror its style and reuse its primitives.

## Context

The profiler + slow_ops surfaces optimize for "slow single call" (`maxMs`) and are blind to the dimensions that caused the recent app-wide slowness incident: the cost of *frequency* (a cheap loader called 3000×/min) and of *delivery* (notify→UI lag). Diagnosing it required raw SQL because these signals don't exist. Separately, ~688 permanently-failed graphile jobs (`attempts >= max_attempts`, dating to Apr 24) sit in every worktree's queue forever with no GC — they must be reconciled/purged on boot and surfaced, not silently accumulated.

Two decisions taken with the user:
- **Dead jobs: archive-then-purge.** Copy dead rows into a durable, bounded `dead_jobs` table (inspectable in a Debug→Queue "Dead" tab), then delete from the graphile queue.
- **Loader granularity: key-level + per-pk counts.** Surface call-rate at resource-key level (`count/window`, already in the profiler) plus the existing per-`(key,pk)` version counters from `/api/resources/_debug`. No per-`(key,params)` loader labels — that explodes aggregate cardinality (one row per `conversationId`) for marginal value.

The architecture is already shaped for this: the profiler is a zero-dep isomorphic recorder injected into `resource-runtime/core` via optional hooks (`wrapLoad`, `wrapOrigin`, `reportError`, `debugOwners`) supplied by `server-core/core/resources.ts`; central-core omits them (identity passthrough). That same seam is the lever for D1–D3. `HostSemaphore.run(fn, onWait)` surfaces wait but holds no depth gauge (D4). The jobs stack derives `dead` from `attempts>=max_attempts` and has a `setInterval` recovery sweeper (`stuck-lock-sweeper.ts`) as the GC template but no dead-job GC (D6).

## Execution model — 3 parallel workstreams (one sub-agent each)

The six deliverables touch **disjoint plugin subtrees** → three Opus implementation agents run concurrently with no file collisions. **Each agent edits files only — no `./equin build`.** After all three land, run a **single** `./equin build` + `./equin check` (parallel builds would race on migration/registry/doc codegen). WS1 fixes the active incident, so prioritize it if serializing.

| WS | Deliverables | Owns (no other WS writes these) |
|----|--------------|----------------------------------|
| **WS1** Jobs/Queue incident | D5, D6 | `plugins/infra/plugins/jobs/**`, `plugins/infra/plugins/events/server/internal/trigger-contributions.ts` + events triggers list handler/core, `plugins/debug/plugins/queue/**` |
| **WS2** Live-state delivery/rate | D1, D2, D3 | `plugins/infra/plugins/runtime-profiler/core/recorder.ts`, `plugins/framework/plugins/resource-runtime/core/runtime.ts`, `plugins/framework/plugins/server-core/core/resources.ts`, `plugins/debug/plugins/profiling/plugins/runtime/**`, `plugins/debug/plugins/slow-ops/server/internal/install-slow-span.ts`, `plugins/debug/plugins/live-state-health/**` |
| **WS3** Heavy-read depth + backends | D4 | `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts`, `plugins/infra/plugins/host-read-pool/**`, `plugins/debug/plugins/health-monitor/**` |

No cross-WS file overlap. Only logical coupling: D5 reads D6's `dead_jobs` table (both in WS1).

---

## WS1 — Jobs/Queue incident (D5 + D6)

### D6: archive-then-purge dead graphile jobs

**`plugins/infra/plugins/jobs/server/internal/tables.ts`** (modify) — add a `dead_jobs` pgTable:
`id` (text PK = original graphile job id), `jobName` (text), `input` (jsonb), `attempts` (int), `maxAttempts` (int), `lastError` (text), `diedAt` (timestamp), `archivedAt` (timestamp, default now). Migration regenerates on `./equin build` — never run drizzle-kit manually.

**`plugins/infra/plugins/jobs/server/internal/dead-job-gc.ts`** (create):
- `reconcileDeadJobs()` — in one transaction: SELECT dead rows (`attempts >= max_attempts AND locked_at IS NULL` from `graphile_worker._private_jobs JOIN _private_tasks` where `identifier = JOB_TASK`, joining payload for `jobName`/`input`), INSERT into `dead_jobs` with `ON CONFLICT (id) DO NOTHING` (idempotent — safe on every boot/re-fork), DELETE the archived rows from `_private_jobs`. Then enforce the archive bound (delete `dead_jobs` older than a TTL, e.g. 30d, AND beyond a cap, e.g. newest 2000). Mirror the raw-SQL style of `sweepOnce` in `stuck-lock-sweeper.ts`. After archiving, call `deadJobsResource.notify()` and `jobsListResource.notify()`.
- `deadJobGcJob = defineJob({ name: "jobs.dead-gc", dedup: "singleton", schedule: { cron: "<hourly>", perWorktree: true }, run: () => reconcileDeadJobs() })`. **`perWorktree: true` is required** — each worktree has its own DB fork with its own `graphile_worker` tables, so dead rows accumulate per-DB and must be GC'd per-DB (the inverse of the usual main-only default; justify in a comment). A dead-job GC is **not** recovery infra (unlike the stuck-lock sweeper), so a scheduled `defineJob` is correct and satisfies the no-polling rule.

**`plugins/infra/plugins/jobs/server/index.ts`** (modify):
- Add `deadJobGcJob` to `register: [...]`.
- In `onReady` (after `startWorker()`/`startStuckLockSweeper()`): `void reconcileDeadJobs().catch(err => console.warn(...))` for an immediate purge of the ~688 backlog on this boot (idiomatic boot reconcile; template = `sweepStaleTriggers()` in events `onReady`). Runs after the `onReadyBlocking` migration barrier, so the table exists.

**`plugins/infra/plugins/jobs/core/{endpoints,resources}.ts`** + **`server/internal/resources.ts`** (modify) — `DeadJobRowSchema`, `DeadJobsPayloadSchema`, `deadJobsResource` (invalidate, no poll — notified by the GC), `loadDeadJobsList()` selecting from `dead_jobs` ordered by `archivedAt desc`, `listDeadJobs = defineEndpoint({ route: "GET /api/jobs/dead", ... })`.

### D5: dead-letter + dangling-trigger views in Debug→Queue

**Dead-letter view** — **`plugins/debug/plugins/queue/web/components/queue-view.tsx`** (modify): add a "Dead" tab reading `deadJobsResource`, columns jobName / attempts / lastError (first line) / diedAt, drawer reusing the existing job-drawer shape, with a Retry action that re-enqueues by name.

**Dangling-trigger view (surface-then-sweep)** — a dangling trigger is a row whose `jobName ∉ jobRegistry`. Currently `sweepStaleTriggers()` silently deletes them at boot.
- **`plugins/infra/plugins/events/server/internal/trigger-contributions.ts`** (modify): split into `findStaleTriggers()` (returns dangling rows) + delete. Boot path calls `findStaleTriggers()` first, reports the count via `reportServerError` (fail-loud surfacing), then deletes.
- Events triggers-list handler + `core` (modify): add a computed `dangling: boolean` to each `TriggerRow` by cross-referencing `getAllRegisteredJobNames()` (no new table — dangling rows are transient and would race the sweeper).
- **`queue-view.tsx`** (modify): render a red "dangling" badge in `TriggersTabInner` + a filter for dangling-only. The existing emissions `matchedCount===0` red badge is the complementary "delivery failed" signal — document it.

---

## WS2 — Live-state delivery / rate / flush (D1 + D2 + D3)

### D1 + D3: delivery latency + flush cycle time + head-of-line attribution

Design: **one new `flush` SpanKind** + **delivery latency as a leaf under the existing `push` origin** (no new `notify` kind — keeps the kind set minimal, attributes latency to the resource).

**`plugins/framework/plugins/resource-runtime/core/runtime.ts`** (modify):
- `interface PendingNotify`: add `enqueuedAt: number`. In `mergePending`, set `enqueuedAt: performance.now()` **only on the first merge** (the `!existing` branch) — never overwrite on re-merge. **Correctness crux:** for debounced/coalesced resources the latency window must open at the FIRST notify, not the last; cascade re-merges and debounce re-arms both route through `mergePending`, so they inherit first-merge timing for free. The resulting latency (one microtask later for immediate resources, up to `debounceMs` for debounced) *is* the "UI is stale" signal we want measured.
- Add two optional hooks to `ResourceRuntimeOptions` (the established injection pattern): `wrapFlush?: (fn: () => Promise<void>) => Promise<void>` and `onDelivered?: (key: string, latencyMs: number, subscribers: number) => void`.
- Wrap the whole `flushNotifies` body via `opts.wrapFlush?.(...) ?? bareFlush()`. After the per-pending `sendJson` send loop, call `opts.onDelivered?.(entry.key, performance.now() - pending.enqueuedAt, subs.length)`. Because each per-resource value load already runs inside `opts.wrapOrigin("push", key, ...)` and that now executes *inside* the `flush` entry, the `push` loader spans nest under `flush` automatically → `getRuntimeProfile().aggregates.flush[*].byParent` is the head-of-line attribution with zero extra plumbing.

**`plugins/framework/plugins/server-core/core/resources.ts`** (modify) — in `createResourceRuntime({...})`:
- `wrapFlush: (fn) => recordEntrySpan("flush", "flushNotifies", fn)`
- `onDelivered: (key, latencyMs) => recordSpan("push", \`deliver:${key}\`, latencyMs)` (import `recordSpan`).
central-core omits both → identity/no-op.

**SpanKind ripple for `"flush"`** (mechanical checklist — same files the prior chapter touched for `sub`/`push`):
1. `runtime-profiler/core/recorder.ts`: `SpanKind` union, `KINDS`, `aggregates` record, `slowest` record.
2. `debug/plugins/profiling/plugins/runtime/shared/endpoints.ts`: the `z.enum([...])` kind schema(s).
3. `debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts`: `KINDS`, kind enum param, result shape.
4. `debug/plugins/profiling/plugins/runtime/web/components/runtime-section.tsx`: `RuntimeKind`, enum options, `tag(...)`.
5. `debug/plugins/slow-ops/server/internal/install-slow-span.ts` (`thresholdFor`): route `flush` to `loaderMs` (no new config field).
`./equin check` (type-check) catches record-shape misses; the `z.enum`/UI `tag()` misses are runtime — verify by eye.

### D2: loader rate + fan-out + subscriber count

Enrich `/api/resources/_debug` (the server already iterates the full registry there) and add a server-fed section to the **client-only** live-state-health pane.

**`runtime.ts` `handleResourcesDebug`** (modify) — the per-resource object already has `subscribers` + `versions`. Add:
- `subCounts: Object.fromEntries(entry.subCounts)` — authoritative per-pk server subscriber count.
- `loaderStats?` via a new optional `opts.loaderStats?: (key) => { count, ratePerMin, maxMs } | undefined` hook, supplied by server-core from `getRuntimeProfile().aggregates.loader` (match `label === key`, derive `count`, `count/windowMin`, `maxMs`). central-core omits → field absent.

**`plugins/debug/plugins/live-state-health/shared/endpoints.ts`** (create) — `defineEndpoint({ route: "GET /api/resources/_debug", response: ResourcesDebugSchema })` mirroring the enriched shape (route already handled inside the runtime; keep that handler authoritative, fetch it from the pane).

**`plugins/debug/plugins/live-state-health/web/components/server-resources-section.tsx`** (create) + mount in `live-state-health.tsx` — `useEndpoint(resourcesDebugEndpoint)` table: Key / Subscribers / fan-out (max `subCounts`) / call-rate-per-min / maxMs, sorted by rate desc. Sits beneath the existing client `ResourcesSection` (client subscription view + server fan-out/rate view side by side).

---

## WS3 — Heavy-read gate queue depth + active-backends overview (D4)

**`plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts`** (modify) — add a closure-scoped `let waiting = 0` per semaphore: `waiting++` when entering the slow path (all slots busy), `waiting--` in a `finally` bracketing `awaitGranted` (**must be `finally`** — a thrown acquire would otherwise permanently inflate the gauge). Expose `depth(): number` on the `HostSemaphore` interface. The depth gauge belongs on the primitive, not bolted onto one consumer.

**`plugins/infra/plugins/host-read-pool/server/internal/pool.ts`** + **`server/index.ts`** (modify) — `export function heavyReadQueueDepth(): number { return pool.depth(); }`, re-exported from the barrel.

**Active-backends overview** — extend health-monitor (it already owns the `~/.singularity/worktrees/*/logs/health.jsonl` liveness scan):
- `health-monitor/shared/schema.ts` (modify): add `heavyReadDepth: z.number()` to `HealthSampleSchema`.
- `health-monitor/server/internal/process-sampler.ts` (modify): stamp `heavyReadQueueDepth()` into each sampled line.
- `health-monitor/web/components/health-monitor-panel.tsx` (modify): a "Backends" section listing each live worktree backend, last-sample age, current heavy-read depth, and a static idle-work descriptor (worker concurrency 4, stuck-lock-sweeper 60s, process-sampler 10s, host-sampler main 10s, dead-gc cron, crons main).

---

## Trickiest correctness risks

1. **`enqueuedAt` first-merge timing (D1)** — set only in the `!existing` branch; never overwrite. Coalesce/debounce/cascade all route through `mergePending` and must inherit the first time.
2. **central-core identity passthrough (D1/D2)** — `wrapFlush`/`onDelivered`/`loaderStats` all optional and absent in central-core; `resource-runtime/core` must not import the profiler (all contact via injected hooks).
3. **per-worktree GC (D6)** — dead jobs live in each worktree's forked `graphile_worker` tables → GC MUST be `perWorktree: true`, the inverse of the usual main-only default.
4. **archive growth (D6)** — `dead_jobs` is durable; enforce TTL+cap inside `reconcileDeadJobs` every run so the archive can't itself accumulate unbounded.
5. **HostSemaphore depth leak (D4)** — `waiting--` in `finally`, never inline.
6. **SpanKind ripple completeness (D1)** — all 5 enumeration sites or the runtime UI/MCP drops the kind.

---

## Verification (single build + check first: `./equin build && ./equin check`)

- **D1/D3 — MCP `get_runtime_profile`:** trigger a notify on a busy resource. `kind:"flush"` shows a `flushNotifies` aggregate with cycle time + `byParent`/nested `push` rows naming the dominant loader (head-of-line). `kind:"push"` shows `deliver:<key>` leaves with enqueue→send latency; a debounced resource reflects its window (first-merge timing), not ~0.
- **D2:** `curl /api/resources/_debug` (or open Debug→Live State) shows per-resource `subCounts`, `loaderStats.ratePerMin`, fan-out; Playwright the new server-resources section sorts by rate.
- **D4:** under a 16-concurrent boot-snapshot storm, `heavyReadQueueDepth()` > 0; health-monitor Backends section lists live worktrees with non-zero depth; returns to 0 after.
- **D5/D6 — MCP `query_db`:** `SELECT count(*) FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id=j.task_id WHERE t.identifier='jobs.run' AND j.attempts>=j.max_attempts` → 0 after boot reconcile; `SELECT count(*) FROM dead_jobs` → ~688 then bounded by cap/TTL. Re-run reconcile → no change (idempotent). Playwright the Queue "Dead" tab shows archived rows with lastError; the Triggers tab shows a dangling badge for a trigger whose job was removed.
- **Regression:** `./equin check` (boundaries, migrations-in-sync, doc-in-sync, type-check) passes; central-core still loads resources via identity passthrough (no `flush`/`deliver` spans from the central process); stuck-lock-sweeper unchanged (still a `setInterval`, distinct from the new scheduled GC).

## Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` (WS2)
- `plugins/framework/plugins/server-core/core/resources.ts` (WS2)
- `plugins/infra/plugins/runtime-profiler/core/recorder.ts` (WS2)
- `plugins/infra/plugins/jobs/server/internal/dead-job-gc.ts` (create) + `tables.ts` + `server/index.ts` (WS1)
- `plugins/debug/plugins/queue/web/components/queue-view.tsx` (WS1)
- `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts` (WS3)
- `plugins/debug/plugins/health-monitor/web/components/health-monitor-panel.tsx` (WS3)
