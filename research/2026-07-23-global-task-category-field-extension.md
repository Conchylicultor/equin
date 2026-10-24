# Task category as a field extension (replacing meta-folder parenting)

## Context

Today, system-filed tasks are organized by parenting them under five boot-ensured
**meta-folder tasks** (`task-meta-conversations`, `task-meta-system`,
`task-meta-agents`, `task-meta-improvements`, `task-meta-reports`), each registered
in the `container-tasks` contribution registry so it can never own an attempt.
This conflates two concerns: *what kind of task this is* (a categorical dimension)
and *where it sits in the user's folder hierarchy* (organization). The folders are
fake tasks that need guards, Launch-affordance gating, and cluster-walk
special-casing everywhere.

This change replaces the mechanism with a **registry-driven category field**:

- A new `tasks_ext_category` entity-extension side-table holds a per-task category.
- Each filing plugin **contributes** its category (id + label + order) via a server
  contribution registry — the category plugin names no consumer.
- The tasks DataView **groups by** this field; grouping requires adding generic
  root-level groupBy support to the data-view **tree** view (currently
  `supportsGroupBy: false`).
- Category is **system-set only** (no user picker).
- The meta-folder mechanism (folders, registry, guard, gating) is **fully removed**,
  with an extra-careful data migration: backfill category from folder membership,
  re-root children, and delete a meta row only when provably childless.

Decisions confirmed by the user: registry-driven enum; system-set only; full
removal with cautious migration (never delete a meta folder that still has
children); generic tree groupBy.

## Design

### New plugin: `plugins/tasks/plugins/task-category/`

Mirrors the entity-extensions consumer convention (see
`plugins/infra/plugins/entity-extensions/CLAUDE.md`; templates: `task-effort` for
layout, `starred` for the resource + DataView field).

| File | Contents |
|---|---|
| `core/contribution.ts` | `TaskCategory = defineServerContribution<{id: string; label: string; order?: number}>("taskCategory")` |
| `core/endpoints.ts` | `listTaskCategories = defineEndpoint({ route: "GET /api/tasks/categories", response: { categories: [{id,label,order}] } })` |
| `server/internal/tables.ts` | `tasksCategory = defineExtension(_tasks, "category", { category: text("category").notNull() })`; re-export `_tasksCategoryExt = tasksCategory.table` (drizzle-kit glob pickup; keep the file synchronously require()-able) |
| `server/internal/mutations.ts` | `setTaskCategory(taskId, category \| null)` (upsert / delete), `getTaskCategory(taskId)` |
| `server/internal/resource.ts` | `queryResource(taskCategoriesDescriptor, { from: _tasksCategoryExt, select: { parentId, category } })` — the **keyed** query-resource, exactly the `starred` shape (per-row deltas). Bounded-ness note: 1:1 with `tasks`, co-bounded with the already-boot-critical unbounded-legacy `tasks` resource; migrates together with it when tasks moves to the bounded contract. |
| `shared/resources.ts` | `taskCategoriesResource = queryResourceDescriptor<{parentId, category}>("task-categories", schema, "parentId")`, declared **bootCritical** so the default grouped view doesn't flash "None" on first paint (register the descriptor eagerly like tasks-core's web barrel does) |
| `server/internal/handle-list-categories.ts` | reads `TaskCategory` contributions, sorts by `order ?? 0`, static after boot |
| `server/index.ts` | exports `TaskCategory`, `setTaskCategory`, `getTaskCategory`; `Resource.Declare(...)`; the endpoint route |
| `web/hooks.ts` | `useTaskCategories()` (cached forever, like the old `useContainerTaskIds`), `useTaskCategoryMap()` (`Map<taskId, categoryId>` from the live resource) |
| `web/components/category-field.tsx` | `CategoryField` — FieldExtension component (twin of `starred-field.tsx`): yields one `FieldDef<TaskListItem>` `{ id: "category", label: "Category", type: "enum", options: <from registry, ordered>, value: (t) => map.get(t.id) ?? null }`. `enum` + `value` ⇒ groupable by default; options order drives section order. |
| `web/index.ts` | contributes `Tasks.Fields({ id: "category", component: CategoryField })` |

