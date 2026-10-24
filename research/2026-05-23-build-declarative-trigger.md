# Migrate build trigger from imperative to declarative

## Context

The build plugin is the last production plugin using the imperative `trigger()` + `deleteTriggersFor()` pattern in its `onReady`. The `isMain()` guard that justified the imperative path can be moved into the job handler instead, making the trigger declarative and consistent with all other plugins.

## Changes

### 1. `plugins/build/server/index.ts`

- Add `Trigger` import from `@plugins/infra/plugins/events/server` and `refAdvanced` from `@plugins/infra/plugins/git-watcher/server` (keep both — `refAdvanced` moves from imperative use to declarative use).
- Add to `contributions` array:
  ```ts
  Trigger({ on: refAdvanced.where({ refName: "refs/heads/main" }), do: buildRunJob, with: {}, oneShot: false })
  ```
- Remove the imperative block from `onReady` (lines 40-46: `deleteTriggersFor` + `trigger` calls).
- Remove `deleteTriggersFor` and `trigger` from imports (no longer used). Keep `refAdvanced`.

### 2. `plugins/build/server/internal/build-run-job.ts`

- Import `isMain` from `@plugins/infra/plugins/paths/server`.
- Add `if (!isMain()) return;` as the first line of the `run` handler (before the `isBuildInflight` check).

## Verification

- `./equin build` — confirms the server compiles and starts.
- Query the trigger table to confirm the declarative row exists: `mcp query_db` with `SELECT * FROM git_ref_advanced_triggers WHERE job_name = 'build.run'`.
