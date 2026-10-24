# Per-composition build runs: separate rows + separate profiles

## Context

`./equin build` on the main checkout ends with a compose-serve stage: after deploying main (restart backend + health probe), it rebuilds each activated composition (sonata, website, …) in-process and serves it at `http://<id>.localhost:9000`. Today those composition builds are invisible as builds: their profiler spans land inside main's single `build-profile-<id>.json`, their log lines go only to stdout, and they have **zero `build_runs` rows**.

This also causes a live bug: main's `build_runs` row is only ever closed by `reconcileOrphanBuilds` (pid-dead scan at backend `onReady` + before the next claim). The ~100s compose-serve tail keeps the CLI pid alive past the restarted backend's boot reconcile, so the row stays open forever and the toolbar build button spins "Building…" indefinitely (see the investigation earlier in this conversation: CLI finished 75.8s after backend-ready on `build-1784682655313-wkmym3`).

**Goal:** each composition build becomes its own build run row with its own profile/log artifacts, visible in main's Builds UI. Main's row closes when *main* is deployed.

User decisions (locked):
1. **Main's row closes at main deploy** (right after the health probe); the CLI stamps it directly in the DB, guarded `where(isNull(finishedAt))` (first-writer-wins vs the legacy backend/reconcile writers). Fixes the eternal spinner.
2. **Flat rows + `target` field** ("main" | composition id) in the same history list; `parentId` kept as data, no nesting UI.
3. **CLI ledger, main-checkout only**: when `SINGULARITY_BUILD_ID` is unset (direct terminal `./equin build` on main), the CLI mints the main row itself. Worktree builds stay out of scope (still no rows).

## Verified constraints

- The CLI cannot use `db` from `@plugins/database/server` (env-bound via `SINGULARITY_WORKTREE`, absent in a terminal build). Use `openShortLivedClient(MAIN_WORKTREE_NAME)` (`plugins/database/plugins/admin/server/internal/pool.ts:91`) wrapped in drizzle. Compose-serve is main-only, so main's DB is always the right target.
- Importing `@plugins/build/server` from `cli/bin` is boundary-legal and import-safe (barrel default is inert data; `defineJob`/`queryResource` are pure registrations at module eval; precedent: build.ts already imports `@plugins/database/plugins/admin/server`, `@plugins/infra/plugins/worktree/server`, op-log server). `_buildRuns` is already exported from the barrel.
- The DB change-feed has STATEMENT triggers on every table, so out-of-process CLI writes to `build_runs` push through `pg_notify` → `buildHistoryResource` updates live. No extra notify plumbing.
- The detail-pane endpoints (`plugins/build/plugins/build-logs/server/internal/handle-build-run-logs.ts`, `.../build-profiling/.../handle-build-run-profiling.ts`) read `worktreeArtifacts.*(process.env.SINGULARITY_WORKTREE, params.id)` — so composition artifacts written under **main's** worktree data dir keyed by the composition run id work with zero endpoint changes.
- `reconcileOrphanBuilds` is scoped `namespace = currentWorktreeName()` and `resolveOrphanTerminal` reads `worktreeArtifacts.buildLogs(name, runId)` — composition rows are covered for free once their own build-logs artifacts exist.
- Prune (`plugins/infra/plugins/paths/server/internal/prune-artifacts.ts`) groups artifacts by extracted run-id (prefix/suffix strip, whole middle kept) — the chosen run-id shape `<parentBuildId>-c-<compId>` groups cleanly.
- `failBuild` (`build.ts:1411`) is synchronous `(): never` ending in `process.exit(1)` — closing the row there requires making it async (see step 7).

## Run-id choice

`<parentBuildId>-c-<compositionId>` (e.g. `build-1784…-x1y2z3-c-sonata`). Deterministic from the parent, route-valid (`buildDetailRoute` param), filename-valid, prune-regex-safe.

## Steps

### 1. Schema (`plugins/build/server/internal/tables.ts`)

- Add `target: text("target").notNull().default("main")` — `"main"` | composition id.
- Add `parentId: text("parent_id")` — soft reference to the parent main run (no FK: parent may be pruned past the 50-row retention).
- Widen the in-flight lock: `uniqueIndex("build_runs_inflight_uniq").on(t.namespace, t.target).where(finishedAt IS NULL)`. The backend's claim INSERT omits `target` → defaults `'main'` → claim semantics identical to today; open composition rows never collide with the main claim or each other.

Run `./equin build` to regenerate the drizzle migration (never drizzle-kit directly).

### 2. Wire schema + history resource

- `plugins/build/core/resources.ts` `BuildRunSchema`: add `target: z.string()`, `parentId: z.string().nullable()`.
- `plugins/build/server/internal/build-history-resource.ts`: add `target`, `parentId` to the `select` (pid stays off the wire).

### 3. CLI build-runs recorder (new: `plugins/build/server/internal/cli-build-runs.ts`, re-export from `plugins/build/server/index.ts`)