DAG legality (verified): `plugins/tasks/server` already imports child barrels
(tasks-core, task-title, task-preprompt), so it may import
`@plugins/tasks/plugins/task-category/server`. `conversations/server` and
`agents/server` already import `tasks-core/server` — same class of edge.
`task-category` imports only `tasks-core` (sibling), `entity-extensions`,
`query-resource`, and (web) `task-list` — no cycle.

### task-list: the Fields slot

- `plugins/tasks/plugins/task-list/web/slots.ts`: add
  `Fields: defineFieldExtensions<TaskListItem>("tasks.fields")` to the `Tasks` object.
- `plugins/tasks/plugins/task-list/web/components/tasks-list-view.tsx`: pass
  `fieldExtensions={Tasks.Fields}` to `<DataView>`. (The host folds extensions into
  the schema before the sort/filter controllers — Group by picks it up for free.)

### Generic tree groupBy (`plugins/primitives/plugins/data-view/plugins/tree/`)

- `web/index.ts`: remove `supportsGroupBy: false`.
- `web/components/tree-view.tsx`, after `sortedProjected` is computed:
  - No `state.groupBy` (or field unresolvable / lacks `value`) → current path,
    byte-for-byte.
  - Grouped path:
    1. Roots = projected rows whose `parentId` is null or not in the projected id
      set (same orphan rule as `buildTree`).
    2. `partitionIntoSections(roots, fields, groupBy, rowKey)` — reuses the shared
      pure partition: enum-option section order + "None" bucket for free.
    3. Bucket **all** projected rows by their root ancestor's section (climb
      `parentId`); children follow their root regardless of their own value.
    4. Render `<GroupedSections sections collapsedSections setSectionCollapsed>`
      (already threaded in `DataViewRenderProps`) with one `<TreeList>` per section.
  - **DnD suspended while grouped**, extending the existing sort-suspension idiom:
    `const onMove = sortActive || groupActive || !hierOnMove ? undefined : wrappedOnMove;`
    Rationale: a per-section `TreeList` sees only its section's roots — a
    within-section root reorder could mint a rank colliding with a hidden root of
    another section (the documented filtered-projection hazard). Mirrors
    sort-suspends-DnD; `onCreate` stays enabled.
  - Nothing task-specific: the tree reads only `state.groupBy`, `fields`, and the
    shared partition/chrome. Windowing unchanged (per-section `TreeList` windows at
    100 visible rows).

### Consumer migration (5 filing paths)

Each owner contributes its category and stamps `setTaskCategory` instead of
passing `folderId`:

1. **conversations** — `plugins/conversations/server/internal/lifecycle.ts`
   (~120–134): drop the meta `folderId` selection and the `assertNotContainerTask`
   call; `createTask({ title: "Untitled", author: spawnedBy })` then
   `setTaskCategory(task.id, kind === "system" ? "system" : "conversations")`.
   `conversations/server/index.ts` contributes
   `TaskCategory({ id: "conversations", label: "Conversations", order: 0 })` and
   `TaskCategory({ id: "system", label: "System", order: 1 })`; delete
   `meta-system.ts` wiring.
2. **agents** — `plugins/conversations/plugins/agents/server/internal/handle-launch.ts`:
   root `createTask` + `setTaskCategory(task.id, "agents")`. Contribute
   `{ id: "agents", label: "Agents", order: 2 }`; delete `meta-agents.ts`.
3. **improve** — `plugins/improve/shared/constants.ts`:
   `IMPROVEMENTS_META_TASK_ID` → `IMPROVEMENTS_CATEGORY_ID = "improvements"`.
   `improve-button.tsx` target → `{ kind: "category", categoryId: IMPROVEMENTS_CATEGORY_ID }`.
   Contribute `{ id: "improvements", label: "Improvements", order: 3 }`; delete
   `meta-improvements.ts`.
4. **reports-investigation** — `register.ts`: keep the sink registration; the
   handler does root `createTask({ title, description, author })` +
   `setTaskCategory(task.id, "reports")`. Contribute
   `{ id: "reports", label: "Reports", order: 4 }`; drop `ensureMetaTask` +
   `ContainerTask`.
5. **tasks umbrella** — `plugins/tasks/server/index.ts`: drop
   `ensureConversationsMetaTask`, `backfillConversationsMetaParent`, and the
   `ContainerTask` contribution. `backfillMetaParent`'s intent (re-homing orphan
   attempt-owning roots) becomes a one-time clause in the data migration — no
   runtime replacement.

