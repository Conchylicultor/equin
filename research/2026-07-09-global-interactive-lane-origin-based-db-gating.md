# Interactive lane under load — implementation plan (origin-based DB gating)

**Companion doc:** [`research/2026-07-09-global-interactive-lane-under-load.md`](./2026-07-09-global-interactive-lane-under-load.md)
— the forensic report. Read it first; this doc is the implementation plan for the fix it
scopes.

## Context

Twice on 2026-07-09, under stacked agent builds (host load 50–63 on 18 cores), the main app
became unusable for minutes. The chain was measured end to end: host load → main-backend
event-loop lag (~1 s p50 at load 48–56) → DB connection hold-times inflate ~100–500× → the
16-connection pool saturates → **human-blocking work queues FIFO behind unbounded background
demand**. Victims: `sub jsonl-events` 124 s (119.9 s of it `db-acquire` wait),
`POST /api/conversations/:id/viewed` 122 s, point-SELECTs at 2.4 s. Postgres itself was idle
— the collapse lives entirely in the JS orchestration layer.

`plugins/database/server/internal/client.ts` already half-implements the right design
(`POOL_MAX = 16`, `RESERVED_INTERACTIVE = 6`, `loaderDbGate` at 10). Three gaps defeat it:

- **Gap A — origin blindness.** The gate classifies by `currentCallerKind()`. Inside a
  resource load that is `"loader"` regardless of *why* the load runs, so a human's cold
  sub-ack load queues behind hundreds of cascade recomputes.
- **Gap B — the transaction bypass.** `db.transaction()` takes `pool.connect()`, bypassing
  both the wrapper and the reservation. Inflated background transactions ate all 16
  connections *including the reserved 6*. This killed the afternoon incident.
- **Gap C — jobs are ungated.** `"job"`-kind queries run against the reserved capacity.

**Target property:** a human-blocking request's latency must never be a function of
background queue depth. Reducing the load itself (build admission) is explicitly out of
scope. The accepted trade: under overload, **pull stays fast, push goes stale**.

## The design in one sentence

Partition every shared DB-capacity layer by **origin class** — *interactive* (`sub`-ack
loads, HTTP handlers, boot-snapshot) vs *background* (`push`/`flush`/`cascade` recomputes,
jobs, and anything explicitly declared background) — so the reserved-interactive floor is
structurally unreachable by background work, no matter how slow or numerous it gets.

### Why "outermost entry kind" is a sound origin signal

The recorder (`plugins/infra/plugins/runtime-profiler/core/recorder.ts`) already threads a
live `EntryContext.parent` chain, readable synchronously. Verified by audit:

- `push` and `cascade` are **never** roots — every `wrapOrigin("push"|"cascade", …)` call
  site in `resource-runtime/core/runtime.ts` is reachable only via `flushNotifies` →
  `wrapFlush`. So the root of a cascade chain is always `flush`.
- `sub` is a legitimate root: `GET /api/resources/:key` is a raw `httpRoutes` handler
  (`server-core/bin/index.ts:184`) and opens **no** `http` span, but `gatedRead` wraps it in
  a `sub` origin. Still interactive. ✅
- `boot-snapshot` does **not** detach: `assembleBootSnapshot` awaits its
  `loadResourceByKey` fan-out inside `implement()`'s `http` entry span. Root = `http`. ✅
- Boot/migrations/`warmPool`/graphile internals/change-feed listener have **no** ambient
  entry (they are timed by the separate `server-core/core/profiler.ts` instrument). Root =
  none → stay ungated, so boot can never deadlock on a gate.

### The deadlock proof (why two semaphores, not one)

```
POOL_MAX             = 16
RESERVED_INTERACTIVE = 6
BACKGROUND_MAX       = POOL_MAX - RESERVED_INTERACTIVE   // 10
BACKGROUND_TX_MAX    = 3
BACKGROUND_QUERY_MAX = BACKGROUND_MAX - BACKGROUND_TX_MAX // 7
```

