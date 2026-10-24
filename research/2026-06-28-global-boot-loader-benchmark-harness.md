# Boot & live-state loader benchmark harness

## Context

We keep making perf changes (L2/L3 snapshots, read-set seeding, git-read caches,
loader single-flight) to the cold-boot and live-state paths, but we have **no
repeatable way to get trustworthy before/after numbers**. The one prior
"benchmark" (`research/2026-06-06-push-check-benchmark.md`) was hand-run
`performance.now()` measurements, never a harness, and no script survived. Every
downstream perf task therefore reports vibes, not deltas.

This plan builds **one repeatable, cold-cache harness** that measures the four
numbers that matter for the boot burst and reports a before/after diff through
the **same** interface every perf task can re-run:

1. `GET /api/resources/boot-snapshot` — total time **and** per-key
   `{ source: persisted | loader, workMs }`.
2. `edited-files` first-subscribe latency (resource `edited-files`,
   params `{ id: conversationId }`).
3. `commits-graph` first-subscribe latency (`commits-graph.delta` /
   `commits-graph.graph`, params `{ attemptId }`).
4. Event-loop lag during the boot burst.

**Decisions taken (with the user):**
- **Scope = live-server cold.** Force cold by clearing the persisted L2 snapshot
  on a *running* backend — no server restart per iteration. This captures the
  loader/snapshot work that perf changes actually target; it deliberately
  excludes server-boot work (catch-up, derived-table rebuild, pool warm), which
  is noisier and harder to bracket. Restart-boot scope is a documented v2.
- **Surface = the existing profiling MCP, not a CLI.** A new MCP tool
  `benchmark_boot` lives beside `get_runtime_profile`, routes to any worktree
  through the gateway with the identical pattern, and returns a structured +
  human-readable report. Agents (who run the perf tasks) invoke it directly and
  read the numbers back.

## Architecture

Two layers, mirroring how `get_runtime_profile` already works
(`plugins/debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts`):

- **Measurement engine** = an HTTP endpoint `POST /api/debug/boot-bench/run` on
  every backend. It runs the whole benchmark **in-process in the target
  backend** (so the event-loop histogram and loaders share one process — no
  network noise in the measured window) and returns raw per-iteration arrays.
- **MCP tool** `benchmark_boot` = a thin wrapper that resolves the worktree,
  `fetch`es that endpoint through the gateway
  (`http://<worktree>.localhost:9000/api/debug/boot-bench/run`), aggregates
  `{ min, median, p95 }`, optionally diffs against a baseline, and returns the
  report. Exactly the routing/validation shape of `runtimeProfileTool`.

### New plugin: `plugins/debug/plugins/profiling/plugins/boot-bench/`

Grouped under `profiling` so it sits next to the runtime-profiler MCP tool and
shares its mental model. Server + MCP only (no web pane).

- `shared/endpoints.ts` — `defineEndpoint` for
  `POST /api/debug/boot-bench/run`. Request: `{ iterations?, warmup?,
  mode?: "cold" | "warm" | "both", conversationId?, attemptId? }`. Response:
  per-mode arrays of `{ bootSnapshot: { totalMs, perKey: Record<key,
  { source, workMs }> }, firstSubscribe: Record<key, { onFirstSubscribeMs,
  loaderMs }>, eventLoop: { maxMs, p99Ms, meanMs }, runtimeProfile?: {...} }`,
  plus the resolved `{ conversationId, attemptId }` fixtures.