**`TaskChainTarget`** (`plugins/tasks/core/task-chain-types.ts`):

```ts
z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("category"), categoryId: z.string().min(1) }),
  z.object({ kind: z.literal("folder"), folderTaskId: z.string().min(1) }),
  z.object({ kind: z.literal("root") }),   // top-level, no folder, no category
]);
```

`plugins/tasks/server/internal/handle-create-chain.ts`: `folder` → unchanged
(verify folder exists, `createTask({ folderId, ... })`). `category`/`root` → root
`createTask`; for `category` stamp `setTaskCategory` on **every card's task** (all
cards share the folder today — mirror that). Author heuristic stays shape-preserving:
`kind === "category" ? "improve-plugin" : "user"` (pre-existing coupling, out of scope).

**`task-dependencies`**
(`plugins/tasks/plugins/task-dependencies/web/components/task-dependencies.tsx`):
delete the local `CONVERSATIONS_META_TASK_ID` const and its `folderCandidate`
exclusion (root tasks already return null via the `!task?.folderId` check).
`targetForSibling`: `folder` when the sibling has a `folderId`; else
`{ kind: "category", categoryId }` when `useTaskCategoryMap()` has one for the
sibling; else `{ kind: "root" }`.

### Data migration (extra-careful; tasks data is critical)

**(A) Schema (committed)**: adding `defineExtension` + `./equin build`
auto-emits `CREATE TABLE tasks_ext_category (...)` (FK CASCADE to tasks). This is
the only committed migration — DDL only, creates an empty table, harmless to
auto-apply everywhere.

**(B) Data (MANUAL, not committed)**: per the user's direction, the
backfill/re-root/delete DML is **not** a committed auto-running migration. The
agent executes it by hand via `psql` against the embedded cluster (socket
`~/.singularity/postgres/socket`, port 5433, user `singularity`; the session's
permission mode allows direct psql — the read-only `query_db` MCP tool cannot do
this). Sequence:

