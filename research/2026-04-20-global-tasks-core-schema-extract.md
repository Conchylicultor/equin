# Extract tasks/conversations FK-connected schema into `plugins/tasks-core/`

## Context

`plugins/tasks/` and `plugins/conversations/` currently own overlapping physical tables that reference each other:

- `_conversations` (in `conversations/`) has a hard FK to `_attempts` (in `tasks/`).
- The `tasks_v` and `attempts_v` views (in `tasks/`) read from `_conversations` to derive task/attempt status.

This is a cycle in the schema dependency graph. It is currently papered over by two deliberate R4 violations that the v2 plugin-boundaries plan would have to whitelist:

- `plugins/conversations/server/internal/tables.ts:2` deep-imports `_attempts` from `@plugins/tasks/server/internal/tables`.
- `plugins/tasks/server/internal/schema.ts:8` deep-imports `_conversations` from `@plugins/conversations/server/internal/tables`.

Both files carry comments explaining that the deep path is *required* — routing through `server/api` would pull in the importer's views and trigger a runtime initialization cycle. The cycle is real; the deep-path exception only hides it.

The same cycle also forces awkward workarounds elsewhere: `server/src/db/schema.ts` has to load leaf `tables.ts` files before `schema.ts` files (see the load-order comment), and routes that span both domains (`poller.ts`, `lifecycle.ts`, `meta-conversations.ts`) sit in whichever plugin drew the short straw.

**Outcome.** This plan moves the FK-connected schema — tables, views, Zod schemas, types — into a new library plugin `plugins/tasks-core/`. `tasks` and `conversations` become pure UI + routes plugins that consume the schema from `@plugins/tasks-core/server`. The cycle disappears (one plugin owns the whole graph), the two deep-path exceptions can be removed, and the v2 plugin-boundaries check can run without special cases for this domain.

Route handlers, resources, pollers, and domain-specific helpers (ranking, meta-task lifecycle) stay in their current plugins — this plan moves schema only. See §"Non-scope" for what deliberately stays put.

## Design

**New plugin: `plugins/tasks-core/`** — a server-only library plugin (R8 shape: `contributions: []`). Owns all physical tables and derived views in the tasks-attempt-conversation-push domain. No HTTP routes, no resources, no UI.

The plugin's name follows its domain role: it's the schema substrate that `tasks`, `conversations`, `agents`, `build`, and `stats` all depend on. "Core" here means "shared foundation," not "framework infra" — it's a regular plugin, not a privileged file.

**Dependency graph after the move:**

```
tasks-core (schema, types)
   ↑        ↑
tasks    conversations    agents, build, stats, ...
```

All consumers import via the barrel (`@plugins/tasks-core/server`). No deep-path imports needed. No cycles.

## What moves into `tasks-core`

**From `plugins/tasks/server/internal/tables.ts`:**

- `_tasks`, `_attempts`, `_taskDependencies`, `pushes` (pgTables)

**From `plugins/tasks/server/internal/schema.ts`:**

- `attempts`, `tasks` (pgViews)
- `TaskStatusSchema`, `TaskStatus`, `AttemptStatusSchema`, `AttemptStatus` (Zod + types)
- `TaskSchema`, `Task`, `AttemptSchema`, `Attempt`, `PushSchema`, `Push` (Zod + types)

**From `plugins/conversations/server/internal/tables.ts`:**

- `_conversations` (pgTable)

**From `plugins/conversations/server/internal/schema.ts`:**

- `conversations` (pgView)
- `ConversationSchema`, `Conversation` (Zod + type)
- `ConversationStatusSchema`, `ConversationStatus` (Zod + type, if declared here — otherwise stays with `status.ts`)
- `ConversationModelSchema`, `ConversationModel` — **stays in conversations** (these are UI-level enums, not DB schema). Verify at migration time; move only if they back a `.$type<...>()` column and need to be importable from `tasks-core` to avoid a back-reference.

## What stays put

**In `plugins/tasks/server/`:**

