# Extract tasks/conversations FK-connected schema into `plugins/tasks-core/` — v2 (Repository)

Supersedes [`2026-04-20-global-tasks-core-schema-extract.md`](./2026-04-20-global-tasks-core-schema-extract.md). v1 exposed the raw pgTables from the new plugin's barrel so that `tasks/` and `conversations/` could keep doing SQL in their handlers. Design review flagged this as leaky: once tables are exported, any plugin can import them and run arbitrary queries, defeating the boundary. v2 closes that loophole — tables stay private to `tasks-core`, and all SQL goes through named functions exposed from the barrel. Route handlers become thin parse/dispatch wrappers.

## Context

Two problems stack on top of each other:

1. **The cycle.** `_conversations` has a hard FK to `_attempts`, and the `tasks_v` / `attempts_v` views read `_conversations` to compute derived status. Dodged today by two R4-violating deep imports (`plugins/conversations/server/internal/tables.ts:2`, `plugins/tasks/server/internal/schema.ts:8`).
2. **The leak.** pgTable objects are currently re-exported from `plugins/tasks/server/api.ts` and `plugins/conversations/server/api.ts`. Any plugin can import `_tasks` and run `db.insert(_tasks)`. The Zod schema is the contract; the pgTable is implementation. Contracts should be public, implementations private.

v1 fixed (1) and ignored (2). v2 fixes both by adopting a **repository pattern**: `tasks-core` owns the tables, views, and every SQL operation on them. Consumer plugins receive typed data and Zod schemas, never pgTables.

Trade-off: much larger migration (every handler that does SQL gets rewritten) for a durable boundary — after v2, no non-`tasks-core` file references `_tasks`, `_attempts`, `_taskDependencies`, `_conversations`, or `pushes` by name, and the v2 plugin-boundaries check can enforce this with a simple string grep.

## Design

**`plugins/tasks-core/`** — server-only library plugin. Owns:

- Physical tables (private to `internal/tables.ts`): `_tasks`, `_attempts`, `_taskDependencies`, `_conversations`, `pushes`.
- Derived views (private to `internal/schema.ts`): `tasks`, `attempts`, `conversations`.
- Public Zod schemas + TS types (barrel export): `Task`, `Attempt`, `Push`, `Conversation`, plus their status enums.
- Public query/mutation functions (barrel export): the complete SQL surface consumers need.
- Public resources (mounted on the plugin): `tasksResource`, `attemptsResource`, `pushesResource`, `conversationsResource`. Loaders read views; mutation functions call `.notify()` internally so callers never have to.

**`plugins/tasks/`** and **`plugins/conversations/`** become thin:

- HTTP handlers parse the request (Zod-validated input), call one or more `tasks-core` functions, format the response.
- Plugin-specific logic that doesn't touch DB stays (ranking is now in `tasks-core`; MCP tools, repo-info, runtime adapter, Claude transcript parsing, push watcher's git-side code all stay).
- No direct imports of table symbols. No `db.select()` / `db.insert()` / `db.update()` / `db.delete()`.

**Dependency graph after the move:**

```
tasks-core (schema + repository + resources)
   ↑           ↑              ↑        ↑         ↑
tasks   conversations    agents    build    stats/plugins/tasks
```

All consumers flat. No cycles. Tables accessible nowhere except inside `tasks-core/server/internal/`.

## Public API of `tasks-core`

The barrel (`plugins/tasks-core/server/index.ts`) exports exactly four categories. No pgTables. No pgViews.

### Zod schemas and TS types

```
TaskSchema, Task
AttemptSchema, Attempt
PushSchema, Push
ConversationSchema, Conversation
TaskStatusSchema, TaskStatus
AttemptStatusSchema, AttemptStatus
ConversationStatusSchema, ConversationStatus
```

Generated from the private tables via `drizzle-zod` as today, just located in `tasks-core`.

### Query functions (reads)

Rough enumeration — finalized during migration by enumerating every `db.select()` call site in `tasks/` and `conversations/`:

```
// Tasks
listTasks(filters?: TaskFilters): Promise<Task[]>
getTask(id: string): Promise<Task | null>
listTaskDependencies(taskId: string): Promise<string[]>
findNextRankUnder(parentId: string | null): Promise<string>   // replaces tasks/rank.ts

// Attempts
listAttempts(filters?: AttemptFilters): Promise<Attempt[]>
getAttempt(id: string): Promise<Attempt | null>
listAttemptsForTask(taskId: string): Promise<Attempt[]>

// Pushes
listPushes(filters?: PushFilters): Promise<Push[]>
listPushesForAttempt(attemptId: string): Promise<Push[]>

// Conversations
listConversations(filters?: ConversationFilters): Promise<Conversation[]>
getConversation(id: string): Promise<Conversation | null>
listConversationsForAttempt(attemptId: string): Promise<Conversation[]>
```

