# Health Monitor — continuous per-backend health/profiling plugin

## Context

The app suffers **inconsistent, bursty slowness**. Live investigation found the cause is *not* the host and *not* worktree disk clutter:

- Host is healthy when slowness occurs: kernel reports ~80% memory free, swap-in/out counters flat over a 10s window (the huge totals are 45-day lifetime).
- The real signal: individual `bun bin/index.ts` backends **balloon to 4.6–6.1 GB RSS within seconds of spawning** (one hit 4.6 GB after 12s uptime; two live at 6.9 GB + 5.7 GB simultaneously; no child build process → the memory is in the bun process itself).
- Consequence: long stop-the-world GC pauses on multi-GB heaps + expensive cold-starts (gateway lazy-spawns a backend on first request, and the sweeper kills idle backends after 10 min, so returning to a worktree re-pays the balloon). This is a textbook "inconsistent slowness" signature.

**Nothing today can see this.** No code measures event-loop lag. The `contention` plugin is point-in-time (load-avg + PG backend counts only, captured only when a slow-op fires). `get_runtime_profile` reads the live backend *through the gateway*, so it **404s precisely when a backend is unhealthy** — useless when the backend is the thing stalling.

**Goal:** a durable, continuous health monitor that records per-backend event-loop lag, GC/heap pressure, and RSS over time (plus host metrics), written **out-of-band** so it survives a wedged backend, and surfaced as a Debug pane with per-backend timeline charts.

**Out of scope (separate tasks already filed):**
- Root-causing *why* a backend hits 6 GB — `task-1781768780037-8ysh1g`.
- v2 on-chart overlay of slow-op latency markers — `task-1781768784397-uvqo1u`. v1 ships charts + a slow-ops list beside them for manual correlation.

## Key design decisions (validated against the codebase + empirical Bun test)