1. **Rehearse on the worktree fork DB** (this worktree's database): run the SQL
   below inside an explicit `BEGIN`, verify counts with SELECTs *before*
   `COMMIT`, then test the UI end-to-end on the worktree deployment.
2. **After** the branch is reviewed, pushed, and main's server has restarted on
   the new code (so nothing recreates the meta folders or files new tasks under
   them), run the same SQL against the **`singularity`** (main) database, again
   `BEGIN` → verify → `COMMIT`, with the user in the loop. Until this step runs,
   main briefly shows the old meta rows and their children in the "None" group —
   acceptable transitional state, nothing is lost.

The SQL (one transaction; step order matters):

```sql
-- 1. Stamp category from folder membership (×5 mappings)
INSERT INTO tasks_ext_category (parent_id, category)
SELECT id, 'conversations' FROM tasks WHERE folder_id = 'task-meta-conversations'
ON CONFLICT (parent_id) DO NOTHING;
-- ... repeat: system / agents / improvements / reports
--> statement-breakpoint
-- 2. (replaces backfillMetaParent, one-shot) orphan attempt-owning roots → conversations
INSERT INTO tasks_ext_category (parent_id, category)
SELECT t.id, 'conversations' FROM tasks t
WHERE t.folder_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM tasks_ext_category e WHERE e.parent_id = t.id)
  AND EXISTS (SELECT 1 FROM attempts a WHERE a.task_id = t.id)
ON CONFLICT (parent_id) DO NOTHING;
--> statement-breakpoint
-- 3. Re-root children (ranks kept; see note below)
UPDATE tasks SET folder_id = NULL WHERE folder_id IN (<the 5 meta ids>);
--> statement-breakpoint
-- 4. Delete meta rows ONLY when provably childless (FK is CASCADE — the guard
--    makes an accidental cascade structurally impossible)
DELETE FROM tasks t
WHERE t.id IN (<the 5 meta ids>)
  AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.folder_id = t.id);
```

Ordering: stamp (1,2) before re-root (3) — the `folder_id = '<meta>'` predicates
must still match — before the guarded delete (4). The guarded `NOT EXISTS` on
step 4 means the CASCADE FK can never fire on a live child even if a step is
re-run or partially applied.

**Rank ties**: re-rooted children from different metas share the null-folder rank
space with possible duplicate ranks. Harmless under the default grouped view
(sections never rank-compare across categories; within a section only one former
meta's children appear). Cosmetic only in an ungrouped tree; no SQL re-ranking.

### Removal

- Delete `plugins/tasks/plugins/container-tasks/` (registries regenerate on build).
- Delete the four `meta-*.ts` files; remove `ensureMetaTask` / `backfillMetaParent`
  from `tasks-core/server/internal/mutations/tasks.ts` and the
  `CONVERSATIONS_META_TASK_ID` export (grep for stragglers before deleting).
- Remove `assertNotContainerTask` call + import in `lifecycle.ts`.
- Web: `task-description.tsx` and `launch-agent-action.tsx` drop
  `useIsContainerTask` — Launch becomes unconditional (correct: no unattemptable
  rows remain). `deps-tree-section.tsx` drops the container-id gate — **verify
  during implementation** that the cluster walk stays bounded without it (the gate
  existed to stop fan-out through the mega-hub folders, which no longer exist).

### Default view config

`config/tasks/task-list/tasks-list.jsonc`: add `"groupBy": "category"` to the
tree view blob (precedent: `groupBy` keys in `studio.compositions.jsonc`,
`conversations-sidebar-queue.jsonc`). Hash regenerates on build.

## Execution order

1. Phase A — tree groupBy (self-contained, testable on any DataView via the
   Group-by setting once a groupable field exists).
2. Phase B — task-category plugin + task-list Fields slot + build (schema
   migration A generated here).
3. Phase C — consumer migration (5 paths + chain target + task-dependencies) +
   removal of container-tasks/meta wiring; build.
4. Phase D — **manual** DML against the worktree fork DB (BEGIN → verify →
   COMMIT); verify UI end-to-end on the worktree deployment.
5. Phase E — after user review + push + main restart: the same manual DML
   against the main `singularity` DB, with the user in the loop.

## Verification

- `./equin build` green (checks include `migrations-in-sync`, boundaries,
  type-check).
- `query_db` (worktree DB): pre-migration `SELECT folder_id, count(*) FROM tasks
  WHERE folder_id IN (<5 metas>) GROUP BY 1` vs post-migration per-category counts
  in `tasks_ext_category`; then `count(*) FROM tasks WHERE folder_id IN (...)` = 0
  and `count(*) FROM tasks WHERE id IN (...)` = 0 after the guarded delete.
- Playwright (`e2e/screenshot.mjs`) on `http://<worktree>.localhost:9000/tasks`:
  sections Conversations / System / Agents / Improvements / Reports / None render
  with subtrees; section collapse works; DnD suspended while grouped.
- Exercise each filing path and confirm the new task lands in its section:
  Improve button, report → Investigate, agent launch, new conversation.

## Critical files

- `plugins/primitives/plugins/data-view/plugins/tree/web/components/tree-view.tsx` (+ `web/index.ts`)
- `plugins/primitives/plugins/data-view/web/internal/{use-data-view-sections.ts,grouped-sections.tsx}` (reused, not modified)
- `plugins/tasks/plugins/task-list/web/{slots.ts,components/tasks-list-view.tsx,internal/tasks-data-view.tsx}`
- `plugins/tasks/server/internal/handle-create-chain.ts`, `plugins/tasks/core/task-chain-types.ts`
- `plugins/conversations/server/internal/lifecycle.ts`
- `plugins/conversations/plugins/agents/server/internal/handle-launch.ts`
- `plugins/tasks/plugins/reports-investigation/server/internal/register.ts`
- `plugins/improve/{shared/constants.ts,web/components/improve-button.tsx,server/index.ts}`
- `plugins/tasks/plugins/task-dependencies/web/components/task-dependencies.tsx`
- Templates: `plugins/apps/plugins/pages/plugins/starred/` (resource + field), `plugins/tasks/plugins/task-effort/` (layout)
- `config/tasks/task-list/tasks-list.jsonc`

## Risks / notes

- **deps-tree cluster walk** without the container gate: verify boundedness during
  implementation (expected fine once hub folders are gone).
- **Rank ties** among re-rooted roots: cosmetic, only in an ungrouped tree.
- Two categories (`conversations`, `system`) owned by one plugin — fine, the
  registry is a flat list.
- The category resource follows the `starred` keyed queryResource shape, which is
  itself on the legacy-pending-migration list for the bounded-working-set
  contract; it is 1:1 with the tasks collection and will migrate alongside it.
