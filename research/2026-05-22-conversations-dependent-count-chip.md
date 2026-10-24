# Dependent Count Toolbar Chip

## Context

The conversation toolbar shows contextual chips (model, status, progress, commits). There's no indicator of how many tasks are transitively blocked by the current conversation's task. This makes it hard to gauge the downstream impact of the current work.

This plan adds a `dependent-count` chip to `Conversation.Header` that displays the recursive count of tasks depending on (blocked by) the conversation's task. Counts all dependents regardless of status — consistent with existing dependency plugins.

Important: **task dependencies** (via `task_dependencies` table) are distinct from **parent/child hierarchy** (via `groupId`). This chip counts dependency-graph dependents only.

## Implementation

### Part 1: Extract `countTransitiveDependents` into `@plugins/tasks/core`

The function already exists locally in `drop-dependents-button.tsx:12-31`. It's a pure utility on `Task[]` — belongs in the shared core barrel.

**Create** `plugins/tasks/core/utils.ts`:
- Move the `countTransitiveDependents(taskId, tasks)` function here
- Import `Task` type from `./resources`

**Edit** `plugins/tasks/core/index.ts`:
- Add `export { countTransitiveDependents } from "./utils"`

**Edit** `plugins/conversations/plugins/conversation-view/plugins/drop-dependents/web/components/drop-dependents-button.tsx`:
- Remove local `countTransitiveDependents` (lines 12-31)
- Import `countTransitiveDependents` from `@plugins/tasks/core` (extend existing import on line 8)

### Part 2: Create `dependent-count` plugin

Location: `plugins/conversations/plugins/conversation-view/plugins/dependent-count/`

**Files:**

1. `package.json` — minimal: name `@singularity/plugin-conversations-conversation-view-dependent-count`, private, version 0.0.1

2. `web/components/dependent-count-chip.tsx`:
   - Read `convId` from `conversationPane.useParams()`
   - Get conversation via `useConversationById(convId)`
   - Get all tasks via `useResource(tasksResource)`
   - Compute count via `countTransitiveDependents(conversation.taskId, allTasks)` (memoized)
   - Return `null` when count is 0 or conversation is loading
   - Render a `bg-muted text-muted-foreground` rounded-full chip (matching `ModelBadge` style) showing `"{n} blocked"`

3. `web/index.ts`:
   - `Conversation.Header({ id: "dependent-count", component: DependentCountChip })`

### Registration

`./equin build` auto-discovers the new plugin directory and generates the registry entry.

## Verification

1. `./equin build` — builds clean, no TS errors
2. Open a conversation whose task has dependents → chip shows "{n} blocked"
3. Open a conversation whose task has no dependents → no chip rendered
4. Verify `drop-dependents` still works (it now imports from `@plugins/tasks/core`)
