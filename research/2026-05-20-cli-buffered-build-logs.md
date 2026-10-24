# Buffered Parallel Build Output + Persisted Build Logs

## Context

The build pipeline (`./equin build`) runs 4 steps in parallel — checks, tsc server, tsc central, vite build. All four use `stdout: "inherit"`, so their output interleaves on the terminal. Vite's hundreds of asset lines mix with tsc/ESLint errors, making failures hard to diagnose. Three problems to solve:

1. **Buffer output** — each parallel step captures stdout/stderr and prints a labeled block on completion
2. **Persist logs** — per-step logs saved to disk alongside the build profile, queryable per-run
3. **Surface in UI** — the `build-logs` sub-plugin shows persisted per-step logs for completed builds

## Part 1: Buffered CLI Output

### Files to modify

- `plugins/framework/plugins/cli/bin/commands/build.ts` — add `execBuffered`, refactor parallel section
- `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` — add `log` callback to `RunChecksOptions`

### Design

**New `execBuffered` function** (add after existing `execOrThrow` at line 204):
- Same signature as `execOrThrow` but uses `stdout: "pipe"`, `stderr: "pipe"`
- Collects lines into `Array<{ text: string; stream: "stdout" | "stderr" }>`
- Uses `TextDecoder` with `{ stream: true }` and a partial-line accumulator for correct UTF-8 handling
- Returns `{ lines, exitCode }` instead of throwing

**Add `log` callback to `RunChecksOptions`** in `runner.ts`:
```typescript
export interface RunChecksOptions {
  onCheckDone?: (id: string, durationMs: number, wallStartMs: number) => void;
  log?: (line: string, stream: "stdout" | "stderr") => void;
}
```
Replace the 5 `console.log`/`console.error` calls in `runChecks` (lines 122-134) with `(options?.log ?? defaultLog)`. The check-loader `console.warn` calls (lines 65, 72, 76) are infrastructure warnings and stay as-is.

**Refactored parallel section** (lines 606-656):

Each step resolves to a `StepResult` rather than throwing on failure:
```typescript
interface StepResult {
  id: string;       // e.g. "checks", "tscServer", "tscCentral", "viteBuild"
  label: string;    // e.g. "checks", "tsc server", "tsc central", "vite build"
  lines: Array<{ text: string; stream: "stdout" | "stderr" }>;
  durationMs: number;
  success: boolean;
}
```

- For tsc/vite: call `execBuffered`, wrap with profiler `buildProfilerStart`/`end()`
- For checks: pass `log` callback that pushes to a local `lines` array
- Use `Promise.all` (not `allSettled`) since failures are encoded in `StepResult.success`

After all steps resolve, print labeled blocks sequentially:
```
── checks ✓ (3.2s) ──────────────────────────────────────
  • eslint ... ok
  • migrations-in-sync ... ok
── tsc server ✓ (2.1s) ──────────────────────────────────
── vite build ✓ (7.4s) ──────────────────────────────────
  dist/assets/index-abc123.js    142 kB
```

Failed steps show `✗` and their output:
```
── checks ✗ (3.5s) ──────────────────────────────────────
  • eslint ... FAIL
    src/foo.ts:12 error no-unused-vars ...
```

After printing, collect failures and exit as before. The existing `buildProfilerStart`/`end()` calls remain unchanged — they wrap step execution, not printing.

## Part 2: Persist Build Logs to Disk

### New file

- `plugins/framework/plugins/cli/bin/build-logs-writer.ts`

### Design

Mirror the exact structure of `profiler.ts`:
- Module-level `steps: BuildStepLog[]` array
- `pushBuildStepLog(step)` — appends to array
- `writeBuildLogs(name)` — writes to `~/.singularity/worktrees/<name>-build-logs.json` using the same atomic tmp+rename pattern as `writeBuildProfile`

Format:
```typescript
interface BuildStepLog {
  id: string;
  label: string;
  lines: Array<{ text: string; stream: "stdout" | "stderr" }>;
  durationMs: number;
  success: boolean;
}

interface BuildLogs {
  steps: BuildStepLog[];
}
```

### Wiring

In `build.ts`:
- After `Promise.all`, call `pushBuildStepLog(result)` for each step result
- At both `writeBuildProfile(name)` call sites (lines 733 and 769), add `writeBuildLogs(name)` immediately after

In `plugins/build/server/internal/run-build.ts` (line 75, after profile copy):
```typescript
const logsSrc = join(profileDir, `${worktreeName}-build-logs.json`);
const logsDst = join(profileDir, `${worktreeName}-build-logs-${buildId}.json`);
try { copyFileSync(logsSrc, logsDst); } catch { /* no logs written */ }
```

## Part 3: Surface in Build Detail Pane

### New files

Follow the `build-profiling` pattern exactly (it uses `shared/` for endpoints):

- `plugins/build/plugins/build-logs/shared/endpoints.ts` — `defineEndpoint({ route: "GET /api/build/runs/:id/logs" })`
- `plugins/build/plugins/build-logs/shared/index.ts` — re-exports endpoint + types
- `plugins/build/plugins/build-logs/server/internal/handle-build-run-logs.ts` — reads `<name>-build-logs-<buildId>.json`, returns `{ steps }` or `{ steps: [] }`
- `plugins/build/plugins/build-logs/server/index.ts` — server barrel registering the endpoint

### Modified files

- `plugins/build/plugins/build-logs/web/components/build-log-section.tsx` — two-mode component

### Web component design

The component receives `{ runId: string }`. Two modes:

1. **Persisted mode** — when `useEndpoint(getBuildRunLogs, { id: runId })` returns data with `steps.length > 0`:
   - Collapsible sections per step
   - Header: status icon (✓/✗) + label + duration
   - Failed steps auto-expanded, successful steps collapsed
   - Monospace log lines, stderr in `text-destructive`

2. **Live mode** — when persisted data is empty or loading:
   - Existing WebSocket subscription to `ws/logs` channel `"build"` (unchanged behavior)
   - Label indicates "Live — streaming build output"

Use `useEndpoint` (TanStack Query wrapper from `@plugins/infra/plugins/endpoints/web`) rather than raw fetch, matching the recommended pattern. The existing `BuildProfilingSection` uses raw fetch but predates `useEndpoint`.

## Implementation Order

1. `runner.ts` — add `log` callback (backward compatible, no behavior change without it)
2. `build-logs-writer.ts` — new file, additive
3. `build.ts` — `execBuffered` + refactored parallel section + `writeBuildLogs` call
4. `run-build.ts` — add logs copy after profile copy
5. `build-logs/shared/` — endpoint definition + types
6. `build-logs/server/` — endpoint handler + barrel
7. `build-log-section.tsx` — two-mode component

Steps 1-4 are CLI/server-side, verifiable by running `./equin build`.
Steps 5-7 complete the UI, verifiable in the browser.

## Verification

1. `./equin build` — terminal shows clean labeled blocks, no interleaving
2. `cat ~/.singularity/worktrees/<name>-build-logs.json` — has `{ steps: [...] }` with per-step data
3. Trigger build from UI, open build detail pane after completion — per-step collapsible log sections visible
4. During an active build, live WS stream still works
5. Introduce a lint error, run `./equin build` — failure output is labeled and separated from passing steps
