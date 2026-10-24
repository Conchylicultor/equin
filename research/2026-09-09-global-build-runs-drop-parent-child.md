# Drop the parent/child concept from the build ledger

Phase 8 of [`2026-08-17-global-composition-build-serve-model.md`](./2026-08-17-global-composition-build-serve-model.md).

## Context

A build run used to be able to have a parent. Building the `sonata` composition
was not a build of its own — it was a tail stage of a main `./equin build`,
so it borrowed the main run's identity: a `build_runs` row pointing back at the
main run through `parent_id`, and artifacts named after the main run's id with a
`-c-sonata` suffix.

Compositions are first-class builds now. Phase 4 deleted the compose-serve stage
and settled the open question it owned — **one invocation is one row with N
targets**, not N child rows sharing a transcript. With nothing minting a child,
everything the child shape needed is dead weight.

The intended outcome is that the ledger stops carrying a relation the model no
longer has. Target-model point 6 ("a composition build has no parent") becomes
true of the schema, not just of the write path.

## What is already done

The phase list in the parent doc was written before Phases 2–4 landed, and two
of its three bullets have already been absorbed:

- **Artifact naming is already clean.** There is no `-c-<name>` suffix anywhere
  in live code. `worktreeArtifacts.buildProfile / buildLogs / buildLogText`
  (`plugins/infra/plugins/paths/core/internal/paths.ts:345`) take a plain build
  id, and `run.ts` derives it as `` `${shortCommit}-${Date.now()}` `` — one id,
  no composition suffix.
- **The `target === "main"` special-cases are already gone.** They were replaced
  by the single answer `isMainCompositionBuild(targets)` in
  `plugins/build/core/targets.ts`. No literal `"main"` comparison remains in
  `plugins/build/**`.
- **The detail pane's Target badge stays as it is.** The parent doc explicitly
  dropped the build-UI linkage phase ("it patched a symptom this model deletes"),
  so there is no relation left for the pane to render. Its per-composition badge
  tint (`build-info.tsx:126`) reads a composition id rather than comparing against
  `"main"`, and is deliberately out of scope.

What is genuinely left is the column, its wire field, and two orphaned CLI
factories.

## The change

### 1. Drop the column

`plugins/build/plugins/run-ledger/server/internal/tables.ts` — delete the
`parentId: text("parent_id")` field and its comment block. Then run
`./equin build`, which generates the `ALTER TABLE "build_runs" DROP COLUMN
IF EXISTS "parent_id"` migration.

**One push, no expand/contract split.** The two-push rule in
`plugins/database/plugins/migrations/CLAUDE.md` applies to backfills that need
schema the same branch changes. Nothing writes `parent_id` and it is NULL in
every row, so there is no data to move. Direct precedent, same table:
`data/20260820_080153_aadbd74b__merged_20260820_0801.sql` dropped `target` this
way.

**The CLI's ordering discipline is already satisfied, and this is worth checking
rather than assuming.** `insertRun` is a hand-written INSERT precisely because
the CLI runs new code against the *previous* build's schema. It names six columns
and `parent_id` was never one of them, so nothing changes for it. `closeRun` uses
drizzle `.set()`, which names only assigned columns. The one reader — the history
resource's explicit select — ships in the same backend restart that applies the
DROP, so no process ever selects a column that is gone.

### 2. Drop the wire field

- `plugins/build/core/resources.ts` — remove `parentId` from `BuildRunSchema`
  and its "always null" comment.
- `plugins/build/server/internal/build-history-resource.ts:28` — remove
  `parentId: _buildRuns.parentId` from the select. This is the only read of the
  column in the repo.

No consumer touches `run.parentId`: not the detail pane, not `runs-arm`'s field
declarations, not `build-fix`, not `use-serve-status`.

### 3. Delete the two orphaned collector factories

`git log -S` places both in `fac5f95bd` (the per-composition child-run commit),
injected into compose-serve as `createProfile` / `createLogs`. Phase 4
(`90f9da7a5`) deleted compose-serve and orphaned them. They are not even
re-exported from the CLI barrel.

In `plugins/framework/plugins/cli/plugins/op-runtime/cli/profiler.ts`:

- Delete `createSpanCollector()`.
- Delete the exported `SpanCollector` interface and its `write(name, runId)`
  method (the child's id-suffixed write); fold `SpanCollectorInternal` into one
  non-exported `SpanCollector` keeping `start` / `push` / `writeProfile`.
- Remove `write` from the returned object literal.
- Fix the `makeSpanCollector` doc comment, which still justifies per-collector
  `t0` re-basing by "a composition's spans start at 0 relative to the
  composition, not the parent build".

The same three edits in
`plugins/framework/plugins/cli/plugins/op-runtime/cli/build-logs-writer.ts` for
`createStepLogCollector` / `StepLogCollector` / its `write(name, runId, exitCode,
trailer)`.

Untouched in both: `makeXxxCollector`, the module-default collector, and the
wrapper exports (`buildProfilerStart`, `pushBuildSpan`, `writeBuildProfile`,
`pushBuildStepLog`, `writeBuildLogs`) that every real caller uses. Keep the
`BuildProfile` / `BuildSpan` / `BuildLogs` / `BuildStepLog` types — the
profiling UI consumes them.

### 4. Update the prose

- `plugins/build/plugins/run-ledger/CLAUDE.md` — delete the `parentId` paragraph
  ("a column nothing writes… goes in the Phase 8 cleanup"), and drop `parent_id`
  from the illustrative `.toSQL()` transcript at line 46. That transcript is a
  measured record of what drizzle emits; leaving a dropped column in it makes the
  load-bearing warning it supports read as stale.
- `plugins/build/plugins/run-ledger/server/internal/recorder.ts:98` — the same
  column list inside the HAND-WRITTEN INSERT comment.
- `research/2026-08-17-global-composition-build-serve-model.md` — mark Phase 8
  **LANDED**, matching Phases 2 and 6.

`plugins/build/CLAUDE.md`'s parent/child mentions are about the OS process that
spawns the detached build, not run rows. Leave them.

## Verification

1. `./equin build` (background, per the workflow rule). Confirm
   `~/.singularity/worktrees/<wt>/build-status.json` reads `status: ok`.
2. The generated migration contains exactly the one `DROP COLUMN IF EXISTS
   "parent_id"` statement against `build_runs`, and no unrelated DDL.
3. `./equin check` green — `migrations-in-sync` and `type-check` are the
   two that would catch a miss here. `plugins-doc-in-sync` covers the autogen
   block in the run-ledger CLAUDE.md.
4. `query_db` on the worktree DB: `select * from build_runs limit 1` returns no
   `parent_id`, and the row this very build minted is present with its own id and
   `targets = {singularity}`.
5. Open the Build popover, then a run's detail pane: history renders, the Target
   badge and status/commit/duration rows are unchanged, and the profiling and
   logs sections still resolve their artifacts.
6. A composition build still records itself: `./equin build --composition
   sonata` mints one row whose `targets = {sonata}` and whose profile/log
   artifacts are named after that row's own id.
