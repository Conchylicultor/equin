# Per-Plugin Health Review System

## Context

Review agents check plugins against specific rules/axes (security, promise-safety, code quality, etc.). Today there's no structured record of which plugins have been reviewed, for which axes, or what the findings were. This makes it impossible to see coverage gaps or prioritize stale plugins for re-review.

This plugin adds a review tracking system where:
1. Review agents call `propose_task` to propose findings as draft tasks
2. A review row is created implicitly on first proposal for a given (pluginId, axis)
3. The user accepts/rejects draft tasks — accepted ones flow through the normal task system
4. Health is derived: coverage, staleness (commits since review), and finding counts
5. The plugin-view pane shows a per-plugin health section

## Location

`plugins/plugin-meta/plugins/plugin-health/`

## File Structure

```
plugins/plugin-meta/plugins/plugin-health/
  package.json
  CLAUDE.md
  core/
    index.ts                    # Shared types (PluginHealthReview, PluginStaleness)
  shared/
    schemas.ts                  # Zod schemas + resourceDescriptor for web
  server/
    index.ts                    # ServerPluginDefinition
    internal/
      tables.ts                 # _pluginHealthReviews table + entity-extension
      mcp-tools.ts              # propose_task MCP tool
      routes.ts                 # HTTP handlers
      resource.ts               # defineResource for reviews
      staleness.ts              # git-based staleness computation
  web/
    index.ts                    # PluginDefinition → contributes PluginView.Section
    components/
      health-section.tsx        # Health matrix in plugin detail pane
```

## Phase 1: Schema

### `plugin_health_reviews` table

File: `server/internal/tables.ts`

```ts
export const _pluginHealthReviews = pgTable(
  "plugin_health_reviews",
  {
    id:             text("id").primaryKey(),
    pluginId:       text("plugin_id").notNull(),
    axis:           text("axis").notNull(),
    commitHash:     text("commit_hash").notNull(),
    conversationId: text("conversation_id"),
    createdAt:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("plugin_health_reviews_plugin_axis_idx").on(t.pluginId, t.axis)],
);
```

Unique on `(plugin_id, axis)` — upsert replaces the prior review for the same pair.

### Task entity-extension: `tasks_ext_health_review`

File: `server/internal/tables.ts` (same file)

Uses `defineExtension` from `@plugins/infra/plugins/entity-extensions/server` with `_tasks` from `@plugins/tasks-core/server`. This is safe because:
- `tasks-core/server` barrel only re-exports from its own `internal/` files (tables, schema, queries, mutations) — no transitive pull of `claude-cli`, `bun-pty`, or `paths/bins`
- drizzle-kit now runs under Bun via `bunx --bun` (commit `4fb6143e`), so `Bun.which` is available even if it were pulled in

```ts
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { _tasks } from "@plugins/tasks-core/server";

export const healthReviewExt = defineExtension(_tasks, "health_review", {
  reviewId: text("review_id").notNull(),
});
export const _tasksExtHealthReview = healthReviewExt.table;
```

This auto-generates `tasks_ext_health_review(parent_id PK FK CASCADE, review_id, created_at, updated_at)` and provides `.get(taskId)`, `.upsert(taskId, { reviewId })`, `.delete(taskId)`.

## Phase 2: MCP Tool (`propose_task`)

File: `server/internal/mcp-tools.ts`

A general-purpose tool: any review agent proposes a task linked to a review context. The review row is created/updated implicitly.

Input schema:
- `pluginId: z.string()` — hierarchy ID (e.g. `"tasks"`, `"conversations.conversation-view"`)
- `axis: z.string()` — review dimension (e.g. `"security"`, `"promise-safety"`)
- `commitHash: z.string()` — git HEAD when the review ran
- `title: z.string()` — task title (describes the problem, not the fix)
- `description: z.string().optional()` — longer description

Handler logic:
1. Upsert `_pluginHealthReviews` on `(pluginId, axis)` conflict — update commitHash, conversationId, createdAt
2. `createTask({ title, description, author: conversationId })` from `@plugins/tasks-core/server`
3. `healthReviewExt.upsert(task.id, { reviewId })` to link task → review
4. `pluginHealthReviewsResource.notify()`
5. Return `{ reviewId, taskId }`

The agent calls `propose_task` once per finding as it discovers issues. No separate "start review" / "end review" ceremony — the review row is created or refreshed on every call.

Reference: `plugins/tasks/server/internal/mcp-tools.ts` (add_task pattern)

## Phase 3: Server Resource + HTTP Routes

### Resource

File: `server/internal/resource.ts`

```ts
export const pluginHealthReviewsResource = defineResource({
  key: "plugin-health-reviews",
  mode: "push",
  schema: PluginHealthReviewsSchema,
  loader: async () => db.select().from(_pluginHealthReviews)
    .orderBy(asc(_pluginHealthReviews.pluginId), asc(_pluginHealthReviews.axis)),
});
```