```ts
export interface BuildRunRecorder {
  insertMainRun(r: { id: string; trigger: "manual" | "auto"; commitHash: string | null; pid: number }): Promise<"claimed" | "lost">;
  insertCompositionRun(r: { id: string; target: string; parentId: string; pid: number }): Promise<void>;
  closeRun(id: string, exitCode: number): Promise<void>; // guarded where(isNull(finishedAt))
  close(): Promise<void>;
}
export function createBuildRunRecorder(): BuildRunRecorder;
```

- One `openShortLivedClient(MAIN_WORKTREE_NAME)` pool + drizzle for the recorder's lifetime; released in `close()`. All rows `namespace: MAIN_WORKTREE_NAME`.
- `insertMainRun`: claim-style INSERT; SQLSTATE 23505 → `"lost"` (caller logs a soft note; the CLI file build-lock already serializes real builds, so a conflict means a stale orphan row — cleaned by the next reconcile).
- `insertCompositionRun`: **first sweep-close any stale open row for `(namespace, target)`** (`UPDATE … SET finishedAt = now(), exitCode = -1 WHERE namespace = … AND target = … AND finishedAt IS NULL`) — a CLI killed mid-compose, a `--no-restart` build, or the boot-reconcile race can leave one, and it would 23505 the insert on the new unique index. Safe by construction: the file build-lock guarantees no concurrent compose-serve. Then INSERT, copying `trigger`/`commitHash` from the `parentId` row (fallback `"manual"`/`null` if the parent row is absent — lost claim case).
- `closeRun`: `UPDATE … SET finishedAt, exitCode WHERE id = … AND finishedAt IS NULL`.

### 4. Profiler collector instances (`plugins/framework/plugins/cli/bin/profiler.ts`)