- All HTTP handlers (`handle-create.ts`, `handle-delete.ts`, `handle-dependencies.ts`, `handle-get.ts`, `handle-list.ts`, `handle-repo-info.ts`, `handle-update.ts`)
- Resources (`tasksResource`, `attemptsResource`, `pushesResource` in `internal/resources.ts`)
- `push-watcher.ts` (writes `pushes`; imports `pushes` from `tasks-core`)
- `meta-conversations.ts` (touches both `_tasks` and `_attempts`; imports from `tasks-core`)
- `mcp-tools.ts`, `rank.ts` (`nextRankUnder`), and the `CONVERSATIONS_META_TASK_ID` constant

**In `plugins/conversations/server/`:**

- All HTTP handlers
- `conversationsResource`
- `poller.ts`, `lifecycle.ts`, `db-fork.ts`, `fork-errors.ts`, `claude-transcript.ts`
- `createConversation`, `deleteConversation`, `getConversationRow`, `readConversationTurns` (public API of the plugin)
- `Runtime`, `ConversationRuntime`, `RuntimeInfo`, `Turn` (runtime types, not schema)
- `model.ts`, `status.ts` (enum definitions — unless moved per the note above)

**Rationale.** Routes encode plugin-specific *behavior* over shared *state*. Task ranking, meta-task management, conversation forking, push watching — none of these are generic over the schema. They belong with the plugin that serves the UI for that concept.

## Consumer updates

Cross-plugin consumers already import via the barrel — path changes only:

| Consumer | Was | Becomes |
|---|---|---|
| `plugins/agents/server/internal/handle-launch.ts:7-8` | `@plugins/tasks/server` (for `_tasks`, `nextRankUnder`, `tasksResource`) | Tables/views from `@plugins/tasks-core/server`; helpers (`nextRankUnder`, `tasksResource`) from `@plugins/tasks/server` |
| `plugins/build/server/internal/auto-build-watcher.ts:2` | `pushes` from `@plugins/tasks/server` | `pushes` from `@plugins/tasks-core/server` |
| `plugins/stats/plugins/tasks/server/internal/handle-cumulative.ts:3` | `tasks` view, `CONVERSATIONS_META_TASK_ID` from `@plugins/tasks/server` | `tasks` view from `@plugins/tasks-core/server`; `CONVERSATIONS_META_TASK_ID` from `@plugins/tasks/server` |

Internal consumers (within `tasks/` and `conversations/`) switch their imports:

- `plugins/tasks/server/internal/{resources,handle-*,push-watcher,meta-conversations}.ts` → import tables/views/types from `@plugins/tasks-core/server`
- `plugins/conversations/server/internal/{resources,handle-*,poller,lifecycle}.ts` → import tables/views/types from `@plugins/tasks-core/server`

The two deep-path imports that caused the cycle are **deleted**:

- `plugins/conversations/server/internal/tables.ts:2` (was: `@plugins/tasks/server/internal/tables`)
- `plugins/tasks/server/internal/schema.ts:8` (was: `@plugins/conversations/server/internal/tables`)

Both files move into `tasks-core` and reference their siblings locally.

## File layout inside `tasks-core/`

```
plugins/tasks-core/
  package.json              # name: "@singularity/plugin-tasks-core"
  server/
    index.ts                # default export: ServerPluginDefinition { id: "tasks-core", contributions: [] }
                            # named re-exports: tables, views, Zod schemas, types
    tsconfig.json
    internal/
      tables.ts             # all pgTables for the domain
      schema.ts             # all pgViews + Zod + types
```

**Principle: one file per concern inside the plugin.** The schema plugin has one job, but inside it the old file-level boundaries are preserved: `tables.ts` stays leaf (pgTables only, no views), `schema.ts` holds derived views and Zod schemas. This is the same split that currently exists within `tasks/` and `conversations/` — we're merging across plugins, not merging across files.

**Barrel (`server/index.ts`)** exports everything consumers need:

```typescript
import type { ServerPluginDefinition } from "../../../server/src/types";

export { _tasks, _attempts, _taskDependencies, _conversations, pushes } from "./internal/tables";
export {
  tasks, attempts, conversations,
  TaskSchema, Task, TaskStatusSchema, TaskStatus,
  AttemptSchema, Attempt, AttemptStatusSchema, AttemptStatus,
  PushSchema, Push,
  ConversationSchema, Conversation,
} from "./internal/schema";

const plugin: ServerPluginDefinition = {
  id: "tasks-core",
  name: "Tasks Core",
  contributions: [],
};
export default plugin;
```

