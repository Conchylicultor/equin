# Agents plugin — design

## Context

Today, conversations are launched manually (sidebar button, task "Launch"). The prompt is typed fresh each time. We want reusable, named **agent definitions** — a prompt + metadata that can be browsed, edited, and launched repeatedly, with a history of past launches attached.

This lays the groundwork for two larger directions:

1. **Cron/triggers** — automatically firing an agent on a schedule or event.
2. **Composable Notion-like app surface** — "agents" become a first-class primitive users can organize into folders and eventually compose into higher-level workflows.

The MVP is a pure monitoring/management UI that mirrors the `tasks` plugin's master/detail UX and leans on existing conversation-creation plumbing.

## Goals

- New `agents` sidebar entry + routed page `/agents` and `/agents/:id`.
- Nested tree of agent definitions (folders by `parentId`, like tasks).
- Agent detail view showing prompt (editable), launch button, and the list of past launches (each linking to its conversation).
- Clicking a past launch opens the corresponding conversation in a right-side pane — same UX as the tasks page.
- Launch creates a task `Agent-<name>-<YYYY-MM-DD HH:mm>` under a dedicated "Agents" meta task, then spawns a conversation via the existing `createConversation` with the agent's prompt + model.

Non-goals (future): triggers/cron, import from `~/.claude/agents/*.md`, editing agents via markdown files, agent-to-agent composition.

## Data model

Two new tables, both in the new plugin. Agents live in a tree (user's pick). Launches are tracked by a separate join table (user's pick) so `_tasks` stays untouched.

### `_agents` (new, in `plugins/agents/server/schema_internal.ts`)

```ts
export const _agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    parentId: text("parent_id").references((): AnyPgColumn => _agents.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    // NULL = folder/category node (no launch button). Non-null = launchable agent.
    prompt: text("prompt"),
    model: text("model"),               // e.g. "sonnet" | "opus"; null → caller picks
    expanded: boolean("expanded").notNull().default(false),
    rank: text("rank").notNull(),       // fractional-index, same as tasks
    createdAt, updatedAt,
  },
  (t) => [index("agents_parent_rank_idx").on(t.parentId, t.rank)],
);
```

Derived view `agents_v` exported from `schema.ts` (public) with an `isFolder` computed column (`prompt IS NULL`), matching the `tasks_v` pattern.

### `_agent_launches` (new, join table; also in `schema_internal.ts`)

```ts
export const _agent_launches = pgTable("agent_launches", {
  id: text("id").primaryKey(),          // `launch-<seconds>-<suffix>`
  agentId: text("agent_id").notNull().references(() => _agents.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull(),    // soft link (tasks plugin owns FK integrity)
  createdAt: timestamp(...).defaultNow().notNull(),
});
```

Keeps `_tasks` clean, matches user's choice, and lets the agents plugin own its own resource invalidation.

### Migrations

`./equin build` regenerates them from `schema.ts`. Single new migration: create both tables + the `agents_v` view.

## Server

`plugins/agents/server/` mirrors `plugins/tasks/server/`:

