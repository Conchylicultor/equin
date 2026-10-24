# Build Commits Section

## Context

The build detail view shows info, logs, and profiling for each build run. It's missing a list of commits included in each build since the previous build. The commits-graph plugin (in the conversation view) already has commit row rendering (`CommitRail`, `CommitRowItem`) and git log parsing (`parseCommits`), but everything is internal — nothing is exported for cross-plugin use. We need to extract shared commit-list primitives, refactor commits-graph to use them, and create a new build-commits sub-plugin.

## Plan

### Phase 1: New primitive `plugins/primitives/plugins/commit-list/`

Extract reusable commit type, git log parser, and row rendering into a primitive.

**`core/index.ts`** — `CommitRow` type + `CommitRowSchema` (zod). Copied verbatim from `commits-graph/shared/protocol.ts` (only the `CommitRow` parts, not `CommitDelta`/`CommitsGraph` which are conversation-specific).

**`server/index.ts`** — Exports:
- `parseGitLog(out: string): CommitRow[]` — renamed from `parseCommits`, extracted from `commits-graph/server/internal/compute-graph.ts`
- `LOG_FORMAT` — the git log format string (`%H%x09%h%x09...%x00`)
- `runGit(args, cwd): Promise<string | null>` — extracted from `commits-graph/server/internal/git.ts`

Internal files: `server/internal/parse-git-log.ts`, `server/internal/run-git.ts`.

**`web/index.ts`** — Exports:
- `CommitRail` — SVG single-rail dot indicator, extracted from `commits-graph/web/components/commit-rail.tsx`
- `MergeBaseMarker` — merge-base separator, same source
- `COMMIT_ROW_HEIGHT` — constant (36px)
- `CommitRowItem` — generic row component extracted from `commits-graph/web/components/commits-graph-body.tsx`, with `onClick?: (commit: CommitRow) => void` prop instead of hardcoded navigation. Only applies `cursor-pointer` + `hover:bg-accent/50` when `onClick` is provided.
- Re-exports `CommitRow`, `CommitRowSchema` from core

Internal files: `web/internal/commit-rail.tsx`, `web/internal/commit-row-item.tsx`. The `formatRelative` helper stays inlined in commit-row-item.

### Phase 2: Refactor commits-graph to use the primitive

- `shared/protocol.ts` — Remove local `CommitRowSchema`/`CommitRow`, re-export from `@plugins/primitives/plugins/commit-list/core`
- `server/internal/compute-graph.ts` — Replace local `LOG_FORMAT`, `parseCommits`, `runGit` with imports from `@plugins/primitives/plugins/commit-list/server`. Delete `server/internal/git.ts`.
- `web/components/commits-graph-body.tsx` — Replace local `CommitRowItem` function and `commit-rail.tsx` import with imports from `@plugins/primitives/plugins/commit-list/web`. Pass conversation-specific `onClick` handler via prop. Delete `web/components/commit-rail.tsx`.

### Phase 3: New sub-plugin `plugins/build/plugins/build-commits/`

Follows the build-logs pattern (core/shared/server/web).

**`core/endpoints.ts`** — `getBuildRunCommits = defineEndpoint({ route: "GET /api/build/runs/:id/commits", response: z.array(CommitRowSchema) })`

**`server/internal/handle-build-run-commits.ts`** — Logic:
1. Query `_buildRuns` ordered by `startedAt` desc (limit 50)
2. Find the current run by `params.id`
3. Find the previous run with a non-null `commitHash`
4. `git log <prevHash>..<thisHash>` using `runGit` + `LOG_FORMAT` + `parseGitLog` from the primitive
5. Edge case: no previous build → `git log --max-count=50 <hash>` (capped)

Uses `_buildRuns` via relative import from parent build plugin (intra-plugin, not cross-plugin).

**`web/components/build-commits-section.tsx`** — Calls `useEndpoint(getBuildRunCommits, { id: runId })`, renders `CommitRowItem` list with no onClick (read-only rows).

**`web/index.ts`** — Contributes `BuildDetailSlots.Section({ id: "commits", label: "Commits", component: BuildCommitsSection })`.

## Key files

| File | Action |
|------|--------|
| `plugins/primitives/plugins/commit-list/core/index.ts` | Create |
| `plugins/primitives/plugins/commit-list/server/index.ts` | Create |
| `plugins/primitives/plugins/commit-list/server/internal/parse-git-log.ts` | Create |
| `plugins/primitives/plugins/commit-list/server/internal/run-git.ts` | Create |
| `plugins/primitives/plugins/commit-list/web/index.ts` | Create |
| `plugins/primitives/plugins/commit-list/web/internal/commit-rail.tsx` | Create |
| `plugins/primitives/plugins/commit-list/web/internal/commit-row-item.tsx` | Create |
| `plugins/primitives/plugins/commit-list/package.json` | Create |
| `plugins/conversations/.../commits-graph/shared/protocol.ts` | Edit — re-export CommitRow from primitive |
| `plugins/conversations/.../commits-graph/server/internal/compute-graph.ts` | Edit — use primitive imports |
| `plugins/conversations/.../commits-graph/server/internal/git.ts` | Delete |
| `plugins/conversations/.../commits-graph/web/components/commits-graph-body.tsx` | Edit — use primitive CommitRowItem |
| `plugins/conversations/.../commits-graph/web/components/commit-rail.tsx` | Delete |
| `plugins/build/plugins/build-commits/core/endpoints.ts` | Create |
| `plugins/build/plugins/build-commits/core/index.ts` | Create |
| `plugins/build/plugins/build-commits/shared/index.ts` | Create |
| `plugins/build/plugins/build-commits/server/index.ts` | Create |
| `plugins/build/plugins/build-commits/server/internal/handle-build-run-commits.ts` | Create |
| `plugins/build/plugins/build-commits/web/index.ts` | Create |
| `plugins/build/plugins/build-commits/web/components/build-commits-section.tsx` | Create |
| `plugins/build/plugins/build-commits/package.json` | Create |

## Verification

1. `./equin build` — auto-discovers new plugins, registers them
2. Navigate to a build detail view at `http://<worktree>.localhost:9000/build/r/<runId>` — verify "Commits" section appears with commit rows
3. Verify the conversation commits-graph still works: open any conversation, click the commits chip, confirm the pane renders correctly with clickable rows
4. Try a build that has no previous build (first in list) — should show capped commit list or empty state
