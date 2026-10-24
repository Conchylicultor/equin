# Fix: stale build logs shown for failed builds

## Context

When a build fails early (before reaching `writeBuildLogs()`), the server-side `run-build.ts` still copies whatever `<worktree>-build-logs.json` sits on disk — which belongs to the *previous* build. The UI then shows green logs for a red build.

Root cause: the CLI writes logs/profile to a fixed filename (`<name>-build-logs.json`), and `run-build.ts` copies that file to `<name>-build-logs-<buildId>.json` after exit. There's no way to tell whether the file was written by *this* build or a prior one.

## Approach

Thread the `buildId` from the server into the CLI via env var. The CLI writes directly to the per-build filename. The server skips the copy step entirely — if the file exists after exit, it's the right one; if it doesn't, the build never got far enough to write logs.

### Changes

**1. `plugins/build/server/internal/run-build.ts`**

- Pass `SINGULARITY_BUILD_ID: buildId` in the `env` of `Bun.spawn`:
  ```ts
  env: { ...process.env, SINGULARITY_BUILD_ID: buildId },
  ```
- Remove the `copyFileSync` calls (lines 72-80). Replace with nothing — the CLI now writes directly to the per-build path.

**2. `plugins/framework/plugins/cli/bin/build-logs-writer.ts`**

- `writeBuildLogs(name)`: if `process.env.SINGULARITY_BUILD_ID` is set, write to `<name>-build-logs-<buildId>.json` instead of `<name>-build-logs.json`. Fall back to the old filename when the env var is absent (CLI run manually outside the server).

**3. `plugins/framework/plugins/cli/bin/profiler.ts`**

- Same change for `writeBuildProfile(name)`.

### Files to modify

- `plugins/build/server/internal/run-build.ts` — pass env var, remove copy logic
- `plugins/framework/plugins/cli/bin/build-logs-writer.ts` — use buildId in filename
- `plugins/framework/plugins/cli/bin/profiler.ts` — use buildId in filename

## Verification

1. `./equin build` from the CLI (no env var) — logs still written to the old generic filename
2. Trigger a build from the UI — logs written to `<name>-build-logs-<buildId>.json`, no stale copy
3. Kill a build mid-flight — the per-build log file shouldn't exist, and the UI should show no logs (not stale ones)
