# Per-Run Build Profiling in Build Detail Pane

## Context

The build detail pane (`/r/:runId`) shows info and logs for each build run, but lacks profiling data. The profiling Gantt chart exists only in the debug pane, showing the *latest* build's trace (a singleton file overwritten each build). We want:

1. **Per-run archival** — so historical builds retain their profiling trace
2. **A profiling section** in the build detail pane — reusing the existing Gantt primitives

## Design

### Per-run profile archiving

After each build process exits, copy the singleton profile file to a per-run archive.

**File**: `plugins/build/server/internal/run-build.ts`

In `doRunBuild`, after `const exitCode = await proc.exited` (line 65) and before the DB update (line 68), add:

```ts
const worktreeName = process.env.SINGULARITY_WORKTREE;
if (worktreeName) {
  const profileDir = join(SINGULARITY_DIR, "worktrees");
  const src = join(profileDir, `${worktreeName}-build-profile.json`);
  const dst = join(profileDir, `${worktreeName}-build-profile-${buildId}.json`);
  try { copyFileSync(src, dst); } catch { /* no profile — that's fine */ }
}
```

New imports: `copyFileSync` from `node:fs`, `join` from `node:path`, `SINGULARITY_DIR` from `@plugins/infra/plugins/paths/server`.

**Why file-based**: No schema changes, keeps `buildHistoryResource` payload lean (serves 50 runs), the data is already a file — we're just snapshotting it. Three lines in the one place that owns the build lifecycle.

### New sub-plugin: `plugins/build/plugins/build-profiling/`

```
plugins/build/plugins/build-profiling/
  package.json
  CLAUDE.md
  server/
    index.ts                                # route registration
    internal/
      handle-build-run-profiling.ts         # reads per-run archive
  web/
    index.ts                                # BuildDetailSlots.Section contribution
    components/
      build-profiling-section.tsx           # Gantt chart for a specific run
```

#### Server endpoint

`GET /api/build/runs/:id/profile`

Reads `~/.singularity/worktrees/<SINGULARITY_WORKTREE>-build-profile-<id>.json`. Returns `{ spans: Span[], totalMs: number }`. Returns empty spans if file missing (pre-feature builds).

Pattern: mirrors `plugins/debug/plugins/profiling/plugins/build/server/internal/handle-build-profiling.ts` but parameterized by build run ID extracted from the URL path.

#### Web component

`BuildProfilingSection` receives `{ runId: string }` from `BuildDetail.Host`:

1. Fetches `/api/build/runs/${runId}/profile`
2. Wraps in `ProfilingContext.Provider` (required — `GanttSection` calls `useProfilingContext()`)
3. Renders `GanttSection` + `SpanDetail`
4. Returns `null` when no profile exists

Imports from `@plugins/debug/plugins/profiling/web`: `GanttSection`, `SpanDetail`, `ProfilingContext`, `groupByPhase`, `Span`, `PhaseConfig`.

`PHASE_ORDER` and `PHASE_CONFIG` are duplicated locally (same as the debug `BuildSection`). These are static CLI-phase constants — extracting them would create coupling between unrelated plugins for minimal benefit.

`refreshKey: 0` in the context provider — build profiles are immutable once written, no refresh cycling needed.

### Files modified

| File | Change |
|------|--------|
| `plugins/build/server/internal/run-build.ts` | Add 3-line profile archive after `proc.exited` + imports |

### Files created

| File | Purpose |
|------|---------|
| `plugins/build/plugins/build-profiling/package.json` | Package manifest |
| `plugins/build/plugins/build-profiling/CLAUDE.md` | Plugin docs |
| `plugins/build/plugins/build-profiling/server/index.ts` | Route: `GET /api/build/runs/:id/profile` |
| `plugins/build/plugins/build-profiling/server/internal/handle-build-run-profiling.ts` | Read per-run archive file |
| `plugins/build/plugins/build-profiling/web/index.ts` | `BuildDetailSlots.Section` contribution |
| `plugins/build/plugins/build-profiling/web/components/build-profiling-section.tsx` | Gantt chart component |

### Key reuse

- `GanttSection`, `SpanDetail`, `ProfilingContext`, `groupByPhase`, `formatDuration` from `@plugins/debug/plugins/profiling/web`
- `BuildDetailSlots.Section` from `@plugins/build/web`
- `SINGULARITY_DIR` from `@plugins/infra/plugins/paths/server`
- Exact plugin structure pattern from `plugins/build/plugins/build-info/`

## Verification

1. `./equin build` — triggers a build, should create `~/.singularity/worktrees/<name>-build-profile-<buildId>.json`
2. Open build detail pane for the completed run — profiling section should render the Gantt chart
3. Open build detail for an older run (pre-feature) — section should not render (returns null)
4. Verify the debug profiling pane still works (singleton file untouched)
