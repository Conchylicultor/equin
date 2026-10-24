# Performance Mental Model — equin Audit

## 0. The shape of the problem

equin runs **~16 worktree backend processes** plus a central runtime against **one** shared embedded Postgres cluster on a single machine, each deploying a ~540-plugin SPA. So "performance" here is really four distinct pressures, and the codebase has a distinct mental model for each:

1. **Cold-boot latency** — get the SPA to real data before first paint, without a WS round-trip storm.
2. **Steady-state freshness without recompute** — a DB write must reach exactly the subscribed UI that read the changed rows, recomputing the minimum (push, not poll; incremental, not full-scan).
3. **Contention** — one worktree's storm (or one expensive op) must not saturate cores/connections and starve the other 15.
4. **Observability** — you can't fix what you can't see, so a layered measurement substrate underpins all of it.

The unifying philosophy is **layered defense with generic seams**: cheap-always-on → expensive-on-demand, and every optimization that crosses a plugin boundary does so through a *generic collection read* or an *injected hook*, never by naming another plugin. That keeps the dependency graph a DAG even though the headline wins are emergent and cross-cutting.

---

## 1. Cold-boot & frontend load-time

The boot path is a **layered pipeline**, with each layer owned by a different plugin:

```
L4 change-feed  →  L2 persisted snapshot  →  single-request boot-snapshot  →  Core.Boot pre-paint hydration
(triggers/outbox)   (durable value+xmin)      (one HTTP GET, all resources)    (seed TanStack cache before render)
```

- **`infra/boot-snapshot`** — one `GET /api/resources/boot-snapshot` returns *every* boot-critical resource in a single request; a `Core.Boot` task hydrates them into the live-state cache **before `RootRenderer` mounts**, so the first render reads real data synchronously (no `pending` flash, no per-resource WS sub-ack). A resource opts in one-sidedly with `Resource.Declare(r, { bootCritical: true })`; the set is read generically (`.filter(c => c.bootCritical)`), never by name. The client iterates the keys the snapshot ships and resolves each via the live-state descriptor registry — so **adding a boot-critical resource is a server-only edit**.

- **`database/live-state-snapshot` (L2)** — persists each boot-critical resource's last full value + an **xmin watermark** + its **read-set** (`tables_read[]`). Cold boot then reads all values in one query (the boot-snapshot fast path) and does a **bounded changelog catch-up**: replay only changelog rows with `xid ≥ min(watermark)` through the *exact same cascade the live LISTEN consumer uses*. On a short deploy the replay set is empty → **zero recompute**. The watermark is captured *before* the loader's first read, making under-replay structurally impossible; a missing-history backstop FULL-recomputes only the changed tables and logs loudly.

- **`primitives/perfs/boot-trace`** — a one-clock (`performance.now()` from `timeOrigin`) module-level span store, imported eagerly so it's live before any resource mounts. Folds in Navigation Timing (TTFB decomposition), Paint Timing (FCP), the **first React commit** (via a passive commit bridge installed in `web-core/index.html` before react-dom loads), **Long Tasks** (the 0→first-span blind spot the main thread can't self-instrument), and asset Resource Timing. `wait = duration − workMs` is the per-resource split.

- **`debug/boot-profile`** — renders all of that as a request→first-paint Gantt with wait/work split, long-task bars clipped to the boot window, an asset waterfall (request+download split, top-8 + rollup), and a "boot cost" summary (JS bytes shipped, biggest chunk, main-thread busy-before-paint).

- **`primitives/loading`** — pure-CSS **delay-before-show (~120ms)**: every skeleton mounts invisible and fades in only after 120ms, so on the warm path (<100ms WS settle) the loading node unmounts before it ever paints — zero transient flash.

- **`framework/web-core` + `web-sdk`** — the SPA shell: a **codegen'd dynamic-import plugin registry** (each plugin's `web/index.ts` is a separate `import()`, the per-plugin error-isolation boundary), the `Core.Boot` pre-paint hook, pre-paint theme replay from localStorage, and the commit bridge. **One gap flagged:** `vite.config.ts` sets *no `manualChunks`* — chunking is left to Rollup defaults; the boot profiler *measures* chunk fan-out but nothing deliberately *shapes* it.