`*Filters` types are internal to `tasks-core`, exported as TS types. Fields driven by actual handler call sites — not a generic "any predicate" type.

### Mutation functions (writes)

Each mutation function triggers `.notify()` on the affected resource(s) before returning. Callers never call `.notify()` themselves.

```
// Tasks
createTask(input: CreateTaskInput): Promise<Task>
updateTask(id: string, patch: UpdateTaskPatch): Promise<Task>
deleteTask(id: string): Promise<void>                              // cascades via FK
addTaskDependency(taskId: string, dependsOnId: string): Promise<void>
removeTaskDependency(taskId: string, dependsOnId: string): Promise<void>
ensureMetaTask(): Promise<Task>                                    // replaces tasks/meta-conversations.ts core logic

// Attempts
createAttempt(input: CreateAttemptInput): Promise<Attempt>

// Pushes
insertPush(input: InsertPushInput): Promise<Push>

// Conversations
insertConversation(input: InsertConversationInput): Promise<Conversation>
updateConversation(id: string, patch: UpdateConversationPatch): Promise<Conversation>
deleteConversationRow(id: string): Promise<void>                   // DB-side only; runtime cleanup stays in conversations/
markConversationClosed(id: string, endedAt?: Date): Promise<Conversation>

// Cross-table operations (legitimate multi-table writes)
adoptOrphanConversation(input: AdoptOrphanConversationInput): Promise<{ task: Task; attempt: Attempt; conversation: Conversation }>
```

`adoptOrphanConversation` encapsulates the current `conversations/lifecycle.ts` flow (create task under meta, create attempt, insert conversation) as a single transaction. Other cross-table writes get similar wrapper functions as they surface.

Input types (`CreateTaskInput`, etc.) are Zod schemas — `tasks-core` validates on entry so callers can't smuggle in shapes that violate invariants.

### Resources

```
tasksResource, attemptsResource, pushesResource, conversationsResource
```

Defined with `defineResource` in `tasks-core/server/internal/resources.ts`. Mounted via `ServerPluginDefinition.resources: [...]` on `tasks-core`'s plugin export. Mutation functions call `resource.notify()` internally after commit.

## What stays in `tasks/` and `conversations/`

**`plugins/tasks/server/`:**

