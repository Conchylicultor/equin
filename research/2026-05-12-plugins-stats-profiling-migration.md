# Move stats profiling into the debug profiling plugin

## Context

Stats endpoints are slow to load. We added `Server-Timing` headers to every stats endpoint and an inline profiling panel in the stats page. The user wants this profiling UI consolidated under `plugins/debug/plugins/profiling/` — the existing home for boot and build profiling — instead of living inline in the stats page. This keeps all profiling in one place and reuses the Gantt chart infrastructure.

## Approach

### 1. New sub-plugin: `plugins/debug/plugins/profiling/plugins/stats/`

Create following the exact pattern of `boot` and `build`.

**Server** (`server/index.ts`, `server/internal/handle-stats-profiling.ts`):
- Register `GET /api/debug/profiling/stats`
- The handler calls all ~14 stats endpoints internally via `fetch()` to the local Unix socket (`process.env.SOCKET_PATH`), measuring each with `performance.now()`
- Parse each response's `Server-Timing` header for sub-operation detail
- Convert to `Span[]` format:
  - Each endpoint → one span (`phase` = `"commits"`, `"cost"`, or `"tasks"` based on URL)
  - `startMs` = relative to first fetch start (all fire in parallel via `Promise.all`)
  - `durationMs` = measured fetch time
  - `label` = short endpoint name (e.g. `cost/daily`, `commits/rate`)
  - For server-side detail: add child spans for sub-operations (e.g. `gitLog`, `bundle`, `loadDaily`, `walkSessions`)
- Return `{ spans, totalMs }` matching the existing profiling data shape

The list of stats endpoint URLs to probe:
```
/api/stats/commits/cumulative
/api/stats/commits/rate?bucket=day
/api/stats/commits/lines/cumulative
/api/stats/commits/lines/rate?bucket=day
/api/stats/cost/totals?scope=singularity
/api/stats/cost/daily?scope=singularity
/api/stats/cost/daily-by-family?scope=singularity
/api/stats/cost/cumulative?scope=singularity
/api/stats/cost/token-mix?scope=singularity
/api/stats/cost/sessions?limit=50&scope=singularity
/api/stats/cost/distribution?scope=singularity
/api/stats/cost/avg-per-conversation?scope=singularity
/api/stats/tasks/cumulative
/api/stats/tasks/daily
```

**Web** (`web/index.ts`, `web/components/stats-section.tsx`):
- Contribute `Profiling.Section({ id: "stats", order: 2, component: StatsSection })`
- `StatsSection`: fetch from `/api/debug/profiling/stats`, define phase config for commits/cost/tasks groups, render `<GanttSection>`
- Phase config:
  - `stats:commits` — blue tones
  - `stats:cost` — purple tones
  - `stats:tasks` — green tones

**Package**: `@singularity/plugin-debug-profiling-stats`

### 2. Simplify the stats page

- **Delete** `plugins/stats/web/components/profiling-panel.tsx`
- **`stats-context.tsx`**: Remove `FetchTiming`, `EndpointTiming`, `reportTiming`, `timings`, `showProfiling`, `setShowProfiling`. Keep only `showEmptyDays` state. Remove `useStatsProfiling`.
- **`stats/web/index.ts`**: Remove `useStatsProfiling` and `FetchTiming` exports
- **`chart-primitives.tsx`**: Remove `FetchTiming` type, `parseServerTiming`, timing tracking from `useFetchJson`. Revert to original simple shape returning `{ data, error }`. Remove `useStatsProfiling` import.
- **`stats-panel.tsx`**: Replace `<ProfilingPanel />` with a small link that navigates to `/debug/profiling`. Use `<a href="/debug/profiling">` for cross-app nav (simplest and most reliable).

### 3. Keep server-side instrumentation

All `Server-Timing` headers in cost/commits/tasks handlers stay — they're consumed by the new profiling endpoint and also visible in browser DevTools.

## Files to create

| File | Purpose |
|------|---------|
| `plugins/debug/plugins/profiling/plugins/stats/package.json` | Workspace package |
| `plugins/debug/plugins/profiling/plugins/stats/web/index.ts` | Plugin definition + Profiling.Section contribution |
| `plugins/debug/plugins/profiling/plugins/stats/web/components/stats-section.tsx` | GanttSection consumer |
| `plugins/debug/plugins/profiling/plugins/stats/server/index.ts` | Server plugin + route registration |
| `plugins/debug/plugins/profiling/plugins/stats/server/internal/handle-stats-profiling.ts` | Probe all stats endpoints, return spans |

## Files to modify

| File | Change |
|------|--------|
| `plugins/stats/web/components/stats-context.tsx` | Strip profiling state, keep only showEmptyDays |
| `plugins/stats/web/components/stats-panel.tsx` | Replace ProfilingPanel with nav link |
| `plugins/stats/web/index.ts` | Remove useStatsProfiling, FetchTiming exports |
| `plugins/stats/plugins/commits/web/components/chart-primitives.tsx` | Simplify useFetchJson back to `{ data, error }` |

## Files to delete

| File | Reason |
|------|--------|
| `plugins/stats/web/components/profiling-panel.tsx` | Replaced by profiling sub-plugin |

## Verification

1. `./equin build` — should compile and deploy
2. `./equin check` — all checks pass
3. Navigate to `/debug/profiling` — the Stats section should appear alongside Boot and Build, showing Gantt bars for all 14 stats endpoints grouped by commits/cost/tasks
4. `curl -I /api/stats/cost/totals` — Server-Timing header still present
5. Navigate to `/stats` — small "Profiling" link visible, clicking navigates to `/debug/profiling`
6. `curl /api/debug/profiling/stats` — returns `{ spans, totalMs }` with all endpoints measured