## Modularity — keeping `tasks-core` from becoming a dumping ground

1. **Scope = one FK-connected component.** `tasks-core` owns only tables that reference each other. If a future table doesn't FK into this graph, it goes elsewhere — even if it's thematically "tasky." The acceptance test is referential connectivity, not domain feel.
2. **No route handlers, no resources, no business logic.** The plugin is schema + derived views + Zod + types. If a helper is plugin-specific (ranking, cursor math, title generation), it stays with the owning plugin. If a helper needs to touch two schemas, it lives in whichever plugin is actually *doing* the work, not in `tasks-core`.
3. **File-level boundaries preserved.** Keep `tables.ts` and `schema.ts` separate inside `internal/`. Don't collapse into one mega-file. Readers get the same mental map the old plugins gave.
4. **No `export *`.** The barrel enumerates every named export explicitly. Makes it obvious what's public and prevents accidental leakage of internal helpers.

## Migration steps

Ordered for minimal breakage; each step should typecheck before moving on.

1. **Create plugin skeleton.** `plugins/tasks-core/package.json` (workspace member), `server/tsconfig.json`, empty `server/index.ts` with `contributions: []` default export. Register in `server/src/plugins.ts` (registry order: load-order comment says tasks/conversations load after their dependencies — `tasks-core` goes first). Run `bun install` at repo root.
2. **Copy tables.** Move the six pgTables into `plugins/tasks-core/server/internal/tables.ts`. Update intra-file references. Verify there are no remaining cross-plugin imports inside this file (it should be a graph leaf).
3. **Copy views + Zod + types.** Move `attempts_v`, `tasks_v`, `conversations_v`, and all Zod schemas/TS types into `plugins/tasks-core/server/internal/schema.ts`. It imports only from `./tables`.
4. **Wire the barrel.** Fill in `server/index.ts` exports per the shape above.
5. **Update the drizzle aggregator.** Edit `server/src/db/schema.ts`: replace the four `@plugins/tasks/server/internal/{tables,schema}` and `@plugins/conversations/server/internal/{tables,schema}` lines with two `@plugins/tasks-core/server/internal/{tables,schema}` lines. Keep the load-order comment (tables before schemas is no longer needed within the same plugin, but preserve the convention for other plugins).
6. **Migrate internal consumers.** Update every file in `plugins/tasks/server/internal/*` and `plugins/conversations/server/internal/*` that imported tables/views/types from the plugin's own `internal/{tables,schema}` to instead import from `@plugins/tasks-core/server`.
7. **Migrate cross-plugin consumers.** Three files (see table above): `handle-launch.ts`, `auto-build-watcher.ts`, `stats/handle-cumulative.ts`. Some symbols now come from `tasks-core`, others stay in `tasks`/`conversations`.
8. **Delete the moved files.** Remove `plugins/tasks/server/internal/tables.ts`, `plugins/tasks/server/internal/schema.ts`, `plugins/conversations/server/internal/tables.ts`, `plugins/conversations/server/internal/schema.ts`.
9. **Clean up `api.ts` / `index.ts` re-exports.** `plugins/tasks/server/api.ts` and `plugins/conversations/server/api.ts` no longer need to re-export tables/views/types — those now live in `tasks-core`. Keep re-exports of plugin-local helpers (`createConversation`, `nextRankUnder`, `Runtime`, etc.).
10. **Run `./equin build`.** This regenerates migrations (none expected — table DDL is identical), restarts the server, and confirms the app comes up. Drizzle picks up `plugins/tasks-core/server/internal/{tables,schema}.ts` automatically via the glob in `server/drizzle.config.ts:18-23`.
11. **Update docs.** `docs/plugins.md` regenerates on build via `cli/src/docgen.ts`. Run `./equin check --plugins-doc-in-sync` to verify. Update `CLAUDE.md` and `server/CLAUDE.md` if they reference the old schema locations.

## Non-scope (deliberately deferred)