- HTTP handlers — now thin: parse request → call `tasks-core` function → return Response. One-to-many is fine (a single handler may call multiple `tasks-core` functions).
- `mcp-tools.ts` — MCP tool registration; tool implementations call `tasks-core` functions.
- `push-watcher.ts` — git-side watching logic; when a new push is detected, calls `insertPush()` in `tasks-core`.
- `CONVERSATIONS_META_TASK_ID` — moves to `tasks-core` as a public constant (it's a schema-level invariant, not a tasks-plugin detail).
- `rank.ts` / `nextRankUnder` — moves to `tasks-core` (touches `_tasks`).
- `meta-conversations.ts` — the core logic (ensure meta-task exists) moves to `tasks-core.ensureMetaTask()`; the `tasks/` plugin keeps whatever scheduling/startup code invokes it.

**`plugins/conversations/server/`:**

- HTTP handlers — thin, per above.
- `Runtime`, `ConversationRuntime`, `RuntimeInfo`, `Turn`, `ConversationModel` — runtime/domain types, unrelated to DB. Stay.
- `createConversation` (high-level) — orchestrates DB insert (`insertConversation` in `tasks-core`) + runtime spawn. The orchestrating wrapper stays in `conversations/`; the DB insert goes through `tasks-core`.
- `deleteConversation` (high-level) — orchestrates runtime shutdown + DB delete (`deleteConversationRow`). Stays in `conversations/`.
- `readConversationTurns` — reads JSONL transcript files from disk. No DB. Stays.
- `claude-transcript.ts` — transcript parsing. Stays.
- `db-fork.ts` — `pg_dump | pg_restore` for worktree DB bootstrap. Touches Postgres via shell, not Drizzle. Stays.
- `fork-errors.ts` — fork error tracking (may or may not use DB; review during migration).
- `poller.ts` — reads conversations + correlates with tasks/attempts. Rewrites to call `tasks-core.listConversations()`, `listTasks()`, `listAttempts()`, and mutation functions; no direct SQL.
- `lifecycle.ts` — the orphan-adoption flow becomes a single call to `tasks-core.adoptOrphanConversation()`. The scheduling/trigger logic stays.

## Cross-plugin consumer rewrites

All three must switch from pgTable imports to `tasks-core` functions:

| File | Was | Becomes |
|---|---|---|
| `plugins/agents/server/internal/handle-launch.ts:7-8` | imports `_tasks`, `nextRankUnder`, `tasksResource`; runs `db.insert(_tasks)` and `nextRankUnder(...)` | `tasks-core.createTask({ ... })` (which internally handles ranking and notification) |
| `plugins/build/server/internal/auto-build-watcher.ts:2` | imports `pushes`; runs `db.select().from(pushes)` | `tasks-core.listPushes({ ... })` or subscribe to `pushesResource` |
| `plugins/stats/plugins/tasks/server/internal/handle-cumulative.ts:3` | imports `tasks` view, `CONVERSATIONS_META_TASK_ID` | `tasks-core.listTasks({ excludeParentId: CONVERSATIONS_META_TASK_ID })` (filter added to `TaskFilters` if not already present); `CONVERSATIONS_META_TASK_ID` from `tasks-core` |

If any of these has a query shape that doesn't fit the initial API, add a named function to `tasks-core` — don't smuggle in raw SQL access as an "escape valve."

## File layout

```
plugins/tasks-core/
  package.json              # name: "@singularity/plugin-tasks-core"
  server/
    tsconfig.json
    index.ts                # default export: ServerPluginDefinition { id, contributions: [], resources: [...] }
                            # named exports: Zod + types + query/mutation functions + CONVERSATIONS_META_TASK_ID
    internal/
      tables.ts             # pgTables (private)
      schema.ts             # pgViews + Zod wrappers + TS types (private; Zod re-exported via index.ts)
      resources.ts          # defineResource() for the four resources; loaders reference internal queries
      queries/
        tasks.ts            # listTasks, getTask, findNextRankUnder, etc.
        attempts.ts
        pushes.ts
        conversations.ts
      mutations/
        tasks.ts            # createTask, updateTask, deleteTask, addTaskDependency, ...
        attempts.ts
        pushes.ts
        conversations.ts
        cross-table.ts      # adoptOrphanConversation, ensureMetaTask, ...
```

Subfolders inside `internal/` are organizational only — still a single barrel, still all private by R4. The split keeps the files tractable.

## Migration strategy — incremental, not big-bang

Rewriting every handler at once risks weeks of broken state. Migrate handler-by-handler.

### Phase 1 — scaffolding (single commit, no behavior change)

1. Create `plugins/tasks-core/` skeleton: `package.json`, tsconfig, empty `index.ts` with `ServerPluginDefinition { id: "tasks-core", contributions: [], resources: [] }`, empty `internal/{tables,schema,resources}.ts` + `queries/` + `mutations/` folders.
2. Register in `server/src/plugins.ts` (load first, before `tasks`/`conversations`).
3. Move tables (5) into `tasks-core/server/internal/tables.ts`.
4. Move views (3) and Zod schemas into `tasks-core/server/internal/schema.ts`.
5. Update `server/src/db/schema.ts` aggregator to point at `tasks-core` instead of `tasks`/`conversations` for the migrated tables.
6. Delete `plugins/tasks/server/internal/tables.ts`, `plugins/tasks/server/internal/schema.ts`, `plugins/conversations/server/internal/tables.ts`, `plugins/conversations/server/internal/schema.ts`.
7. **Temporarily** re-export tables from `tasks/` and `conversations/`'s barrels so existing code still compiles:

   ```typescript
   // plugins/tasks/server/api.ts — temporary shim
   export { _tasks, _attempts, _taskDependencies, pushes, tasks, attempts, ... } from "@plugins/tasks-core/server/internal/tables";
   // Will be deleted in Phase 3 once every consumer migrates.
   ```

   This shim is a deliberate, *transient* R4 violation marked with a `// MIGRATION:` comment. It exists so Phase 2 can proceed handler-by-handler without breaking the build.
8. `./equin build`. No migration generated (DDL unchanged). Server comes up. Cycle gone (internally — shim papers over external view).

### Phase 2 — handler-by-handler rewrite (many small commits)

For each handler in `tasks/` and `conversations/`:

1. Identify the SQL it runs.
2. Add the corresponding query/mutation function to `tasks-core/server/internal/{queries,mutations}/*.ts`, exported from `tasks-core/server/index.ts`.
3. Rewrite the handler to call the new function. Delete the now-dead SQL imports.
4. `./equin build`, smoke-test the endpoint.

Order suggestion (lowest risk first):

1. Simple reads: `tasks/handle-get`, `tasks/handle-list`, `conversations/handle-get`, `conversations/handle-list`.
2. Simple writes: `tasks/handle-create`, `tasks/handle-update`, `tasks/handle-delete`, `conversations/handle-close`.
3. Join-heavy reads: anything hitting views.
4. Cross-table writes: `conversations/handle-create` + `lifecycle.ts` orphan adoption, `tasks/handle-dependencies`.
5. Background workers: `poller.ts`, `push-watcher.ts`, `meta-conversations.ts`.
6. Cross-plugin consumers: `agents/handle-launch.ts`, `build/auto-build-watcher.ts`, `stats/handle-cumulative.ts`.

Commits are small, revertable, and each leaves the build green.

### Phase 3 — delete the shim

Once Phase 2 is complete and no non-`tasks-core` file references `_tasks`, `_attempts`, `_taskDependencies`, `_conversations`, or `pushes`:

1. Delete the temporary re-exports from `tasks/server/api.ts` and `conversations/server/api.ts`.
2. Run `grep -r "_tasks\|_attempts\|_taskDependencies\|_conversations\|pushes" plugins/ --include="*.ts" | grep -v "tasks-core"` — expect zero matches (modulo string literals in migrations or tests).
3. Move resources (`tasksResource`, `attemptsResource`, `pushesResource`, `conversationsResource`) from their current plugins to `tasks-core`. Update consumers that subscribe. Remove the resource mounts from `tasks/` and `conversations/`'s `ServerPluginDefinition`.
4. Move `CONVERSATIONS_META_TASK_ID`, `nextRankUnder` (as `findNextRankUnder`), and `ensureMetaTask` core logic from `tasks/` to `tasks-core`. Update consumers.
5. `./equin build`. Final state: `tasks-core` owns schema + repository + resources; `tasks` and `conversations` are purely HTTP + runtime + plugin-specific plumbing.

## Resources — ownership transition

Resources are defined with `defineResource({ key, mode, loader })` and mounted on a plugin's `resources: []`. Today:

- `tasks/` mounts `tasksResource`, `attemptsResource`, `pushesResource`.
- `conversations/` mounts `conversationsResource`.
- Mutation handlers call `resource.notify()` after DB writes.

After v2:

- `tasks-core` mounts all four resources.
- Loaders read the derived views via `tasks-core` queries.
- `tasks-core` mutation functions call `.notify()` internally — callers never do.

This eliminates the "does the caller remember to notify?" class of bug.

Resource keys (`tasks`, `attempts`, `pushes`, `conversations`) stay the same, so clients are unaffected.

## Modularity safeguards

1. **No `export *` in `tasks-core/server/index.ts`.** Every public symbol enumerated. Prevents accidental leakage of helpers.
2. **No pgTable names outside `tasks-core/server/internal/`.** Enforceable by grep; becomes a candidate check to bolt onto the v2 plugin-boundaries work.
3. **No `db.select()` / `db.insert()` / `db.update()` / `db.delete()` on these tables outside `tasks-core/server/internal/`.** Same enforcement mechanism.
4. **One subfolder per table family** (`queries/tasks.ts`, `mutations/tasks.ts`, etc.). Keeps per-file scope manageable as the API grows.
5. **Input Zod validation at every mutation entry.** `createTask(input: CreateTaskInput)` calls `CreateTaskInputSchema.parse(input)` first. Consumers can't pass arbitrary shapes.

## Files to create / modify / delete

### Create

- `plugins/tasks-core/package.json`
- `plugins/tasks-core/server/tsconfig.json`
- `plugins/tasks-core/server/index.ts`
- `plugins/tasks-core/server/internal/tables.ts`
- `plugins/tasks-core/server/internal/schema.ts`
- `plugins/tasks-core/server/internal/resources.ts`
- `plugins/tasks-core/server/internal/queries/{tasks,attempts,pushes,conversations}.ts`
- `plugins/tasks-core/server/internal/mutations/{tasks,attempts,pushes,conversations,cross-table}.ts`

### Modify

- `server/src/plugins.ts` — register `tasks-core` (load first; update load-order comment)
- `server/src/db/schema.ts` — two `@plugins/tasks-core/server/internal/{tables,schema}` lines replace the four `tasks`/`conversations` lines
- Every handler in `plugins/tasks/server/internal/handle-*.ts` — call `tasks-core` functions
- Every handler in `plugins/conversations/server/internal/handle-*.ts` — call `tasks-core` functions
- `plugins/tasks/server/internal/poller.ts`, `push-watcher.ts`, `meta-conversations.ts`, `mcp-tools.ts` — call `tasks-core` functions
- `plugins/conversations/server/internal/poller.ts`, `lifecycle.ts` — call `tasks-core` functions
- `plugins/tasks/server/api.ts` — remove table/view/type re-exports; keep helper re-exports that don't reference tables
- `plugins/conversations/server/api.ts` — same
- `plugins/agents/server/internal/handle-launch.ts` — rewrite to `tasks-core.createTask(...)`
- `plugins/build/server/internal/auto-build-watcher.ts` — rewrite to `tasks-core.listPushes(...)` or resource subscription
- `plugins/stats/plugins/tasks/server/internal/handle-cumulative.ts` — rewrite to `tasks-core.listTasks(...)`
- `CLAUDE.md`, `server/CLAUDE.md` — update to reflect the repository pattern and new plugin

### Delete

- `plugins/tasks/server/internal/tables.ts`
- `plugins/tasks/server/internal/schema.ts`
- `plugins/tasks/server/internal/rank.ts` (moves to `tasks-core`)
- `plugins/conversations/server/internal/tables.ts`
- `plugins/conversations/server/internal/schema.ts`

## Non-scope (deliberately deferred)

- **Adding an enforceable "no raw SQL outside tasks-core" check to the v2 plugin-boundaries work.** The grep-based check is straightforward; codifying and wiring it is follow-up.
- **Collapsing `api.ts` into `index.ts`** (v2 plugin-boundaries R1). Orthogonal; do after this lands.
- **Moving Runtime/ConversationRuntime/Turn to `tasks-core`.** They're not schema.
- **Restructuring `conversations/` into nested under `tasks-core/`.** Sibling layout is cheaper.
- **Amending the v1 plan's sibling consumers (agents/build/stats).** This plan covers them; nothing additional needed.

## Verification

1. **Phase 1 gate.** After scaffolding + table move + shim, `./equin build` succeeds, app comes up at `http://<worktree>.localhost:9000`, `docs/plugins.md` shows `tasks-core` with no exports yet (barrel is empty except resources). No migration generated.
2. **Each Phase 2 handler migration.** After each handler rewrite, exercise its endpoint:
   - Task CRUD: create/list/update/delete via UI. Status derivations match pre-migration.
   - Conversation CRUD: create an attempt, launch a conversation, close it. Transitions match.
   - Dependencies: add/remove a task dep; blocked status computes correctly.
3. **Phase 3 gate — grep invariants.**
   - `grep -rn "@plugins/tasks/server/internal" plugins/` → zero matches.
   - `grep -rn "@plugins/conversations/server/internal" plugins/` → zero matches.
   - `grep -rEn "\\b(_tasks|_attempts|_taskDependencies|_conversations|pushes)\\b" plugins/ --include="*.ts" | grep -v "tasks-core/"` → zero matches (verify no false positives from string literals).
   - `grep -rEn "db\\.(select|insert|update|delete)" plugins/ --include="*.ts" | grep -v "tasks-core/"` → zero matches on the migrated tables.
4. **Docgen.** `./equin build` regenerates `docs/plugins.md` with `tasks-core` listing all public functions + Zod types; `tasks` and `conversations` no longer list moved symbols. `./equin check --plugins-doc-in-sync` passes.
5. **End-to-end smoke test.**
   - Agent launch flow (uses `tasks-core.createTask`): create an agent, click launch, confirm a task + attempt + conversation appear and run.
   - Build/push flow (uses `tasks-core.insertPush` + `pushesResource`): push a commit via `./equin push` on a throwaway branch; confirm `pushesResource` updates and auto-build-watcher fires.
   - Stats chart (uses `tasks-core.listTasks`): open `/stats`, confirm active-tasks chart renders.
6. **Cycle gone.** Attempting to re-introduce the deep imports (`@plugins/*/server/internal/tables`) in `conversations/` or `tasks/` fails the v2 plugin-boundaries check once wired. Confirm by staging a contrived violation, running the check, observing the failure, then reverting.
7. **No migration generated.** Run `./equin check --migrations-in-sync` — passes. Table DDL is identical to pre-migration; only code location changed.