---

## 2. Steady-state freshness — the IVM / live-state engine

This is the system's deepest and most distinctive piece: a **push-based incremental view-maintenance system**. The mental model is *"a committed write propagates to exactly the subscribed surfaces that read the changed rows, recomputing the minimum."* It's split across plugins by layer:

**The engine — `framework/resource-runtime`** (note: *not* `primitives/live-state`, which is client-only). `createResourceRuntime()` owns `defineResource`, a DAG cascade, and keyed delta sync. Performance mechanics:
- **Coalescing**: many notifies for the same param-tuple within a tick collapse to one recompute (microtask flush over a pending map).
- **Level-parallel DAG flush**: topo-sorted by longest-path depth; same-depth entries have no edges so they run `Promise.all` with barriers between levels — a slow loader can't head-of-line-block independent siblings.
- **Conditional recompute**: the loader runs *only if* there's a subscriber, a value-aware downstream, or L2 persistence. No subscribers + not persisted ⇒ compute nothing. `invalidate`-mode ships a bare version bump and never runs the loader.
- **Single-flight reads**: a subscribe/GET herd shares one loader promise.
- **Keyed delta diff**: the loader returns the whole array, but the runtime keeps a per-id hash snapshot and ships only `upserts`/`deletes`; `order` is omitted when the id sequence is unchanged — an in-place single-row update ships exactly one row. Unchanged rows keep their object reference so memoized row components don't re-render.
- **Layer-2 scoped recompute**: `notify(params, { affectedIds })` lets the loader do `WHERE id IN (…)` and return only changed rows; cascade edges propagate scope and a `signature` relevance gate drops cascades whose downstream projection is unchanged. Sticky-degrades to FULL if any id-less contributor appears.
- **No-op handling**: empty scoped sets and zero-change keyed diffs send no frame but still fire `onPush({changed:false})` for the churn inspector.

**L4 invalidation — `database/change-feed`**. STATEMENT-level Postgres triggers on every non-denylisted public table `pg_notify` on commit (one NOTIFY per *statement* via transition tables — bulk writes are cheap) and write a transactional `live_state_changelog` outbox row. A single LISTEN consumer routes each change through `routeChange → applyDbChange`. **"Missed invalidations are structurally impossible"** because the trigger set is rebuilt from the live catalog every boot (no per-resource wiring), and out-of-process writes (psql, jobs, other backends) fire it too.

**How resources know their tables — the two-layer dependency model** (the spine):
1. **`dependsOn`** — the hand-drawn resource→resource graph (with `map`/`affectedMap`/`signature`), driving the cascade.
2. **Automatic table→resource read-set** — captured at the DB-pool query chokepoint (every `pool.query` attributed to the innermost enclosing loader), inverted into `table → resource[]`, and seeded at boot from L2's durable `tables_read`. This is what lets the change-feed need zero per-resource wiring.

They reconcile in `coveredOriginsFor`: anything in a resource's read-set but *outside* its covered origins is a **silent FULL recompute** — surfaced in the Read-set debug pane as the audit signal for gaps and over-broad edges.

**Materialized derived state:**
- **`database/derived-tables`** — a hand-rolled IVM: STATEMENT triggers incrementally maintain rollup tables (e.g. "latest conversation per task"), rebuilt + reconciled on boot, and **feed-exempted** (no NOTIFY trigger on the rollup itself, so the source change drives the scoped recompute, not a double-route).
- **`database/derived-views`** — plain views rebuilt on boot in dependency order, with a **DDL-fingerprint skip** that removes the AccessExclusive lock window on steady-state restarts, and `identityTable` that lets a 1:1 view forward a scoped change instead of degrading to FULL.

**Client optimism — `primitives/optimistic-mutation`**: pending ops live *outside* the TanStack cache (in React state); the rendered value is `pendingOps.reduce(apply, serverTruth)`, re-based on each authoritative WS push. Never `setQueryData` (which would race the version-gated push). Confirmation is push-driven and content-aware; rollback is just dropping the op.

---

## 3. Contention control

The mental model: **gate the scarce resource, charge the wait, and make the gate span the right scope (per-worktree vs host-wide).**