A background transaction holds a pool connection for its whole life and may `await` a pool
query inside its callback. With **one** shared background gate, 10 transactions each awaiting
a gate slot deadlock the entire background lane permanently. With **two**, the wait-for graph
is acyclic by construction:

`bg-tx → bg-query → pool connection → {interactive, boot}` — and the terminal holders always
complete. Concretely: bg-tx holders pin at most 3 connections and bg-query holders at most 7,
so `3 + 7 = 10 ≤ 16` always leaves ≥ 6 connections free for the bg-query holders to finish and
release the slots the transactions are waiting on. **The `BG_TX + BG_QUERY ≤ POOL_MAX −
RESERVED_INTERACTIVE` invariant *is* the deadlock proof** — assert it in code, not in prose.

---

## Tasks

### Task 1 — `currentOriginClass()` in the recorder

**File:** `plugins/infra/plugins/runtime-profiler/core/recorder.ts` (+ `core/index.ts` export)

Add, next to the existing `currentCallerKind()` (recorder.ts:1004):

```ts
export type OriginClass = "interactive" | "background";

// Exhaustive over SPAN_KINDS: adding a kind is a tsc error until it picks a lane.
const ORIGIN_CLASS: Record<SpanKind, OriginClass> = {
  http: "interactive",     // request/mutation handlers, incl. boot-snapshot
  sub: "interactive",      // WS sub-ack + the raw GET /api/resources/:key read path
  loader: "interactive",   // a bare loader root (loadResourceByKey / measureSubscribeCycle)
  db: "interactive",       // leaf kind, never an entry root — exhaustiveness only
  flush: "background",     // the notify-flush cycle
  push: "background",      // cascade recompute (always nested under flush)
  cascade: "background",   // dependsOn edge ids-translation (always nested under flush)
  job: "background",       // graphile job bodies
};

/** Class of the OUTERMOST enclosing entry; `undefined` when none (boot/migrations). */
export function currentOriginClass(): OriginClass | undefined;
```