- `schema_internal.ts` — `_agents`, `_agent_launches` (above).
- `schema.ts` — `agents_v` view, `AgentRow`, `AgentLaunchRow` public types.
- `api.ts` — exports `agentsResource`, `agentLaunchesResource`, `AGENTS_META_TASK_ID = "task-meta-agents"`, `nextAgentRankUnder(parentId)` (copy of tasks' `nextRankUnder`).
- `internal/meta-agents.ts` — `ensureAgentsMetaTask()` called from plugin `onReady`; idempotently creates the `"task-meta-agents"` root task (same pattern as `ensureConversationsMetaTask` at `plugins/tasks/server/internal/meta-conversations.ts:7`).
- `internal/handle-list.ts`, `handle-get.ts`, `handle-create.ts`, `handle-update.ts`, `handle-delete.ts`, `handle-reparent.ts` — CRUD on agents (tree).
- `internal/handle-list-launches.ts` — `GET /api/agents/:id/launches` returns rows of `{ launch, task, attempts, conversations }` for the detail view.
- `internal/handle-launch.ts` — `POST /api/agents/:id/launch`:
  1. Load agent; reject if `prompt IS NULL`.
  2. Compute title `Agent-<name>-<YYYY-MM-DD HH:mm>` (local time).
  3. Insert a task under `AGENTS_META_TASK_ID` using `nextRankUnder` (from tasks' `api.ts`).
  4. Call `createConversation({ taskId, prompt: agent.prompt, model: body.model ?? agent.model ?? "sonnet", spawnedBy: "agents-plugin" })` (reuses `plugins/conversations/server/internal/lifecycle.ts:33`).
  5. Insert a row in `_agent_launches`.
  6. Notify `agentLaunchesResource` + `tasks.tasksResource` + `tasks.attemptsResource` + `conversations.conversationsResource`.
  7. Return `{ launchId, taskId, conversationId }`.
- `index.ts` — register routes, resources, `onReady` to call `ensureAgentsMetaTask()`.

Cross-plugin imports via `api.ts` (conforms to the rule in `server/CLAUDE.md`): agents imports `tasks.nextRankUnder`, `tasks.tasksResource`, `tasks.attemptsResource`, `tasks.CONVERSATIONS_META_TASK_ID` pattern (for its own meta constant), `conversations.createConversation` / `Runtime`, `conversations.conversationsResource`.

## Frontend

`plugins/agents/web/` mirrors `plugins/tasks/web/`.

- `index.ts` — register `Shell.Sidebar` (icon `MdSmartToy` or similar, `group: "System"`), `Shell.Route` `/agents` and `/agents/:id`, and define plugin slots `Agents.List`, `Agents.View`, `Agents.ToolbarAction`.
- `commands.ts` — `Agents.OpenAgent` (same shape as `Tasks.OpenTask`).
- `views.tsx` — `agentsPane({ id? })` descriptor returning `{ title: "Agents", component: AgentsPanel, path }`.
- `components/agents-panel.tsx` — **copy of `plugins/tasks/web/components/tasks-panel.tsx`** (ResizablePanelGroup, `ConversationPaneContext`, right-pane conversation view). Replace `TasksList` / `TaskView` with `AgentsList` / `AgentDetail`.
- `components/conversation-pane-context.tsx` — copy of the one in tasks plugin; lets `AgentLaunches` rows call `convPane.open(conversationId)` to toggle the right pane.
- `components/agents-list.tsx` — nested tree, initially without drag-and-drop (ship a simpler version than `tasks-list.tsx`; just clickable rows with expand/collapse chevrons and a "+ new agent / + new folder" row). Future PR can port dnd-kit.
- `components/agent-detail.tsx` — name input, description textarea, prompt textarea (debounced save to `PATCH /api/agents/:id` like `task-detail.tsx:158`), model picker, `<LaunchButton>` (calls `POST /api/agents/:id/launch`, on success opens the returned conversation in the right pane via `convPane.open()`), and `<AgentLaunches>` below.
- `components/agent-launches.tsx` — subscribes to `agentLaunchesResource` for this agent id; renders rows `{ task title, createdAt, status badge }`. Clicking a row calls `convPane.open(conversationId)`. Status badge reuses the derived status from tasks' `attempts_v`.

### Why not reuse the launch plugin directly

`plugins/launch/web/components/launch-buttons.tsx:53` opens a conversation pane at the shell level (`Shell.OpenPane(conversationPane(...))`). We don't want that — we want the conversation to appear in the right pane of the agents page. So the agent's launch button does its own `POST /api/agents/:id/launch` fetch, then calls the local `ConversationPaneContext` `.open()` (context available because the pane is rendered inside `AgentsPanel`).

## Open questions deferred to later PRs

- **Editing prompts inline vs. opening a dedicated editor** — for MVP, prompt is a plain textarea with debounced save.
- **Folder vs. agent affordance** — folders are just agents with `prompt = NULL`. Detail view shows a "Convert to launchable agent" button on folders and vice-versa (or a simpler: "Create folder" / "Create agent" menu in the list).
- **Permissions / who can edit** — single-user app, skipped.
- **Importing `~/.claude/agents/*.md`** — future "Import" button; out of scope.
- **Triggers/cron** — schema already has room; triggers would live in a new `_agent_triggers` table with `(agentId, cron, enabled)` and a server-side scheduler. Not in this PR.

## Critical files (to modify / create)

**New (all under `plugins/agents/`):**
- `package.json`
- `web/index.ts`, `web/slots.ts`, `web/commands.ts`, `web/views.tsx`
- `web/components/agents-panel.tsx` (copy of `plugins/tasks/web/components/tasks-panel.tsx`)
- `web/components/agents-list.tsx`
- `web/components/agent-detail.tsx`
- `web/components/agent-launches.tsx`
- `web/components/conversation-pane-context.tsx` (copy of tasks' version)
- `server/index.ts`, `server/schema.ts`, `server/schema_internal.ts`, `server/api.ts`
- `server/internal/meta-agents.ts`
- `server/internal/handle-list.ts`, `handle-get.ts`, `handle-create.ts`, `handle-update.ts`, `handle-delete.ts`, `handle-reparent.ts`, `handle-list-launches.ts`, `handle-launch.ts`

**Modified:**
- Root `package.json` / workspace config if new plugin needs wiring (check `plugins/tasks/package.json` for reference).
- Web plugin registry (wherever `tasksPlugin` is imported) to also import `agentsPlugin`.
- Server plugin registry similarly.
- `docs/plugins.md` — add the `agents` entry.
- A generated drizzle migration under `server/src/db/migrations/` (created by `./equin build`, never by hand).

**Reused (no changes needed):**
- `plugins/conversations/server/internal/lifecycle.ts:33` — `createConversation`.
- `plugins/tasks/server/api.ts` — `nextRankUnder`, `tasksResource`, `attemptsResource`.
- `@/components/ui/resizable` — layout.
- `plugins/launch/web/components/launch-buttons.tsx` — style reference for the launch button (not the component itself; see "Why not reuse the launch plugin directly" above).

## Verification

1. `./equin build` — check a new migration file appears, server starts clean, `./equin check --migrations-in-sync` passes.
2. Open `http://<worktree>.localhost:9000/agents` — sidebar entry visible, page loads.
3. Create a folder "Research", a child agent "Summarize PRs" with a prompt, save.
4. Click Launch — a row appears in the launches list; the right pane opens the new conversation; the tmux session starts and picks up the prompt. Verify the task `Agent-Summarize PRs-…` is visible under Tasks → "Agents" meta root.
5. Re-open `/agents/<id>` after a server restart — launches list still populated; clicking a past launch opens the conversation in the right pane.
6. Delete the agent — cascades to `_agent_launches`; tasks under it are **not** deleted (soft link), confirming isolation.
7. `bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/agents --click "Summarize PRs" --out /tmp/agents` — before/after confirm the detail view renders.