- `server/internal/eld-probe.ts` — a **dedicated** on-demand event-loop probe
  using `monitorEventLoopDelay({ resolution: 10 })` (a second instance alongside
  health-monitor's is safe — independent native samplers). `resetEldProbe()` /
  `readEldProbe()`. Finer than health-monitor's 10 s sampler; brackets a
  sub-second burst because the histogram accumulates in C even while JS blocks.
- `server/internal/handle-run.ts` — orchestration (see below).
- `server/internal/fixtures.ts` — deterministic fixture resolution via raw SQL on
  `db` (`@plugins/database/server`): newest non-terminal conversation in an
  attempt with a live `worktree_path` (for `edited-files`); attempt with the most
  `pushes` (richest git history, for `commits-graph`). Overridable by request
  params for pinning across before/after.
- `server/index.ts` — registers the route and contributes the MCP tool via
  `Mcp.tool` (`@plugins/infra/plugins/mcp/server`).

### Per-iteration sequence (in `handle-run.ts`, all in-process)

For each iteration (after discarding `warmup` iterations to absorb GC):

1. **cold mode only:** clear the persisted snapshot rows for boot-critical keys
   (the cold definition — see below).
2. `resetEldProbe()` and `resetRuntimeProfile()`
   (`@plugins/infra/plugins/runtime-profiler/core`) to open clean windows.
3. Reproduce the burst with **one `Promise.all`** over independent keys (distinct
   inflight slots → real concurrent loader contention; same-key concurrency would
   wrongly collapse via single-flight):
   - `assembleBootSnapshot()` → `{ resources, timings }` (reused real handler
     body — gives per-key `source`/`workMs` for free).
   - `measureSubscribeCycle("edited-files", { id })`
   - `measureSubscribeCycle("commits-graph.delta", { attemptId })`
   - `measureSubscribeCycle("commits-graph.graph", { attemptId })`
   Wrap each in `performance.now()` brackets for the totals.
4. `readEldProbe()` + `getRuntimeProfile()` → the window's event-loop lag and
   per-op (db/loader/git) breakdown.

### Cold definition (no restart)

`handleBootSnapshot` calls `readPersistedSnapshots(keys)` live on every request
with no in-process cache above the DB; `loadResourceByKey` never re-persists
(persist only happens in `flushNotifies`). So a `DELETE` of the snapshot rows
immediately before the run yields a truly cold boot-snapshot **without a
restart**:

```sql
DELETE FROM live_state_snapshot
WHERE params_key = '{}'
  AND resource_key IN (/* bootCriticalKeys() */);
```

- Boot-critical keys come from `bootCriticalKeys()` — re-exported from
  boot-snapshot's server barrel (it already exists at
  `server/internal/boot-keys.ts`; just surface it) so there is **one** source of
  the set, never a hand-copied filter.
- **Warm mode** runs *before* any cold-clear (snapshot is naturally warm on a
  running backend); if the table starts empty (fresh worktree), warm ≡ cold and
  the report flags it.