Implementation: if the background-lane override is active (below), return `"background"`.
Otherwise walk `ctx.parent` to the root and map its `kind`. Must be read **synchronously,
before any await** — same constraint as `currentCallerKind`. Walk regardless of `closed` (the
root's kind is the origin even for a detached continuation).

Also add the explicit override, mirroring the existing `installProfilingSuppressionRuntime` /
`runWithoutProfiling` seam byte-for-byte (the ALS is installed by
`runtime-profiler/server/internal/install.ts`; the core stays Node-free):

```ts
export function installBackgroundLaneRuntime(rt: BackgroundLaneRuntime): void;
export function runInBackgroundLane<T>(fn: () => T | Promise<T>): Promise<T>;
```

The override wins over the origin walk: work declared background is background even when a
human triggered it. Deliberately **separate** from `runWithoutProfiling` — "don't record" and
"is background" are different claims, and `debug/profiling/boot-bench`'s load-generator relies
on the former while wanting real slots.

**Tests** (`core/recorder.test.ts`, bun:test, DB-free): `flush → push → loader` ⇒ background;
`sub → loader` ⇒ interactive; `http → loader` ⇒ interactive; no entry ⇒ `undefined`;
`runInBackgroundLane` inside an `http` entry ⇒ background.

### Task 2 — Partition the pool wrapper (Gaps A + C)

**File:** `plugins/database/server/internal/client.ts`

Replace the `loaderDbGate` with the two-semaphore split and the invariant assertion. Rename
the wait layer `loader-acquire` → `background-acquire` (it no longer means "loader": jobs and
flush charge to it too) and add `background-tx-acquire`. Register both via
`registerGateGauge` so they appear in traces automatically.

In `installQueryWrapper`'s `pool.query` (client.ts:219–231), replace the caller-kind branch:

```ts
const callerKind = currentCallerKind();
if (callerKind === "loader") recordReadTables(extractReadTablesFromSql(text));  // unchanged

if (currentOriginClass() === "background") {
  return backgroundQueryGate.run(runTimed, (ms) => chargeWait("background-acquire", ms));
}
return runTimed();  // interactive + context-less (boot/migrations) run ungated
```

Note this *drops* the `callerKind === "loader" | "cascade"` condition entirely. Read-set
capture stays keyed on `callerKind === "loader"` — orthogonal concern, unchanged.

Consequences:
- A `sub`-origin loader query is now ungated → Gap A closed.
- A `job`-origin query is now gated → Gap C closed.
- A `flush` entry's own direct queries (previously ungated, caller kind `"flush"`) are now
  gated — a hole the old condition left open.
- Interactive stays **ungated**, matching today's `http` semantics. It is already bounded
  upstream: `readLoadGate` (`READ_LOAD_CONCURRENCY = 6`, `resource-runtime/core/runtime.ts:906`)
  caps concurrent cold sub-ack/GET loads, and endpoints have per-route concurrency gates.

Per the companion doc, **do not** touch `read-admit` sizing or priority in this pass.

### Task 3 — Gate transactions (Gap B)

**Files:** `plugins/packages/plugins/semaphore/core/internal/semaphore.ts`,
`plugins/database/server/internal/client.ts`

The tx gate needs *lease* semantics (acquire at `connect()`, release at `client.release()`),
which `Semaphore.run(fn)` cannot express. Extend the primitive with the lease it already
implements internally:

```ts
/** Acquire a slot; returns an idempotent release fn. `run` is this + a `finally`. */
acquire(onWait?: (waitMs: number) => void): Promise<() => void>;
```

Then wrap `pool.connect` in `installQueryWrapper` (alongside the existing `pool.query` wrap).
`origConnect` is already captured before the override (client.ts:133) and `runOnce` uses it,
so query-path connections are **not** double-gated:

- Callback form → pass through untouched.
- `currentOriginClass() !== "background"` → `origConnect()` unchanged. This covers
  `awaitDbReady`, `warmPool` (context-less) and interactive HTTP mutations.
- Background → `backgroundTxGate.acquire(ms => chargeWait("background-tx-acquire", ms))`,
  then `origConnect()`, then monkey-patch `client.release` to free the slot exactly once
  (guard with a `released` flag — pg throws on double-release; preserve the
  `release(err?: Error | boolean)` signature). Release the slot in a `catch` if `connect()`
  itself throws.

This is the path drizzle's `db.transaction()` takes (`NodePgSession` does
`await this.client.connect()` when `client instanceof Pool` — which is why the `db` Proxy
must keep forwarding to a real `pg.Pool`, see `client.ts:254–266`).

Also close the two ungated job-cleanup writes that sit *outside* the `job` entry span in
`plugins/infra/plugins/jobs/server/internal/worker.ts` — the `_jobSteps`/`_jobWaits` deletes
(worker.ts:253–259) and `markJobPermanentlyFailed` (worker.ts:236). Wrap each in
`runInBackgroundLane`.

**Tests:** export `installQueryWrapper` for testing and drive it with a fake `pg.Pool`-shaped
object (co-located `client.test.ts`, bun:test). Invariants: background queries never exceed
`BACKGROUND_QUERY_MAX` in flight; interactive queries are never gated; a background `connect()`
holds a tx slot until `release()`; a static assertion that
`BACKGROUND_TX_MAX + BACKGROUND_QUERY_MAX === POOL_MAX - RESERVED_INTERACTIVE`.

### Task 4 — Observability writes into the background lane (§2.5 self-amplification)

Slow-op/report writes about the slowness are themselves DB transactions — three concurrent
`INSERT INTO slow_ops` were caught blocked on each other's `Lock:transactionid` during the
incident. Under origin-only classification they inherit their *trigger's* origin, so a
slow-op tripped inside a `sub` load would ride the human lane. Wrap each observability write
in `runInBackgroundLane`, outside the existing `runWithoutProfiling` scope:

