# Health Monitor v2 — overlay slow-op latency spikes on the per-backend charts

## Context

The health-monitor debug pane (Debug → Health) ships v1 per-backend line charts —
event-loop p99/max, RSS/heap, heap-growth — plus host load/swap, all on a shared
wall-clock X axis (`sampledAt`, epoch ms). To diagnose a UI freeze today you read
the charts and a separate slow-ops list and correlate timestamps by eye.

v2 draws the slow-op latency spikes **directly onto the metric charts**, on the
same time axis, so a freeze lines up visually with the event-loop / GC / RSS spike
that caused it. Each spike is a thin vertical `ReferenceLine` at the slow-op's
timestamp, color-ramped by host load saturation.

### The data-source problem (and the chosen answer)

The health pane charts **every** backend: the `GET /api/debug/health-monitor`
endpoint is served by the **main** backend and reads each worktree's
`~/.singularity/worktrees/<wt>/logs/health.jsonl` straight from disk (works even
when a worktree backend is wedged). Slow-op timing, however, lives **per-worktree
in each fork's Postgres DB** (`slow_ops.recentSamples`). The only cross-worktree
access is the `getSlowOpsCluster` fan-out, which is deliberately pull-only and
"too heavy to poll".

**Chosen approach (user-confirmed): a live per-worktree JSONL channel.** The
slow-op recorder dual-writes each captured sample to a persisted log channel, and
the health endpoint reads it from disk *exactly the way it already reads
`health.jsonl`*. This mirrors the existing health-sample flow precisely (disk
read on main, per-worktree, resilient to wedged backends), covers every backend
section, refreshes on the same 10s poll, and is complete within the window (not
capped at the DB ring's newest 10).

## Approach

Producer side (slow-ops): publish a slim marker per recorded slow op to a new
persisted channel. Reader side (health-monitor): read that channel per worktree,
attach markers to each `HealthSeries`, draw a severity-colored `ReferenceLine`
per marker on every chart in the backend section.

## Changes

### 1. slow-ops core — the marker contract + shared severity ramp

`plugins/debug/plugins/slow-ops/core/resources.ts` (export via `core/index.ts`):

- Add `SlowOpMarkerSchema` / `SlowOpMarker` — the web-safe overlay shape (a slim
  projection of a sample, no full contention snapshot):
  ```ts
  export const SlowOpMarkerSchema = z.object({
    atTime: z.coerce.date(),        // wall-clock instant the span tripped
    durationMs: z.number(),
    operationKind: z.string(),
    operation: z.string(),
    loadAvg1: z.number(),           // for the severity ramp
    cpuCount: z.number(),
  });
  export type SlowOpMarker = z.infer<typeof SlowOpMarkerSchema>;
  ```
- Extract the load-saturation ramp into core as the **single source of truth**
  (currently duplicated as `loadVariant` inside `cluster/web/components/cluster-view.tsx`):
  ```ts
  // ≥1.5× cores = saturated (warning), ≥2.5× = severe (destructive).
  export function loadSeverity(loadAvg1: number, cpuCount: number):
    "muted" | "warning" | "destructive" { ... }
  ```
  Then refactor `cluster-view.tsx` to import `loadSeverity` from
  `@plugins/debug/plugins/slow-ops/core` and delete its local `loadVariant`
  (behavior identical; thresholds 1.5/2.5 now live in one place).

### 2. slow-ops server — dual-write each sample to a persisted channel

`plugins/debug/plugins/slow-ops/server/internal/record-slow-op.ts`:

- Add a module-level channel, mirroring the health sampler's
  `Log.channel("health", { persist: true })`:
  ```ts
  const markerChannel = Log.channel("slow-op-markers", { persist: true });
  ```
  (`Log` from `@plugins/primitives/plugins/log-channels/server`.)
- Inside `recordSlowOp`, after the snapshot + transaction, publish one marker
  (every recorded slow op produces one line — uncapped, unlike the 10-entry ring):
  ```ts
  markerChannel.publish(JSON.stringify({
    atTime: new Date(), durationMs, operationKind, operation,
    loadAvg1: snapshot.loadAvg1, cpuCount: snapshot.cpuCount,
  } satisfies SlowOpMarker));
  ```
  Each worktree backend writes to its own `logs/slow-op-markers.jsonl` (the
  recorder already keys everything to `process.env.SINGULARITY_WORKTREE`).

New reader `plugins/debug/plugins/slow-ops/server/internal/read-markers.ts`
(exported from `server/index.ts`), mirroring health-monitor's `parseSamples`:
```ts
export function readSlowOpMarkers(worktree: string, windowMs: number): SlowOpMarker[]
```
Uses `readChannelEntries(worktree, "slow-op-markers", MAX_LINES)`, `JSON.parse`s
each envelope's `.line`, validates with `SlowOpMarkerSchema.safeParse`, filters to
`atTime >= Date.now() - windowMs`.

### 3. health-monitor shared — carry markers on each series

`plugins/debug/plugins/health-monitor/shared/schema.ts`:
- Import `SlowOpMarkerSchema` from `@plugins/debug/plugins/slow-ops/core` (legal:
  shared → other plugin's core barrel).
- Add to `HealthSeriesSchema`: `slowOpMarkers: z.array(SlowOpMarkerSchema)`.

### 4. health-monitor server — read markers alongside health samples

`plugins/debug/plugins/health-monitor/server/internal/read-health-files.ts`:
- In the per-worktree loop, after building `samples`, call
  `readSlowOpMarkers(name, windowMs)` (from
  `@plugins/debug/plugins/slow-ops/server`) and include it on the pushed series:
  `series.push({ worktree: name, samples, slowOpMarkers })`. Markers are attached
  only when the worktree has health samples (no chart ⇒ nowhere to draw), which is
  the existing `if (samples.length)` gate.

### 5. health-monitor web — draw the spike lines

`plugins/debug/plugins/health-monitor/web/components/health-monitor-panel.tsx`:
- `MetricChart` gains a `markers?: SpikeMarker[]` prop and renders one
  `ReferenceLine` per marker inside the `<LineChart>`, **before** the `<Line>`s so
  the data lines paint on top:
  ```tsx
  import { ReferenceLine } from "recharts";
  ...
  {markers?.map((m) => (
    <ReferenceLine key={m.key} x={m.x} stroke={m.color}
      strokeWidth={1} strokeOpacity={0.7} ifOverflow="hidden" />
  ))}
  ```
  `x={m.x}` is `atTime.getTime()` — same numeric ms scale as the `sampledAt` axis,
  so recharts aligns it automatically.
- Severity → stroke color (presentational, local to this file): map
  `loadSeverity(m.loadAvg1, m.cpuCount)` → `muted → var(--muted-foreground)`,
  `warning → var(--warning)`, `destructive → var(--destructive)`.
- **Coalesce to bound the DOM + align with the sample grid:** a chatty op can
  emit hundreds of markers over 2h. In `BackendSection`, bucket markers to the
  10s sample interval (`Math.round(atTime/10000)*10000`), one line per non-empty
  bucket at the bucket time, colored by the **worst** severity in the bucket. This
  keeps a dense storm reading as a thick colored band (the desired signal) without
  rendering hundreds of DOM nodes. Build the bucketed `SpikeMarker[]` in the
  existing `useMemo`.
- Pass the same `markers` to all three `ChartBlock`s in `BackendSection`
  (event-loop, memory, heap-growth) so a freeze lines up across every metric.
  Host charts get no markers (host is not a backend).
- Op label: render a recharts `<Label>` (vertical, small, muted) only on
  `destructive`-severity lines to name the worst offenders without cluttering the
  common case; lesser markers are color-only.

## Critical files

- `plugins/debug/plugins/slow-ops/core/resources.ts` — `SlowOpMarker` + `loadSeverity`
- `plugins/debug/plugins/slow-ops/core/index.ts` — exports
- `plugins/debug/plugins/slow-ops/server/internal/record-slow-op.ts` — dual-write
- `plugins/debug/plugins/slow-ops/server/internal/read-markers.ts` — **new** reader
- `plugins/debug/plugins/slow-ops/server/index.ts` — export `readSlowOpMarkers`
- `plugins/debug/plugins/slow-ops/plugins/cluster/web/components/cluster-view.tsx` — use shared `loadSeverity`
- `plugins/debug/plugins/health-monitor/shared/schema.ts` — `slowOpMarkers` on series
- `plugins/debug/plugins/health-monitor/server/internal/read-health-files.ts` — attach markers
- `plugins/debug/plugins/health-monitor/web/components/health-monitor-panel.tsx` — `ReferenceLine` overlay

## Reused, not rebuilt

- `Log.channel(name, { persist: true })` + `channel.publish(JSON.stringify(...))`
  — identical to `process-sampler.ts`'s health channel.
- `readChannelEntries(worktree, channel, MAX_LINES)` and the `parseSamples`
  envelope-parse/validate/window-filter shape — mirror from
  `read-health-files.ts`.
- The 1.5×/2.5×-cores load-saturation ramp — promoted from the cluster view's
  `loadVariant` to a single `loadSeverity` in slow-ops core.
- The numeric `sampledAt` time axis (`type="number"`, `domain=["dataMin","dataMax"]`,
  `fmtTime`) already in place — markers use the same ms scale, no axis changes.

## Verification

1. `./equin build` (regenerates the slow-ops marker channel; no migration —
   the JSONL channel is not a DB table). Confirm a clean build + checks pass
   (`plugin-boundaries`, `type-check`, `plugins-doc-in-sync`).
2. Generate slow ops: load a few heavy panes / refresh the slow-ops cluster a
   couple times so the recorder fires, or query `slow_ops` via the `query_db` MCP
   tool to confirm rows exist. Verify the new file exists:
   `~/.singularity/worktrees/<wt>/logs/slow-op-markers.jsonl` has JSON lines with
   `atTime`/`durationMs`/`operationKind`.
3. Open `http://<worktree>.localhost:9000` → Debug → Health. Scripted check with
   `e2e/screenshot.mjs` (or `bun run playwright screenshot`) of the health pane:
   confirm vertical severity-colored lines appear on the backend charts at the
   slow-op timestamps, aligned across the event-loop / memory / heap-growth charts
   of the same backend, and absent from the host section.
4. Confirm a wedged/idle worktree with no slow ops shows charts with **no**
   markers (empty `slowOpMarkers`), and that the existing cluster view still
   renders its `load1/cpu` badges correctly after the `loadSeverity` refactor.
5. Optional: `bun test plugins/debug/plugins/slow-ops` and
   `bun run test:dom plugins/debug/plugins/health-monitor` if/where co-located
   tests exist (add a small unit test for `readSlowOpMarkers` window-filtering and
   for the web bucketing helper).