Refactor the module-global `spans[]`/`t0` into a factory; keep existing exports as wrappers over a module-default main collector (zero behavior change for main's own profile):

```ts
export interface SpanCollector {
  start(id: string, phase: string, label: string): (extra?: { maxRssBytes?: number }) => void;
  push(id: string, phase: string, label: string, durationMs: number, wallStartMs?: number): void;
  write(name: string, runId: string): void; // build-profile-<runId>.json under worktree `name`
}
export function createSpanCollector(): SpanCollector;
```

- `start()` keeps emitting the durable `buildProgressSpanStart/End` markers (module-global build-progress log, parent pid) unchanged.
- Per-collector `t0` so a composition's spans are re-based to its own start.
- `buildProfilerStart`/`pushBuildSpan`/`writeBuildProfile(name)` delegate to the default collector — build.ts callers unchanged.

### 5. Step-log collector instances (`plugins/framework/plugins/cli/bin/build-logs-writer.ts`)

Same treatment:

```ts
export interface StepLogCollector {
  beginStep(id: string, label: string): (success: boolean) => void;
  line(text: string, stream: "stdout" | "stderr"): void; // appended to the current open step
  write(name: string, runId: string, trailer?: string): void; // build-logs-<runId>.json + build-<runId>.log
}
export function createStepLogCollector(): StepLogCollector;
```

`pushBuildStepLog`/`writeBuildLogs` stay as wrappers over the default main collector (build.ts:1389 unchanged). The JSON keeps the `{steps: [{id,label,lines,durationMs,success}], finishedAt}` shape — that is what `resolveOrphanTerminal`, the build-logs detail section, and build-fix consume, so composition runs get all three for free.

### 6. Compose-serve owns per-composition rows + artifacts (`plugins/framework/plugins/cli/bin/commands/internal/compose-serve.ts`)

Extend `ComposeServeOptions` with injected deps: `recorder: BuildRunRecorder; parentBuildId: string; createProfile: () => SpanCollector; createLogs: () => StepLogCollector`. In `serveOne`:

- `const compRunId = `${parentBuildId}-c-${id}``; `await recorder.insertCompositionRun({ id: compRunId, target: id, parentId: parentBuildId, pid: process.pid })`.
- `const prof = createProfile(); const logs = createLogs();` and a local `compStage(sid, label, run)` wrapper that opens a `prof.start` span + `logs.beginStep` step around each pipeline sub-stage (replacing the current `stage.onStage(\`compose:${id}:${sid}\`, …)` prefixing into main's profile, line ~160). Route the pipeline `log` callback lines through `logs.line(…)` in addition to console.
- Wrap the per-composition body:
  ```ts
  let ok = false;
  try { …existing serveOne work via compStage…; ok = true; }
  finally {
    prof.write(MAIN_WORKTREE_NAME, compRunId);
    logs.write(MAIN_WORKTREE_NAME, compRunId);
    await recorder.closeRun(compRunId, ok ? 0 : 1);
  }
  ```
- Main's own profile keeps exactly one summary bar per composition (the existing `onStage("compose:" + id, …)` wrapper around `serveOne`) plus `compose:prepare`.

### 7. build.ts wiring (`plugins/framework/plugins/cli/bin/commands/build.ts`)

- Capture `const uiTriggered = process.env.SINGULARITY_BUILD_ID != null;` **before** the line-810 env overwrite.
- Create `const recorder = createBuildRunRecorder();` near the op-profiler setup (~line 838); release via `finalizeBuild` (line 859) so every graceful exit closes the pool.
- **Mint the main row (decision 3)** after `acquireBuildLock` succeeds: `if (!uiTriggered && root === mainRoot) { … insertMainRun({ id: buildId, trigger: "manual", commitHash: shortCommit ?? null, pid: process.pid }) … }` (reuse the `shortCommit` read at line ~808; hoist the `mainRoot` resolution if needed). `"lost"` → soft note, continue.
- **Close main's row at deploy, before compositions**: restart path — after `probeHealth` succeeds (line 1650), before `await runComposeServe()` (line 1654): `await recorder.closeRun(buildId, 0)`. `--no-restart` path (line 1580): same, before its `runComposeServe()`.
- **Close on pre-deploy failure**: make `failBuild` async — `(reason, failedLabels): Promise<never>` — with `await recorder.closeRun(buildId, 1)` before `process.exit(1)`; `await failBuild(…)` at the statement call sites (1444, 1567, 1615) and adapt `probeHealth`'s fail-callback type to `(reason: string[]) => Promise<never>` (awaited inside probeHealth). The compose-serve `failBuild` (line 1567, main already deployed and row already closed 0) becomes a no-op close thanks to the `isNull(finishedAt)` guard — main's row keeps reflecting the main deploy per decision 1. `no-floating-promises` lint catches any missed await.
- Pass the new deps into `runComposeServeStage` (line 1547).

### 8. Guard the backend's late writers (`plugins/build/server/internal/run-build.ts`)

- `proc.exited` UPDATE (line 274): add `isNull(_buildRuns.finishedAt)` to the `where` so it never overwrites the CLI's stamp.
- `reconcileOrphanBuilds` UPDATE (line 125): same guard.
- Keep the "Build succeeded/failed" notifications (lines 280–298) firing off `proc.exited`'s exit code — that is the whole-build verdict (main + compositions), independent of the main row's own exit.

### 9. UI

- `plugins/build/web/components/build-popover-content.tsx`:
  - `BuildHistoryDataView`: add a `target` text field (filterable; render as a small Badge, muted for `main`, info-colored for compositions).
  - `BuildHistoryExcerpt`: target chip on rows where `run.target !== "main"`.
- `plugins/build/web/components/build-button.tsx`: derivation unchanged (during compose-serve the latest row is an open composition row → "Building…", now accurate). Optional nicety: `Building ${latestRun.target}…` when `target !== "main"`.
- `plugins/build/plugins/build-info/web/components/build-info.tsx`: add a Target row.
- `plugins/build/plugins/build-commits/...`: when the run's `target !== "main"`, render a placeholder ("Commits belong to the parent build") instead of the commit list.
- `build-fix`, `build-logs`, `build-profiling` detail sections: no changes — they work off the per-run artifacts/logs that now exist for compositions.

### 10. Rebuild + checks

`./equin build` (migration + docs regen + deploy), then `./equin check` green (`migrations-in-sync`, `plugins-doc-in-sync`, `plugin-boundaries`, `type-check`).

Ordering to keep the tree green: 1 → build → 2 → 3 → 4,5 (pure refactors behind unchanged exports) → 6 → 7 → 8 → 9 → 10.

## Out of scope (explicit)

- Worktree CLI builds ledger (direct agent builds still create no rows).
- `.build-id` trailer inside composition dists (keeps main's buildId, as today).
- Release pipeline, zero-cache sidecars.

## Verification

1. **UI/auto build on main**: trigger a build; watch `query_db "select id,target,parent_id,trigger,started_at,finished_at,exit_code from build_runs order by started_at desc limit 10"` — main's row closes (`exit_code=0`) at deploy, then composition rows (`target=sonata|website`, `parent_id=<main id>`) open and close one by one.
2. **Artifacts**: `ls ~/.singularity/worktrees/singularity/` shows `build-profile-<id>-c-<comp>.json`, `build-logs-<id>-c-<comp>.json`, `build-<id>-c-<comp>.log`.
3. **Builds UI**: popover excerpt + Builds pane show composition rows with target chips; a composition run's detail pane shows Target in Info, its own Logs + Profiling Gantt, and the commits placeholder.
4. **Spinner fix**: the toolbar button returns to idle once all compositions finish — no eternal "Building…" after reload.
5. **Orphan path**: `kill -9` the `./equin build` pid mid-composition; restart the main backend (or trigger a build) → reconcile closes the open composition row (exit from its artifact if written, else -1); main's row already 0; the next build's `insertCompositionRun` sweep tolerates any survivor.
6. **Manual terminal build on main**: `./equin build` in a shell → a `trigger=manual` main row minted by the CLI plus composition children (decision 3).