- `plugins/debug/plugins/slow-ops/server/internal/record-slow-op.ts:148`
- `plugins/reports/server/internal/record-report.ts:104` and `:182`
- `plugins/reports/server/internal/investigate.ts:44`
- `plugins/debug/plugins/trace/plugins/engine/server/internal/capture.ts:61`
- `plugins/infra/plugins/contention/server/internal/snapshot.ts:36`

Leave `debug/profiling/boot-bench`'s load-generator alone — it deliberately holds real slots.

### Task 5 — Bound transaction hold-time (supporting guardrails)

Two layers, because neither alone is sufficient.

**5a — ESLint rule** `no-pool-await-in-transaction`, contributed as
`plugins/database/lint/index.ts` (auto-discovered by the root `eslint.config.ts`; follow the
shape of `plugins/framework/plugins/tooling/plugins/lint/plugins/promise-safety/`). Inside a
`db.transaction(async (tx) => …)` callback, every `await`ed call expression must either be a
`tx.*` member chain or receive the `tx` binding as an argument. Caps hold at
`#statements × lag` and forbids the hold-and-wait shape. Verified against the audit: this
passes all the legitimate `insertForest(tx, …)` / `nextRankIn(_table, tx)` / `computeRank(id, tx)`
sites and flags the direct `await listBlockingDepIds(taskId)` in
`queue/server/internal/repair-blocked-order.ts:42`.

**5b — Required executor param.** The rule cannot see one hop down, and the audit found
exactly that leak: `cascadeBlockedDependents(conversationId, tx)` *looks* tx-clean but
internally calls `listDependentIds(currentTaskId)` (defaults `exec: DbExecutor = db` →
`tasks-core/server/internal/queries/tasks.ts:101`) and `listBlockingDepIds(depTaskId)` (no
executor param at all → `tasks.ts:82`). So three queue handlers hold a connection while
queueing for another one:

| site | leak |
|---|---|
| `queue/…/handle-reorder.ts:12` | via `cascadeBlockedDependents` |
| `queue/…/handle-demote.ts:14` | via `cascadeBlockedDependents` |
| `queue/…/handle-step-down.ts:14` | via `cascadeBlockedDependents` |
| `queue/…/repair-blocked-order.ts:13` | direct `await listBlockingDepIds(taskId)` |

Fix structurally: make the executor **required** on both helpers (drop the `= db` default,
add the param to `listBlockingDepIds`), so the transitive leak becomes a tsc error rather
than a runtime hazard. Thread `tx` through `cascadeBlockedDependents` and fix the four call
sites. Also fixes a latent read-your-writes bug — those reads currently miss the open
transaction's own writes.

### Task 6 — Docs

- `plugins/database/CLAUDE.md` — rewrite the "Connection gate (loader vs interactive)"
  section: origin classes, the two gates, the `BG_TX + BG_QUERY ≤ POOL_MAX − RESERVED`
  invariant *as the deadlock proof*, and the fact that transactions no longer bypass the
  reservation.
- `plugins/infra/plugins/runtime-profiler/CLAUDE.md` — `currentOriginClass` /
  `runInBackgroundLane` in the entry-points section; rename `loader-acquire` and add
  `background-tx-acquire` in the charging-layers list.
- `plugins/packages/plugins/semaphore/CLAUDE.md` — document `acquire()`.
- `plugins/debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts` — the
  wait-layer prose names `loader-acquire` in two places (lines 48, 52).

---

## Files touched