- Nothing else is cleared. `live_state_changelog`, the in-flight map, and the
  in-memory read-set index are intentionally left alone (the snapshot endpoint
  doesn't consult the read-set index; touching it would corrupt catch-up).

### First-subscribe: `measureSubscribeCycle` (new generic runtime primitive)

A faithful, *repeatable-cold* first-subscribe must run the real
`onFirstSubscribe → loader → onLastUnsubscribe` cycle, because the per-worktree
git memos (commits-graph's `evictWorktreeFor`, edited-files' room teardown) are
only cleared on last-unsubscribe — `loadResourceByKey` alone would read a warm
memo on iteration 2+.

Add `measureSubscribeCycle(key, params)` to the resource runtime
(`plugins/framework/plugins/resource-runtime/core/runtime.ts`), re-exported from
`@plugins/framework/plugins/server-core/core` alongside `loadResourceByKey`. It
looks up the registry entry, times `await entry.onFirstSubscribe?.(params)` and
`await getResourceValue(entry, params)` (the same path `handleSub` uses), then
runs `entry.onLastUnsubscribe?.(params)` for teardown, and returns
`{ onFirstSubscribeMs, loaderMs }`. Generic and reusable (sibling to
`loadResourceByKey` / `triggerResourcePush`); the benchmark targets resources by
**string key**, so no collection-consumer violation.

**Known footgun to surface (not work around):** commits-graph's
`onLastUnsubscribe` evicts via a **detached** `void worktreeFor(id).then(evict)`,
so the memo isn't guaranteed clear when the next cold iteration starts. v1 guards
with a small bounded settle (a couple of event-loop turns) after each cycle for
resources with async teardown. The structural fix — make `onLastUnsubscribe`
awaitable and have commits-graph await its own eviction — should be filed as a
follow-up (`add_task`), per the "fix the footgun at the source" rule, rather than
memorized.

### Reuse `assembleBootSnapshot()`

Refactor `handle-boot-snapshot.ts`: extract its body into an exported
`assembleBootSnapshot(): Promise<{ resources, timings }>` that the route handler
wraps. boot-bench imports it from the boot-snapshot **server barrel** — zero
reimplementation, identical persisted-vs-loader accounting. (Note in the report:
persisted `workMs` is the batch read amortized `÷ N`, a directional number, not
per-key truth.)

## File-by-file change list

**New** `plugins/debug/plugins/profiling/plugins/boot-bench/`:
- `shared/endpoints.ts` — `bootBenchRun` endpoint contract.
- `server/internal/eld-probe.ts` — `resetEldProbe` / `readEldProbe`.
- `server/internal/fixtures.ts` — `resolveFixtures()`.
- `server/internal/handle-run.ts` — `handleBootBenchRun` (orchestration above).
- `server/internal/aggregate.ts` — min/median/p95 + baseline diff (pure, unit-testable).
- `server/index.ts` — route + `Mcp.tool("benchmark_boot")` (gateway-routing wrapper).

**Modified:**
- `plugins/infra/plugins/boot-snapshot/server/internal/handle-boot-snapshot.ts` —
  extract `assembleBootSnapshot()`.
- `plugins/infra/plugins/boot-snapshot/server/index.ts` — re-export
  `assembleBootSnapshot` and `bootCriticalKeys`.
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — add
  `measureSubscribeCycle`.
- `plugins/framework/plugins/server-core/core/index.ts` (or wherever
  `loadResourceByKey` is surfaced) — re-export `measureSubscribeCycle`.

**Output:** reports written by the agent under `research/perfs/` (create the dir).
The MCP tool returns the JSON; the agent saves the "before" run and passes it (or
its path) back as the baseline for the "after" run to get the diff table.

## Trustworthiness controls (baked into the harness + report header)

- `warmup` iterations discarded before recording (GC settle).
- Iterations run **sequentially**; the report header warns that a concurrent
  `flushNotifies` on a busy backend can re-persist rows mid-run (run on an idle
  target for clean cold numbers).
- Burst uses **distinct keys** under one `Promise.all` (avoids single-flight
  collapse).
- Per-key persisted `workMs` flagged as amortized batch cost, not per-key.
- Report states the scope explicitly: *live-server cold, excludes server-boot
  work*.

## Verification

1. `./equin build` in the worktree; confirm it boots.
2. Run the tool against this worktree:
   `benchmark_boot({ iterations: 10, warmup: 2, mode: "both" })`. Confirm it
   returns resolved fixtures, non-zero `bootSnapshot.totalMs`, both
   `firstSubscribe` keys, and a non-null `eventLoop.maxMs`.
3. Cold-vs-warm sanity: cold `bootSnapshot` per-key sources should be all
   `loader`; warm should be mostly `persisted` and meaningfully faster.
4. Repeatability: two consecutive cold runs should agree within a few %.
5. Before/after: capture a baseline, make a no-op change, re-run with the
   baseline — diff should be ~0, proving the harness itself is stable.
6. Unit-test `aggregate.ts` (percentiles + diff) with `bun test`.

## Out of scope / follow-ups

- **v2 restart-boot scope** (catch-up, derived-table rebuild, pool warm) — needs
  a gateway restart per cold iteration; bracket separately.
- **Structural fix:** make `onLastUnsubscribe` awaitable + commits-graph await
  its own eviction (file via `add_task`).
- Optional later: a `bench` CLI wrapper over the same endpoint, and a Debug pane
  rendering the diff — both trivial once the engine endpoint exists.