### HTTP Routes

File: `server/internal/routes.ts`

| Route | Purpose |
|---|---|
| `GET /api/plugin-health/reviews` | All review rows (HTTP fallback) |
| `GET /api/plugin-health/staleness/:pluginId` | Per-axis staleness for a plugin |
| `GET /api/plugin-health/tasks/:reviewId` | Tasks linked to a review with current status |

### Staleness computation

File: `server/internal/staleness.ts`

Uses `Bun.spawn([GIT, "rev-list", "--count", "<hash>..HEAD", "--", "plugins/<path>"])` via `GIT` from `@plugins/infra/plugins/paths/server` and `ensureMainWorktreeRoot()` from `@plugins/infra/plugins/worktree/server`.

`pluginId` → path: split on `.`, join with `/plugins/` (e.g. `tasks.auto-start` → `tasks/plugins/auto-start`).

Also computes `apiChanged` by checking if barrel files (`**/index.ts`) changed since the review commit.

## Phase 4: Server Plugin Definition

File: `server/index.ts`

```ts
export default {
  id: "plugin-health",
  name: "Plugin Health",
  description: "Per-plugin health review tracking.",
  contributions: [Resource.Declare(pluginHealthReviewsResource)],
  httpRoutes: {
    "GET /api/plugin-health/reviews":             handleGetReviews,
    "GET /api/plugin-health/staleness/:pluginId": handleGetStaleness,
    "GET /api/plugin-health/tasks/:reviewId":     handleGetTasksForReview,
  },
  register: [proposeTaskTool],
} satisfies ServerPluginDefinition;
```

Both registries (`server/src/plugins.generated.ts`, `web/src/plugins.generated.ts`) auto-regenerate on `./equin build`.

## Phase 5: Shared Types

### Core types (`core/index.ts`)

```ts
export interface PluginHealthReview {
  id: string;
  pluginId: string;
  axis: string;
  commitHash: string;
  conversationId: string | null;
  createdAt: string;
}

export interface PluginStaleness {
  axis: string;
  commitsSince: number;
  apiChanged: boolean;
}
```

### Resource descriptor (`shared/schemas.ts`)

```ts
export const pluginHealthReviewsDescriptor = resourceDescriptor<PluginHealthReview[]>(
  "plugin-health-reviews", PluginHealthReviewsSchema, [],
);
```

## Phase 6: Web — PluginView.Section

### `web/index.ts`

```ts
export default {
  id: "plugin-health",
  name: "Plugin Health",
  contributions: [
    PluginViewSlots.Section({ id: "health", label: "Health", component: HealthSection }),
  ],
} satisfies PluginDefinition;
```

Reference: `plugins/plugin-meta/plugins/plugin-view/plugins/source-path/web/index.ts`

### `web/components/health-section.tsx`

Receives `{ node: PluginNode }`. Renders a table:

| Axis | Last reviewed | Commits since | Findings |
|---|---|---|---|
| security | 2d ago | 3 | 1 pending, 2 done |
| promise-safety | — | — | — |

- `useResource(pluginHealthReviewsDescriptor)` → filter to `node.hierarchyId`
- Fetch `/api/plugin-health/staleness/:pluginId` for staleness data
- Fetch `/api/plugin-health/tasks/:reviewId` per review for finding counts
- Color coding: green (fresh, no open), yellow (stale or pending findings), red (very stale)
- Empty state: "No reviews yet"

Uses `Section` wrapper from `@plugins/plugin-meta/plugins/plugin-view/web`.

## Phase 7: Package

```json
{
  "name": "@singularity/plugin-plugin-meta-plugin-health",
  "private": true,
  "version": "0.0.1"
}
```

## Critical Reference Files

- `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts` — defineExtension API
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/tables.ts` — defineExtension consumer pattern
- `plugins/tasks/server/internal/mcp-tools.ts` — MCP tool with createTask
- `plugins/plugin-meta/plugins/plugin-view/plugins/source-path/web/` — PluginView.Section contributor
- `plugins/conversations/plugins/conversation-progress/server/internal/heuristic-job.ts` — git subprocess pattern
- `plugins/infra/plugins/paths/server` — `GIT` binary path
- `plugins/infra/plugins/worktree/server` — `ensureMainWorktreeRoot()`

## Verification

1. `./equin build` — generates migration, no crashes
2. Call `propose_task` via MCP from a conversation: `{ pluginId: "tasks", axis: "test-review", commitHash: "<HEAD>", title: "Test finding" }`
3. `SELECT * FROM plugin_health_reviews` — one row
4. `SELECT * FROM tasks_ext_health_review` — one row linking to the new task
5. Task list shows the new draft task
6. Open plugin-view for `tasks` — health section shows the review with staleness and finding count
7. Drop/complete the task — health section finding counts update