- **`database/embedded`** — one PG18 cluster, Unix-socket only, `max_connections=500` (the true global ceiling, not programmatically enforced).
- **`database/pgbouncer`** — **transaction-mode** pooling (`default_pool_size=16`) on port 6432 so N idle client connections multiplex onto few backends. The load-bearing routing split: app queries → :6432; LISTEN/NOTIFY, advisory locks, pg_dump/restore, graphile-worker → **direct :5433** (session-scoped, incompatible with tx pooling).
- **`database` core — the loader DB gate**: of `POOL_MAX=16`, reserve 6 for interactive work; loader-kind queries go through `createSemaphore(10)`. Caller kind is read from the profiler's ambient context *before any await*, so it's **automatic** — consumers don't wrap. Wait is charged to the enclosing loader as `[loader-acquire]`. Plus deadlock/serialization retry (40P01/40001) with jittered backoff, and `warmPool` to force pgbouncer to attach backends eagerly. *(Leak: `pool.connect()` transaction paths bypass both the gate and timing.)*
- **`infra/host-read-pool` — `withHeavyReadSlot`**: a **two-tier** gate for heavy git/fs reads — host-wide (`floor(cpus/4)`, via flock) + per-worktree (`ceil(host/2)`) so no single worktree monopolizes the host gate under a fan-out storm. **This is the central opt-in leak**: it lives at the operation level (cheap git stays ungated), so *every heavy consumer must remember to wrap*. A new heavy loader that forgets escapes the budget.
- **`packages/host-semaphore`** — cross-process bound via N `flock(2)` slot files + a broker subprocess for the blocking-acquire slow path (so a long-lived event loop never blocks on `flock`). Auto-releases on process death. Plus the in-process twins `semaphore`, `inflight` (single-flight/coalesce), `retry`.
- **`infra/git-read-cache`** — git-state-keyed memo: a cheap ungated `signatureFn` runs every call; a **hit returns instantly and acquires no heavy slot**; a miss runs `computeFn` under embedded single-flight keyed by `worktreePath`. The storm path becomes mostly memo hits doing zero git work. *(Leak: `computeFn` must own its own `withHeavyReadSlot`, and `signatureFn` must faithfully fingerprint every input or it serves stale data.)*
- **`infra/contention`** — a 1s-TTL-cached cluster-wide snapshot (`os.loadavg()` + `pg_stat_activity` grouped by datname) stamped onto slow ops, so a storm of slow ops collapses onto one read.
- **`database/fork`** — per-worktree DB fork made **atomic (temp + rename) + idempotent + durable** (graphile retry) + self-healing (orphan sweep). *(Flagged: the `pg_dump|pg_restore` subprocess pairs are **ungated** — a fork storm is an uncontrolled contention source.)*

---

## 4. Observability — the measurement substrate

A three-tier model: **always-on cheap detectors → on-demand expensive profilers → durable report store**, all underpinned by one in-memory span recorder.

**Foundation:**
- **`infra/runtime-profiler`** (load-bearing, zero-dep, isomorphic) — records HTTP/DB/loader spans with `byParent` attribution and the wait/work `[acquire]` split. Exposes `onSlowSpan` (push), `getRuntimeProfile` (pull), the read-set index, `currentCallerKind`, and the `runWithoutProfiling` suppression seam that prevents the observability subsystem from measuring itself into a pool storm. The recorder takes **no back-edges** — consumers reach into it.
- **`reports`** — the durable Postgres report store + task engine all detectors funnel into; generic over a `ReportKind` registry (it "never names a kind"), with velocity-limiting and per-fingerprint mutex. Hosts the always-on **render-loop detector** (one `MutationObserver` on `body`, files only when sustained + idle + visible + wasted-work).

**On-demand expensive:**
- `debug/profiling` — the Gantt panes (boot phases + per-phase phys_footprint, build steps, push contention, runtime tables, stats), reachable via `get_runtime_profile` MCP (fetched *through the gateway* so it never reports a stale hot-swapped generation).
- `debug/render-profiler` — per-commit React fiber walk naming the *initiating* component + hook (incl. `useSyncExternalStore`), mount-vs-update split, ranked remounts. Self-contained (React internals only); 3 surfaces (pane, headless e2e, `window.__reactRenderProfiler`).
- `debug/heap-snapshot` — cheap `bun:jsc heapStats` + on-demand full V8 dump; surfaces **phys_footprint** (not rss) as the JS-vs-native discriminator.