1. **New plugin `plugins/debug/plugins/health-monitor/`** — do *not* extend `contention` (it's a tight leaf consumed by `slow-ops`).
2. **Storage = JSONL on disk, no DB table.** Each backend appends samples via `Log.channel("health", { persist: true })` → synchronous `appendFileSync` to `~/.singularity/worktrees/<wt>/logs/health.jsonl`. This has zero dependency on the DB/WS/event-loop scheduling and survives a wedged backend — which is exactly the failure state we must observe. A DB table would need a migration + prune job and would fail to write when the backend is stalled.
3. **Read path runs on `main` and reads every worktree's JSONL straight from disk** (all worktree logs share one disk). The pane never reaches a possibly-wedged worktree backend → avoids the `get_runtime_profile` 404 failure mode entirely.
4. **Sampler = `setInterval` (~10s) in `onReady`, cleared in `onShutdown`** — graphile cron is 5-field (1-min min), too coarse, and a job-queue task can't run when the event loop is wedged. Precedent: `jobs/server/internal/stuck-lock-sweeper.ts` (mirror its "why setInterval, not defineJob" comment). The event-loop-lag histogram records natively in C even while JS is blocked, so a *late* tick is itself signal.
5. **Bun runtime caveats (empirically confirmed on Bun 1.3.x):**
   - `perf_hooks.monitorEventLoopDelay({ resolution: 10 })` **works** — `.percentile()`, `.max`, `.reset()` all functional. Values are **nanoseconds** → divide by `1e6`.
   - GC `PerformanceObserver({ entryTypes: ['gc'] })` is **silently broken** (`PerformanceObserver.supportedEntryTypes` lacks `'gc'`; never fires). Use `bun:jsc` `memoryUsage().current` heap deltas between ticks as the GC-pressure proxy ("heap growth per interval"). Keep the `PerformanceObserver` path behind a `supportedEntryTypes.includes('gc')` feature-check for forward-compat / Node.
6. **No live-state resource in v1** — JSONL-from-disk (≤10s stale) is sufficient and robust; a `useResource` push path can't reach a wedged backend anyway.

## Files to create

All under `plugins/debug/plugins/health-monitor/`. Respect boundary rules (one barrel per runtime; cross-plugin imports only via runtime barrels).

### shared/
- **`shared/schema.ts`** — Zod schemas: `HealthSampleSchema` (`sampledAt`, `worktree`, `eventLoopP50Ms`, `eventLoopP99Ms`, `eventLoopMaxMs`, `rssMb`, `heapUsedMb`, `heapTotalMb`, `heapCurrentMb`, `heapGrowthMb`, `gcPreciseCount`, `gcPreciseTotalMs`), `HostSampleSchema` (`sampledAt`, `freeMemMb`, `totalMemMb`, `usedMemMb`, `loadAvg1/5/15`, `swapInPagesPerSec`, `swapOutPagesPerSec`, `compressorMb`), `HealthSeriesSchema` (`worktree`, `samples[]`), `GetHealthDataResponseSchema` (`series[]`, `hostSamples[]`, `windowMs`).
- **`shared/endpoints.ts`** — `getHealthData = defineEndpoint({ route: "GET /api/debug/health-monitor", query: z.object({ windowMs: z.coerce.number().optional() }), response: GetHealthDataResponseSchema, dedupe: true })`.
- **`shared/index.ts`** — barrel re-exporting the plugin's own `schema.ts` + `endpoints.ts`.

### server/
- **`server/internal/process-sampler.ts`** — `startProcessSampler()` / `stopProcessSampler()`. Module-load: `const histogram = monitorEventLoopDelay({ resolution: 10 })`; `histogram.enable()`; try-import `bun:jsc` for `memoryUsage()`; conditionally install GC observer if `supportedEntryTypes.includes('gc')`. Each 10s tick: read percentiles (`/1e6`), `process.memoryUsage()` (rss/heap, `/1_048_576`), JSC heap current + delta vs `lastHeapBytes`, then `histogram.reset()`; build a `HealthSample`; `Log.channel("health", { persist: true }).publish(JSON.stringify(sample))`. **Size-based rotation**: before append, `statSync` the file; if > 5 MB, rewrite with the tail half. Carry the `stuck-lock-sweeper`-style comment explaining why `setInterval` (not `defineJob`).
- **`server/internal/host-sampler.ts`** — `startHostSampler()` / `stopHostSampler()`, **main-only**. Each tick: `os.freemem/totalmem/loadavg`; on `darwin`, `Bun.spawn(['vm_stat'])` → parse `Pageins`/`Pageouts`/`Pages occupied by compressor`, compute per-second deltas vs module state; non-darwin → swap fields 0. Append via `Log.channel("health-host", { persist: true })` (writes to `singularity` worktree's `logs/health-host.jsonl`).
- **`server/internal/read-health-files.ts`** — `readHealthSeries(windowMs)`. `readdirSync(join(SINGULARITY_DIR, "worktrees"))`, filter to directories (skip `att-*.json` sidecars). For each, use `readChannelEntries(worktree, "health", MAX_LINES=1500)` from log-channels (it already unwraps the JSONL envelope), then `JSON.parse(entry.line)` → `HealthSampleSchema.safeParse` (drop invalid), filter `sampledAt >= Date.now() - windowMs`. Repeat for `health-host` in the `singularity` dir. Returns `{ series, hostSamples }`.
- **`server/internal/handle-health-data.ts`** — `implement(getHealthData, async ({ query }) => { const windowMs = query.windowMs ?? 7_200_000; return { ...readHealthSeries(windowMs), windowMs }; })`.
- **`server/index.ts`** — `httpRoutes: { [getHealthData.route]: handleHealthData }`; `onReady: () => { startProcessSampler(); if (isMain()) startHostSampler(); }`; `onShutdown: () => { stopProcessSampler(); if (isMain()) stopHostSampler(); }`. No `dependsOn`.

### web/
- **`web/panes.tsx`** — `healthMonitorPane = Pane.define({ id: "debug-health-monitor", segment: "health", component: HealthMonitorBody })`; body wraps `<PaneChrome title="Health Monitor"><HealthMonitorPanel/></PaneChrome>`.
- **`web/index.ts`** — contributions: `Pane.Register({ pane: healthMonitorPane })` + `DebugApp.Sidebar({ id: "health-monitor", ...sidebarNavItem({ title: "Health", icon: MdSpeed, onClick: () => openPane(healthMonitorPane, {}, { mode: "root" }) }) })`. (Use an icon distinct from live-state-health's `MdMonitorHeart`.)
- **`web/components/health-monitor-panel.tsx`** — `useEndpoint(getHealthData, {}, { query: { windowMs }, refetchInterval: 10_000 })`. Host strip (load 1/5/15, free-mem, swap rate) when `hostSamples` present. One section per `series` entry: line charts for (1) event-loop p99 + max ms, (2) RSS + heap-used MB, (3) heap-growth/interval MB. Below: a top-5 slow-ops list (`useResource(slowOpsResource)`) with `lastSeenAt` for manual correlation (v2 overlay = `task-1781768784397-uvqo1u`). `windowMs` `SegmentedControl` (30m / 2h / 8h). X-axis = `sampledAt`, formatted `HH:mm:ss`.
- **`web/components/use-health-window.ts`** — small `useState` hook for the window selector.

### No `tables.ts`, no migration, no prune `defineJob`.

## Reuse (do not reinvent)
- `Log.channel(id, { persist: true })` + `readChannelEntries` — `@plugins/primitives/plugins/log-channels/server` (durable JSONL append + envelope-aware read).
- `currentWorktreeName()`, `isMain()`, `SINGULARITY_DIR` — `@plugins/infra/plugins/paths/server`.
- `defineEndpoint` / `implement` / `useEndpoint` — endpoints primitive.
- `Pane.define`/`Pane.Register`/`openPane`/`PaneChrome`, `DebugApp.Sidebar`, `sidebarNavItem` — mirror `plugins/debug/plugins/live-state-health` and `.../memory`.
- recharts chart primitives (`ChartState`, `axisProps`, `gridProps`, `lineCursor`, `tooltipContentStyle`, `tooltipLabelStyle`, `fillGaps`, `yAxisFormatter`) — `@plugins/stats/plugins/commits/web`. Do **not** add a recharts dependency.
- `slowOpsResource` — `@plugins/debug/plugins/slow-ops/server` (re-read via web barrel) for the v1 slow-ops list.
- Structural precedent for `setInterval`-in-`onReady`: `plugins/infra/plugins/jobs/server/internal/stuck-lock-sweeper.ts`.

## Verification (end-to-end)
1. `./equin build` (run from this worktree). Confirm boot logs show the sampler starting.
2. After ~20s: `tail -f ~/.singularity/worktrees/singularity/logs/health.jsonl` — one JSON line / 10s with `rssMb`, `eventLoopP99Ms`, etc. And `health-host.jsonl` with `swapInPagesPerSec`, `freeMemMb`, `loadAvg1`.
3. Open **Debug → Health**. Confirm per-backend charts render and the host strip shows load/mem/swap.
4. **Balloon test:** hit a heavy endpoint in another worktree repeatedly; watch its RSS line climb in the pane.
5. **Event-loop test:** trigger a sync-heavy op; confirm `eventLoopP99Ms` spikes on the next sample.
6. **Wedged-backend robustness:** `kill -9 <worktree backend pid>`. Confirm the pane (served by main) still shows that worktree's historical series from disk, the endpoint does **not** 404, and new samples simply stop (stale last-timestamp = its own signal).
7. `./equin check` clean (boundaries, types).

## Risks / notes
- Bun GC observer unavailable → GC pressure is approximated by JSC heap-growth, not precise pause timing; label the chart "heap growth / interval", not "GC pause ms".
- `vm_stat` is macOS-only; swap fields are 0 elsewhere (host is the user's Mac — acceptable).
- Sampler adds one `appendFileSync` + (main only) one `vm_stat` spawn per 10s — negligible vs the multi-GB backends being measured.
