# Persistent Build Failure Logs

## Context

When `./equin build` fails early (before the parallel tsc/vite steps — e.g., during bun install, codegen, migrations, branch guard), the CLI calls `process.exit(1)` without ever calling `writeBuildLogs()`. The only trace is the `build_runs` DB row with `exitCode` set and the in-memory `Log.channel("build")` ring buffer, which is lost on the next server restart.

Observed: two builds failed with exit code 1 in ~300ms, but the actual error output was unrecoverable.

There's also a secondary gap: when parallel steps fail (tsc/vite errors), the CLI accumulates structured step logs via `pushBuildStepLog()` but still exits without calling `writeBuildLogs()`.

## Approach: Server-Side Raw Log Persistence + CLI Failure Path Fix

Two complementary changes:

### 1. Server-side: persist raw build output on failure (`run-build.ts`)

The server already captures every line from the build subprocess via `streamLines()` into `Log.channel("build")`. The fix accumulates those lines into an array and writes them to disk when the process exits with a non-zero code.

**Why server-side?** For early failures, the CLI hasn't reached the point where it could write structured logs — it often fails before `name` is even determined. The server is guaranteed to be alive for failed builds (it only restarts on success).

**File:** `plugins/build/server/internal/run-build.ts`

Changes:
1. Add `SINGULARITY_DIR` import from `@plugins/infra/plugins/paths/server`
2. Add `fs` imports: `mkdirSync`, `renameSync`, `writeFileSync` from `node:fs`, `join` from `node:path`
3. Modify `streamLines()` to accept an accumulator array and append each line to it
4. Await both `streamLines()` calls via `Promise.all` before `proc.exited` (fixes a latent race where buffered lines could be lost)
5. After `proc.exited`, if `exitCode !== 0`, write a synthetic single-step log file

```ts
// Accumulate lines for persistence
const allLines: Array<{ text: string; stream: "stdout" | "stderr" }> = [];

async function streamLines(
  stream: ReadableStream<Uint8Array> | null,
  streamType: "stdout" | "stderr",
) {
  if (!stream) return;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    for (const line of decoder.decode(chunk).split("\n")) {
      if (line) {
        buildLog.publish(line, streamType);
        allLines.push({ text: line, stream: streamType });
      }
    }
  }
}

// Drain both streams before reading exit code
await Promise.all([
  streamLines(proc.stdout, "stdout").catch(() => {}),
  streamLines(proc.stderr, "stderr").catch(() => {}),
]);

const exitCode = await proc.exited;

// Persist raw output for failed builds (CLI never writes logs on failure)
if (exitCode !== 0 && allLines.length > 0) {
  const worktreeName = process.env.SINGULARITY_WORKTREE;
  if (worktreeName) {
    const worktreesDir = join(SINGULARITY_DIR, "worktrees");
    mkdirSync(worktreesDir, { recursive: true });
    const logPath = join(worktreesDir, `${worktreeName}-build-logs-${buildId}.json`);
    const tmp = `${logPath}.tmp.${process.pid}`;
    const logs = {
      steps: [{
        id: "raw",
        label: "Build Output",
        lines: allLines,
        durationMs: Date.now() - buildStartMs,
        success: false,
      }],
    };
    writeFileSync(tmp, JSON.stringify(logs) + "\n");
    renameSync(tmp, logPath);
  }
}
```

The file format matches the existing `BuildLogsFile` interface in `handle-build-run-logs.ts`, so the endpoint and UI work without changes.

**Key invariant:** The server only writes when `exitCode !== 0`. The CLI only writes on the success path. These are mutually exclusive — no overwrite conflict.

### 2. CLI-side: write structured logs on parallel step failure (`build.ts`)

One-line addition at `plugins/framework/plugins/cli/bin/commands/build.ts:730`:

```ts
if (failures.length > 0) {
  await rm(stagingPath, { recursive: true, force: true });
  writeBuildLogs(name);  // <-- NEW: persist structured step logs before exit
  console.error(`\nBuild failed: ${failures.join(", ")}`);
  process.exit(1);
}
```

This ensures that when tsc/vite steps fail, the structured per-step logs (already accumulated via `pushBuildStepLog()` at line 719) are written to disk. The server-side fallback then becomes a safety net for even earlier failures.

**Order of precedence:** When the CLI writes the structured log file (with multiple steps), the server's `exitCode !== 0` check still triggers — but the CLI has already written the file. To avoid overwriting structured data with raw data, the server should skip the write if the file already exists:

```ts
if (exitCode !== 0 && allLines.length > 0) {
  // ...
  if (!existsSync(logPath)) {
    // Only write raw fallback if CLI didn't write structured logs
    writeFileSync(tmp, ...);
    renameSync(tmp, logPath);
  }
}
```

## Files Modified

| File | Change |
|---|---|
| `plugins/build/server/internal/run-build.ts` | Accumulate lines, await streams, write raw fallback on failure |
| `plugins/framework/plugins/cli/bin/commands/build.ts` | Call `writeBuildLogs(name)` before `process.exit(1)` at line 731 |

## Files NOT Modified

- `handle-build-run-logs.ts` — reads from disk, returns `{ steps }`. Already works with the synthetic format.
- `build-log-section.tsx` — renders `<PersistedLogs>` when `steps.length > 0`. The synthetic single-step or CLI-written multi-step both render correctly. Failed steps auto-expand (`defaultOpen={!step.success}`).
- `build-logs-writer.ts` — no changes needed.
- `endpoints.ts` — schema already compatible.

## Verification

1. **Early failure**: Break something that fails before parallel steps (e.g., rename `package.json` to break `bun install`). Trigger a build. Verify:
   - `~/.singularity/worktrees/<name>-build-logs-<buildId>.json` exists with a single "Build Output" step
   - The build detail pane shows `<PersistedLogs>` with the error output, not `<LiveLogs>`
   - The step auto-expands (since `success: false`)

2. **Parallel step failure**: Introduce a TypeScript error. Trigger a build. Verify:
   - The log file exists with structured per-step data (tsc step marked failed)
   - The build detail pane shows the structured multi-step view

3. **Successful build**: Normal build. Verify:
   - CLI writes the structured log as before
   - Server does NOT overwrite it (file already exists check)
   - UI shows the normal multi-step view