**Always-on cheap detectors** (all copy the same `queue-health` template — durable signal → `config_v2` threshold → `ReportKind` → deduped task, `perWorktree` singleton job, silent when healthy):
- `debug/slow-ops` — durable `slow_ops` store with real `last_seen_at`/`last_ms` + caller attribution; fed by `onSlowSpan` (server) and client page-load/element-settle signals.
- `debug/op-rate` — pull-diffs per-op call counts each tick → catches *fast-but-hammered* ops slow-ops misses.
- `debug/live-state-churn/monitor` — in-memory no-op-push accumulator → files when a resource sustains high empty-diff rate. (Plus `emit`, a synthetic load generator for repro.)
- `debug/queue-health` — dead-job / backlog monitor.
- `debug/health-monitor` — a 10s `setInterval` (deliberately *not* graphile — it's the instrument *for* a wedged loop) sampling event-loop lag (native histogram, accurate even while JS blocks), phys_footprint, heap growth; writes JSONL **read from disk** so it works on a wedged backend.

**Pure inspectors (self-contained):** `debug/read-set` (loader→table index + dependsOn diff), `debug/live-state-health` (client pipeline: sockets/leader/per-resource version).

---

## 5. Transport & rendering-volume

The principle throughout: **push, never poll.**

- **`primitives/networking`** (load-bearing) — `SharedWebSocket` collapses N tabs to **one** server socket via Web-Locks leader election + BroadcastChannel; reconnection/backoff/send-queue transparent behind a native-WS API.
- **`primitives/live-state`** (load-bearing, on networking) — **WS-as-source-of-truth** TanStack config (`staleTime: Infinity`, no background refetch); refcounted per-(key,params) subscriptions with 30s keep-alive (so virtualized remounts reuse the sub); keyed delta merge; **slice selectors** (`select`) + date-aware structural sharing to kill the O(C²) re-render storm; boot hydration with no Suspense.
- **`infra/ndjson-stream`** — chunked NDJSON (survives Bun's 10s idle timeout, renders rows progressively). *(Leak: consumer must implement frame-flush batching to avoid O(n²) re-renders — no shared helper.)*
- **`primitives/cursor-pagination`** — frozen-cursor window + IntersectionObserver auto-fetch + live-id de-dup.
- **`primitives/virtual-rows`** — windowed rendering with runtime scroll-container discovery. *(Canonical leak: opt-in per view, gated behind a ~100-row threshold.)*
- **`infra/jobs`** (load-bearing) — durable graphile-worker queue (LISTEN/NOTIFY wake) moving heavy work off the request path; dedup/single-flight, bounded concurrency (4), `ctx.step` memoization, `NonRetryableError` to kill retry storms, schedules main-only-by-default with `backfillPeriod: 0` (no boot flood).
- **`infra/events`** — producer↔consumer decoupling via persisted trigger rows (partial-indexed); emit resolves when dispatch jobs are durable, never on consumer completion; self-healing drift cleanup.
- **`git-watcher` / `file-watcher`** — `@parcel/watcher` OS events with debounce + ceiling + reconcile safety-net; git-watcher watches only `refs/` (not the 1000-worktree-shared `.git/objects`) and skips unchanged SHAs — pure wasted-subprocess elimination. `lastKnownMainSha()` lets downstream memos fingerprint `main` with zero subprocess.
- **`review/plugin-changes`** — the worked memoization example: each plugin tree memoized on a cheap never-stale signature (main SHA from git-watcher; generation counter from edited-files), + debounce + active-conversations-only recompute.

---

## 6. Plugin map — self-containment

The headline finding for "are they self-contained?": **the leaf primitives are self-contained; the headline optimizations are deliberately cross-cutting**, mediated through generic seams.

### Self-contained (the optimization lives entirely in the plugin; consumers get it free or by using the component)

| Plugin | Optimization | Note |
|---|---|---|
| `primitives/loading` | CSS delay-before-show | self-policed by its own lint rules |
| `primitives/perfs/boot-trace` | one-clock boot span store | only ext. prereq: commit bridge in index.html |
| `debug/boot-profile`, `debug/read-set`, `debug/live-state-health` | read-only visualizers | impose nothing |
| `debug/render-profiler`, `debug/heap-snapshot` | on-demand profilers | React internals / one metric import only |
| `infra/runtime-profiler`, `reports` | foundation | **depended-upon, not dependent** (inverted edges) |
| `packages/{semaphore,inflight,retry,host-semaphore}` | concurrency mechanisms | policy lives in consumers |
| `primitives/networking` | tab-shared reconnecting transport | transparent behind native-WS API |
| `database/contention` | cached snapshot | pure read-side |
| `database/derived-views/tables` | view/rollup rebuild mechanism | generic registry; SQL lives in contributor |

### Leaks by design (cross-plugin contract — the optimization is emergent)

| Plugin | Leaks into | Why it must |
|---|---|---|
| `infra/boot-snapshot` | server-core (`bootCritical`), ~20 consumers, live-state, L2 snapshot, `Core.Boot` | cold-boot latency is a property no single plugin owns |
| `database/live-state-snapshot` | resource-runtime (injected persist hooks), change-feed (`routeChange`), runtime-profiler (read-set seed) | persisted boot is pure orchestration |
| `framework/resource-runtime` | server-core + change-feed + runtime-profiler + feature loaders | scoped incremental recompute is a multi-plugin contract |
| `database/change-feed` | server-core (`applyDbChange`), derived-views/tables | the wirer of the whole cascade |
| `primitives/live-state` re-render levers | consumer must pass `select`/declare `keyed`/honor `affectedIds` | opt-in by nature |
| `primitives/optimistic-mutation` | live-state cache + sync-status | layered on live-state |

### Leaks that depend on consumer discipline → **the audit's risk surface**

These are the places where "forgetting" silently costs performance with no compile-time or check-time guard:

1. **`withHeavyReadSlot` (`infra/host-read-pool`)** must be hand-wrapped at every heavy git/fs op. Confirmed consumers: code-explorer push-files, plugin-changes, plugin-view tree, commits-graph, edited-files. A new heavy loader that forgets escapes the host budget.
2. **`git-read-cache`** — `computeFn` must itself own `withHeavyReadSlot` *and* `signatureFn` must fingerprint every input (compounds with #1).
3. **PgBouncer routing (:6432 vs :5433)** is decided independently at each pool/subprocess site — no central seam; a session-semantics caller routed through tx-pooling breaks.
4. **`database/fork`** `pg_dump|pg_restore` is **ungated** — a worktree-creation burst is uncontrolled cluster contention.
5. **`infra/jobs`** non-idempotent side effects must use `ctx.step` (runtime contract, not typed).
6. **`infra/ndjson-stream`** consumers must hand-roll frame-flush batching (O(n²) re-render trap).
7. **No `manualChunks`** in the Vite build — bundle splitting is unshaped, only measured.
8. **`pool.connect()` transaction paths** bypass the loader DB gate and timing entirely.

---

## 7. Bottom line

The mental model is coherent and unusually disciplined: a **layered, push-based, incrementally-maintained** system where cold-boot, freshness, contention, and observability each have a dedicated stack, and where cross-plugin leaks are routed through **generic collection reads** (`filter(bootCritical)`, `ReportKind` registry, `DerivedTable`/`View` contributions) and **injected hooks** (`setLiveStateSnapshotHooks`, `onSlowSpan`, `readSet`) rather than by-name coupling — so the dependency *direction* stays clean (DB/infra never names a feature table) even though the wins are emergent.

The genuine fragility is **the risk surface in §6**: a cluster of high-value optimizations (heavy-read budget, git memo, fork, jobs idempotency) are **opt-in by hand with no enforcement**. Each is a footgun where the failure mode is silent performance regression, not a loud crash — exactly the class CLAUDE.md says to eliminate structurally (a required type, a check, or a derived value) rather than document. The enforceable candidates: a check that flags heavy git/fs calls outside `withHeavyReadSlot`, and gating fork subprocesses through a host semaphore.