- **Moving routes or resources** into `tasks-core`. This plan moves schema only. Route consolidation (Version B from the design discussion) is a separate decision after we see how the split reads.
- **Moving `createConversation` / `deleteConversation` / `Runtime`** into `tasks-core`. These are conversation lifecycle, not schema.
- **Splitting `pushes` off into its own plugin.** `pushes` is FK-connected to `_attempts` — it belongs in `tasks-core` by the connectivity rule.
- **Nested plugin restructure** (`plugins/tasks/plugins/conversations/`). Sibling layout at the top level is cheaper. The tsconfig supports 3 nesting levels; nesting conversations under tasks would push `push-and-exit` to level 4 and require a tsconfig expansion. Revisit only if the sibling layout proves awkward.
- **Extracting `ConversationModel` / `ConversationStatus` enums** into `tasks-core`. Move only if required to avoid a back-reference (the table column uses `$type<ConversationStatus>()` — verify this resolves cleanly with the enum staying in `conversations/`; if not, move them and update consumers).
- **Amending the v2 plugin-boundaries plan (R7).** The connectivity principle (FK-connected tables share a plugin) is worth codifying once this migration lands, but it's a follow-up doc edit, not a prerequisite.

## Files to create / modify

**New:**

- `plugins/tasks-core/package.json`
- `plugins/tasks-core/server/tsconfig.json`
- `plugins/tasks-core/server/index.ts`
- `plugins/tasks-core/server/internal/tables.ts`
- `plugins/tasks-core/server/internal/schema.ts`

**Modified:**

- `server/src/plugins.ts` — register `tasks-core` (load first; update load-order comment)
- `server/src/db/schema.ts` — replace 4 tasks/conversations lines with 2 tasks-core lines
- `plugins/tasks/server/api.ts` — remove table/view/type re-exports; keep helper re-exports
- `plugins/tasks/server/internal/{resources,handle-*,push-watcher,meta-conversations,rank,mcp-tools}.ts` — update imports
- `plugins/conversations/server/api.ts` — same pattern
- `plugins/conversations/server/internal/{resources,handle-*,poller,lifecycle}.ts` — update imports
- `plugins/agents/server/internal/handle-launch.ts` — split imports between `tasks-core` and `tasks`
- `plugins/build/server/internal/auto-build-watcher.ts` — `pushes` from `tasks-core`
- `plugins/stats/plugins/tasks/server/internal/handle-cumulative.ts` — split imports

**Deleted:**

- `plugins/tasks/server/internal/tables.ts`
- `plugins/tasks/server/internal/schema.ts`
- `plugins/conversations/server/internal/tables.ts`
- `plugins/conversations/server/internal/schema.ts`

## Verification

1. **Build succeeds.** `./equin build` runs clean. No new drizzle migration (DDL is unchanged). Server starts; `__singularity_migrations` is unchanged.
2. **No cycle.** `grep -r "@plugins/tasks/server/internal" plugins/` and `grep -r "@plugins/conversations/server/internal" plugins/` both return zero matches. The two deep-path exceptions no longer exist.
3. **Typecheck clean.** `bun run typecheck` (or whatever the project uses) passes in `server/`, `plugins/tasks/`, `plugins/conversations/`, `plugins/agents/`, `plugins/build/`, `plugins/stats/`.
4. **Docgen reflects the move.** After `./equin build`, `docs/plugins.md` lists `tasks-core` as a new plugin with its exports; `tasks` and `conversations` entries no longer list the moved table/view/type symbols. `./equin check --plugins-doc-in-sync` passes.
5. **End-to-end smoke.** Open the app at `http://<worktree>.localhost:9000`:
   - Task list renders, status badges compute correctly (view logic unchanged, just relocated).
   - Create a new task, launch an attempt, watch a conversation go `starting` → `waiting` → closed. Status transitions should be identical to pre-migration.
   - Confirm the push watcher still records pushes (trigger `./equin push` on a throwaway change in a test worktree, then check that `pushesResource` reflects it in the UI).
6. **Cross-plugin consumers still work.**
   - `agents` launch flow creates a task + attempt + conversation (exercises `handle-launch.ts` imports).
   - `build` auto-build watcher fires on push (exercises `auto-build-watcher.ts` imports).
   - `stats` active-tasks chart renders (exercises `handle-cumulative.ts` imports).
7. **Negative case: re-introduce a cycle.** After the migration, attempting to add a deep import from `conversations/internal/*` back into `tasks/internal/*` (or vice versa) should fail under the v2 `plugin-boundaries` check once it lands. Confirm by adding a contrived import and running the check; remove after.
