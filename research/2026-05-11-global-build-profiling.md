# Build Step Profiling — Unified with Boot Gantt

## Context

`./equin build` runs ~20 sequential steps (install, codegen, checks, tsc, vite, restart, health probe) with zero timing instrumentation. Meanwhile, the server has a profiler (`server/src/profiler.ts`) that records boot spans, and the debug/profiling plugin renders them in a Gantt chart. The two should be unified so a single view shows the full lifecycle: build → boot.

## Approach

Instrument the build CLI with a lightweight span tracker, persist the results to disk, and have the existing profiling endpoint merge build spans with server startup spans before serving them to the Gantt.

No new plugin — the changes extend the existing profiling plugin and add a CLI utility.

## Implementation

### 1. CLI profiler — `cli/src/profiler.ts` (new)

Lightweight standalone module (the CLI can't import from `server/`). Same conceptual API as the server profiler.

```ts
interface BuildSpan {
  id: string;
  phase: string;        // "build:setup", "build:codegen", etc.
  label: string;
  startMs: number;      // ms since build start
  durationMs: number;
}

interface BuildProfile {
  spans: BuildSpan[];
  totalDurationMs: number;
}
```

Module-level state: `t0 = performance.now()`, `spans: BuildSpan[]`.

Exports:
- `buildProfilerStart(id: string, phase: string, label: string): () => void` — captures start time, returns closer that pushes span.
- `writeBuildProfile(name: string): void` — atomically writes `~/.singularity/worktrees/<name>-build-profile.json`.

The `writeBuildProfile` uses `WORKTREES_DIR` from `cli/src/paths.ts` (promote the local const from `build.ts`).

### 2. Promote `WORKTREES_DIR` — `cli/src/paths.ts` (modify)

Add: `export const WORKTREES_DIR = join(SINGULARITY_DIR, "worktrees");`

Update `build.ts` to import from paths instead of declaring locally.

### 3. Instrument build steps — `cli/src/commands/build.ts` (modify)

Import `buildProfilerStart` and `writeBuildProfile` from `../profiler`.

Seven build phases, grouping related steps:

| Phase | Steps |
|-------|-------|
| `build:preflight` | ensureHooksPath, registerMergeDrivers, branch guard, checkBroadcasts, name validation |
| `build:setup` | acquireBuildLock, sweepStagingLeftovers, bun install |
| `build:codegen` | generatePluginRegistry, writeCentralRoutesManifest, write central.json |
| `build:database` | waitForPg, waitForDatabase, generateMigration |
| `build:validation` | generatePluginDocs, runChecks, tsc server, tsc central |
| `build:frontend` | Vite build, atomic publish |
| `build:deploy` | register worktree, central restart, backend restart, probeHealth |

Each step gets its own span within the phase. Pattern:

```ts
const end = buildProfilerStart("bunInstall", "build:setup", "bun install");
await exec(["bun", "install"], root);
end();
```

Call `writeBuildProfile(name)` at the very end, after the "Deployed" log. Also call it before the `--no-restart` early return. On `process.exit(1)` failures, the profile is not written (acceptable — partial build profiles aren't useful).

### 4. Server reads build profile — `server/src/profiler.ts` (modify)

Add a function to read the build profile sidecar:

```ts
export function getBuildProfilingData(): BuildProfile | null
```

- Reads `~/.singularity/worktrees/${process.env.SINGULARITY_WORKTREE}-build-profile.json`
- Returns null if file missing or parse fails
- Uses `SINGULARITY_DIR` from `@plugins/infra/plugins/paths/server` (or inline the path — check what's available)

Add a merged getter:

```ts
export function getMergedProfilingData(): MergedProfilingData
```

Returns `{ buildSpans, serverSpans, buildTotalMs, serverTotalMs }` — keeping them separate so the frontend can render two time axes cleanly. The server spans come from existing `getProfilingData()`, the build spans from the sidecar file.

### 5. Update handler — `plugins/debug/plugins/profiling/server/internal/handle-profiling.ts` (modify)

Switch from `getProfilingData()` to `getMergedProfilingData()`. The response shape changes to:

```ts
{
  buildSpans: BuildSpan[];
  buildTotalMs: number;
  serverSpans: Span[];
  serverTotalMs: number;
}
```

### 6. Update Gantt — `plugins/debug/plugins/profiling/web/components/gantt-view.tsx` (modify)

**Data model**: Update `ProfilingData` to match the new response shape with two span arrays and two durations.

**Rendering**: Two sections with independent time axes, separated by a labeled divider:

1. **Build section** — header "Build" with `buildTotalMs`, its own `TimeAxis`, then phase groups for `build:*` phases.
2. **Divider** — thin horizontal rule with label.
3. **Server section** — header "Server Boot" with `serverTotalMs`, its own `TimeAxis`, then the existing server phase groups.

Each section's bars are positioned relative to their own `totalMs`, so no cross-process time stitching is needed.

**Phase config**: Add 7 new entries to `PHASE_ORDER`, `PHASE_LABELS`, `PHASE_COLORS`, `PHASE_BG`. Use a warm color ramp for build phases (rose → orange → amber → yellow → lime → green → teal) to visually distinguish from the existing blue/sky/purple/emerald server phases.

**Empty states**: If no build spans, show only server section (current behavior). If no server spans, show only build section. Both present → show both with divider.

**Header**: Change from fixed "Boot time: Xms" to showing both when available: "Build Xms · Boot Yms".

### 7. Update pane title — `plugins/debug/plugins/profiling/web/panes.tsx` (modify)

Change `title="Boot Profiling"` to `title="Profiling"`.

Update `plugins/debug/plugins/profiling/web/index.ts` if it contributes a Debug.Item title too (change "Boot Profiling" → "Profiling").

## Files

| File | Action |
|------|--------|
| `cli/src/profiler.ts` | **Create** — build span tracker + writer |
| `cli/src/paths.ts` | **Modify** — export `WORKTREES_DIR` |
| `cli/src/commands/build.ts` | **Modify** — instrument steps, import profiler, call `writeBuildProfile` |
| `server/src/profiler.ts` | **Modify** — add `getBuildProfilingData()`, `getMergedProfilingData()` |
| `plugins/debug/plugins/profiling/server/internal/handle-profiling.ts` | **Modify** — use merged data |
| `plugins/debug/plugins/profiling/web/components/gantt-view.tsx` | **Modify** — dual-section rendering, new phases |
| `plugins/debug/plugins/profiling/web/panes.tsx` | **Modify** — rename title |
| `plugins/debug/plugins/profiling/web/index.ts` | **Modify** — rename Debug.Item title |

## Verification

1. Run `./equin build` — check `~/.singularity/worktrees/<name>-build-profile.json` is written with correct spans
2. Open `http://<worktree>.localhost:9000/debug/profiling` — should see both Build and Server Boot sections
3. Verify each build step has a non-zero duration
4. Verify Refresh button still works
5. Run `./equin build --no-restart` — profile should still be written (minus deploy spans)
6. Run `./equin build --skip-checks` — checks span should be absent