| File | Change |
|---|---|
| `plugins/infra/plugins/runtime-profiler/core/recorder.ts` | `currentOriginClass`, `ORIGIN_CLASS`, background-lane runtime seam |
| `plugins/infra/plugins/runtime-profiler/core/index.ts` | exports |
| `plugins/infra/plugins/runtime-profiler/server/internal/install.ts` | install the background-lane ALS |
| `plugins/packages/plugins/semaphore/core/internal/semaphore.ts` | `acquire()` lease API; `run` reimplemented on it |
| `plugins/database/server/internal/client.ts` | two gates, origin-based `pool.query` branch, `pool.connect` wrap |
| `plugins/database/lint/index.ts` (new) | `no-pool-await-in-transaction` |
| `plugins/infra/plugins/jobs/server/internal/worker.ts` | job-cleanup writes into the background lane |
| `plugins/tasks/plugins/tasks-core/server/internal/queries/tasks.ts` | required executor param |
| `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/{cascade-blocked,handle-reorder,handle-demote,handle-step-down,repair-blocked-order}.ts` | thread `tx` |
| 6 observability write sites (Task 4) | `runInBackgroundLane` |

## Verification

**Invariant tests (fast, run first):**

```bash
bun test plugins/infra/plugins/runtime-profiler/core/recorder.test.ts
bun test plugins/database/server/internal/client.test.ts
bun test plugins/packages/plugins/semaphore
./equin check           # incl. type-check + the new lint rule
```

**Behavioral, under synthetic load (the companion doc's T1 protocol):** the acceptance
property is a *ratio*, so measure before and after on the same box.

1. `./equin build`, then push host load past 50 with ~30 `taskpolicy -b` busy-loops
   (no agent builds — the trigger is out of scope, we only need the lag).
2. Drive background churn with the existing synthetic emitter: Debug → Live-State Emit
   (`plugins/debug/plugins/live-state-churn/emit`) or `window.__liveStateEmit`.
3. Measure:
   - **(a) point mutation** — `curl -w '%{time_total}'` on a point endpoint. Expect ~2–3 s
     worst case, not 122 s.
   - **(b) cold `sub` on a non-boot-critical resource** — open a conversation (the
     `jsonl-events` pane, the one resource that cannot be snapshot-hydrated and must run a
     live loader through the gates). Expect seconds, not 2–5 minutes.
   - **(c) gate occupancy** — fire `POST /api/debug/trace/test-trigger`, then read the
     `traces` row **via `query_db` / SQL, not HTTP** (the HTTP read path starves during an
     incident — observed live). Expect: `background-acquire` and `background-tx-acquire`
     saturated with deep queues; `db-pool` **not** at 16/16; the `sub` span's `waits` free of
     `background-*` layers.
4. The honest residual: per-`await` lag quanta remain (seconds at extreme load, not ms).
   Shrinking the *quantum* is out of scope.

**Real-world:** the next natural stacked-build pile-up. Bucket `eventLoopP50Ms` from
`~/.singularity/worktrees/singularity/logs/health.jsonl` by `loadAvg1` from
`health-host.jsonl` (the dose–response method) and compare trace waits.

## Risks

- **Boot-snapshot cold fan-out is now ungated.** `assembleBootSnapshot`'s
  `Promise.allSettled` over missing keys runs under `http` → interactive → no DB gate, where
  it used to be capped at 10 by `loaderDbGate`. On a cold boot with an empty L2 snapshot it
  can stampede the pool. It cannot deadlock, and a human *is* waiting for first paint, so
  this is deferred — but bound the fan-out concurrency if step (b) above regresses.
- **Sustained interactive load starves background**, so the flush cascade lags and its
  pending map grows. This is the accepted trade ("push goes stale"), and coalescing bounds
  the harm — a late recompute computes *current* truth. Now observable via the two new gate
  gauges rather than invisible.
- **`BACKGROUND_TX_MAX = 3` may be tight** for bursts of jobs + observability writes,
  especially since concurrent `slow_ops` upserts serialize on their row lock for seconds
  each. It is a tunable constant; the gauge will say.

## Explicitly out of scope (per the companion doc §7)

Build/type-check host-wide admission (the incident *trigger*); gate-saturation monitoring;
the process split; the PgBouncer `default_pool_size` interaction; `read-admit` resizing.
