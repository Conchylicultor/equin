# Agent-spawned subtasks inherit the agent's preprompt

## Context

When an agent is working on a task, that task may carry a **preprompt**
(`tasks_ext_preprompt`, owned by the `task-preprompt` plugin). The preprompt id
resolves to a `<special_instructions>` block prepended to the launched
conversation's first user turn — it is the only "system prompt" mechanism in the
codebase.

When that agent spawns a subtask via an MCP tool, the new task is filed under the
agent's current task but inherits **no** preprompt. So a subtask launched by an
agent runs with none of the system-prompt context the parent agent was operating
under. That context is exactly what should carry forward: if a parent task is run
under, say, a "security reviewer" preprompt, the subtasks it spawns should run
under the same instructions.

**Goal:** subtasks created by an agent via MCP snapshot the calling agent's task
preprompt onto the new task at creation time.

### Decisions (confirmed with user)

- **What to inherit:** the task preprompt (`tasks_ext_preprompt` id) only — not
  model or other launch context.
- **Mechanism:** **snapshot at creation**. Copy the parent's `prepromptId` onto
  the new task's own `tasks_ext_preprompt` row. The subtask owns its row
  (visible/editable in the UI, survives reparenting). Because the row stores a
  *preprompt id* (a reference into config), the snapshot still tracks edits to
  that preprompt's text — only re-pointing the parent to a different preprompt
  later won't propagate, which is the intended snapshot semantics.
- **Scope:** **agent MCP creations only.** The two MCP tools that create a task
  from a running agent's context:
  - `add_task` — `plugins/tasks/server/internal/mcp-tools.ts`
  - `propose_task` — `plugins/plugin-meta/plugins/plugin-health/server/internal/mcp-tools.ts`

  UI folder-nesting and the conversation "new child task" button are **not**
  affected.

## Design

Add a single focused helper in the plugin that owns the data (`task-preprompt`),
and call it from each MCP handler right after `createTask`. The MCP handlers
already hold perfect context — `conv.taskId` is the spawning agent's task — so no
inference (e.g. "is this an agent creation?") is needed; we are literally inside
the agent-creation code path. This keeps the copy semantics in the owning plugin
(DRY across the two call sites) without adding any task-creation event or
inheriting other extensions.

The agent's task is the **calling conversation's task** (`currentTaskId`), not the
dependency `target` in `add_task` — "inherit the agent's system prompt" means the
conversation that issued the call.

### 1. New helper in `task-preprompt`

`plugins/tasks/plugins/task-preprompt/server/internal/mutations.ts` — add:

```ts
// Snapshot a source task's preprompt onto a destination task. Used when an agent
// spawns a subtask so it inherits the spawning agent's system prompt. No-op when
// the source has no preprompt (the subtask simply gets none).
export async function inheritTaskPreprompt(
  fromTaskId: string,
  toTaskId: string,
): Promise<void> {
  const source = await getTaskPreprompt(fromTaskId);
  if (source) await setTaskPreprompt(toTaskId, source.prepromptId);
}
```

Re-export from the server barrel
`plugins/tasks/plugins/task-preprompt/server/index.ts`:

```ts
export { getTaskPreprompt, setTaskPreprompt, inheritTaskPreprompt } from "./internal/mutations";
```

Reuses existing `getTaskPreprompt` / `setTaskPreprompt` (which already notifies
`taskPrepromptsResource`, so the UI updates).

### 2. `add_task` — snapshot from the calling task

`plugins/tasks/server/internal/mcp-tools.ts`, immediately after the `createTask`
call (before `armTaskAutoStart`, so the preprompt is present when auto-start later
launches the conversation):

```ts
await inheritTaskPreprompt(currentTaskId, task.id);
```

Add the import:

```ts
import { inheritTaskPreprompt } from "@plugins/tasks/plugins/task-preprompt/server";
```

(Parent plugin importing its own sub-plugin barrel — a legal cross-plugin import;
no cycle since `task-preprompt` does not import `tasks`.)

### 3. `propose_task` — snapshot when there is a calling task

`plugins/plugin-meta/plugins/plugin-health/server/internal/mcp-tools.ts`, after
`createTask` / `healthReviewExt.upsert`. `currentTaskId` can be `null` here, so
guard:

```ts
if (currentTaskId) await inheritTaskPreprompt(currentTaskId, task.id);
```

Add the import:

```ts
import { inheritTaskPreprompt } from "@plugins/tasks/plugins/task-preprompt/server";
```

(New edge `plugin-health → task-preprompt`. `plugin-health` already depends on
`tasks-core`; `task-preprompt` does not depend on `plugin-health`, so the graph
stays a DAG.)

## Files to modify

- `plugins/tasks/plugins/task-preprompt/server/internal/mutations.ts` — add `inheritTaskPreprompt`.
- `plugins/tasks/plugins/task-preprompt/server/index.ts` — re-export it.
- `plugins/tasks/server/internal/mcp-tools.ts` — call it in `add_task`.
- `plugins/plugin-meta/plugins/plugin-health/server/internal/mcp-tools.ts` — call it in `propose_task`.

No schema/migration changes (reuses the existing `tasks_ext_preprompt` table). No
new trigger events. No web changes.

## Verification

1. `./equin build` (regenerates docs/autogen for the two touched plugin
   barrels; runs checks incl. boundary checker for the new cross-plugin import).
2. End-to-end via DB + MCP:
   - Assign a preprompt to a task in the UI (or `setTaskPreprompt`), launch it so
     an agent runs on it.
   - From that agent, call `add_task` to spawn a subtask.
   - Confirm inheritance via the `query_db` MCP tool:
     ```sql
     SELECT parent_id, preprompt_id FROM tasks_ext_preprompt
     WHERE parent_id IN ('<parent-task-id>', '<new-subtask-id>');
     ```
     Both rows should share the same `preprompt_id`.
   - Open the subtask's detail pane: the preprompt picker should show the
     inherited selection.
   - Negative case: spawn an `add_task` subtask from a parent with **no**
     preprompt → no `tasks_ext_preprompt` row is created for the subtask.
3. Repeat the positive case for `propose_task` (via the plugin-health review
   flow) to confirm the proposed task carries the preprompt.

## Out of scope

- UI-created tasks (folder nesting, "new child task" button) — not agent MCP
  creations.
- Inheriting model / auto-start config or any extension other than preprompt.
- Agent-plugin launches (`handle-launch.ts`) — those create the agent's own root
  task, not a subtask, and carry no preprompt today.
