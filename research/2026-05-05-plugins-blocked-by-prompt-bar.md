# "Blocked by" button in conversation prompt bar

## Context

The conversation queue uses Anki-style cycling: every turn completion re-inserts the conversation at position 2. This ignores task dependencies — a conversation whose task is blocked by another can still appear above the blocker in the queue, confusing the priority order. We need a way to mark a conversation as blocked directly from the prompt bar, and ensure the queue respects that ordering.

## Design

Two changes: (1) a new `blocked-by` prompt-bar plugin that lets users pick a conversation to create a task dependency, and (2) queue seed-rank awareness of task dependencies so blocked conversations rank after their blockers.

### Part 1: `blocked-by` plugin (web only)

**Location:** `plugins/conversations/plugins/conversation-view/plugins/blocked-by/web/`

**Contribution:** `Conversation.PromptBar({ id: "blocked-by", section: "deps", sectionOrder: 0, component: BlockedByButton })`

**Component behaviour:**
- Reads `conversation.taskId` (always present — derived from the `conversations_v` view)
- Reads task data via `useTask(conversation.taskId)` from `@plugins/tasks/web` — gives `task.dependencies: string[]`
- Reads active conversations via `useConversations()` from `@plugins/conversations/web`
- Reads all tasks via `useResource(tasksResource)` from `@plugins/tasks/shared` — for resolving dep task titles
- Deduplicates conversations by `taskId` (one per task, since deps are task-level)
- Excludes conversations belonging to the same task as the current conversation
- Shows existing blockers (with remove button), and a searchable list of available conversations to add

**Add flow:** `POST /api/tasks/:id/dependencies { dependsOnTaskId }` (existing endpoint), then `POST /api/conversations-queue/rerank { conversationId }` (new endpoint)

**Remove flow:** `DELETE /api/tasks/:id/dependencies/:depId` (existing endpoint), then same rerank call

### Part 2: `listBlockingDepIds` query in tasks-core

**File:** `plugins/tasks-core/server/internal/queries/tasks.ts`

New function alongside existing `hasBlockingDep` — same SQL logic but returns the list of blocking task IDs instead of a boolean:

```ts
export async function listBlockingDepIds(taskId: string): Promise<string[]>
```

Uses: `_taskDependencies` joined with `_tasks`, filtered to non-dropped deps without a completed attempt.

**Export from:** `plugins/tasks-core/server/index.ts`

### Part 3: Export `_attempts` from tasks-core server barrel

**File:** `plugins/tasks-core/server/index.ts`

Change `export { _tasks, _conversations } from "./internal/tables"` to also export `_attempts`. Needed so the queue plugin can join `_conversations → _attempts` to get `taskId` in the `rankAfterBlockers` function.

### Part 4: Queue dependency-awareness

#### 4a. `rankAfterBlockers` function

**File:** `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/queue-ranks.ts`

New function:
```ts
export async function rankAfterBlockers(conversationId: string, blockingTaskIds: string[]): Promise<Rank>
```

Joins `_conversationsExtQueue → _conversations → _attempts` to find the waiting conversation with the highest rank whose `_attempts.taskId` is in `blockingTaskIds`. Returns a rank immediately after that conversation. Falls back to `positionTwoRank()` if no blocker is currently waiting.

#### 4b. Updated `seedRankJob`

**File:** `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/seed-rank-job.ts`

Before computing rank, call `getConversation(conversationId)` to get `taskId`, then `hasBlockingDep(taskId)`. If blocked, call `listBlockingDepIds` + `rankAfterBlockers` instead of `positionTwoRank`.

#### 4c. New `handleRerank` endpoint

**File:** `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/handle-rerank.ts`

`POST /api/conversations-queue/rerank { conversationId }` — re-evaluates blocking state and upserts the conversation's rank. Called by the blocked-by UI after adding/removing a dependency.

**Register in:** `plugins/conversations/plugins/conversations-view/plugins/queue/server/index.ts`

## Implementation sequence

1. `listBlockingDepIds` in `tasks-core/server/internal/queries/tasks.ts` + export
2. Export `_attempts` from `tasks-core/server/index.ts`
3. `rankAfterBlockers` in `queue-ranks.ts`
4. Update `seedRankJob` to be dependency-aware
5. `handleRerank` endpoint + route registration
6. `blocked-by` plugin (web/index.ts + web/components/blocked-by-button.tsx)

## Key files

- `plugins/tasks-core/server/internal/queries/tasks.ts` — add `listBlockingDepIds`
- `plugins/tasks-core/server/index.ts` — export `_attempts` + `listBlockingDepIds`
- `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/queue-ranks.ts` — add `rankAfterBlockers`
- `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/seed-rank-job.ts` — dependency-aware seeding
- `plugins/conversations/plugins/conversations-view/plugins/queue/server/index.ts` — register new route + export
- `plugins/conversations/plugins/conversation-view/plugins/blocked-by/web/index.ts` — plugin definition
- `plugins/conversations/plugins/conversation-view/plugins/blocked-by/web/components/blocked-by-button.tsx` — UI component

## Reused infrastructure

- `addTaskDependency` / `removeTaskDependency` from `@plugins/tasks-core/server` (existing mutations)
- `POST /api/tasks/:id/dependencies` / `DELETE /api/tasks/:id/dependencies/:depId` (existing endpoints in `plugins/tasks/server`)
- `hasBlockingDep` from `@plugins/tasks-core/server` (existing query)
- `getConversation` from `@plugins/tasks-core/server` (reads from `conversations_v` view, includes `taskId`)
- `useTask` from `@plugins/tasks/web` (live task data with `dependencies: string[]`)
- `useConversations` from `@plugins/conversations/web` (live active/gone conversation lists)
- `ConversationItem` from `@plugins/conversations/plugins/conversation-ui/plugins/item/web` (row/chip rendering)
- `tasksResource` from `@plugins/tasks/shared` (for resolving dep task titles)
- `Rank` from `@plugins/primitives/plugins/rank/shared`

## Edge cases

- **No taskId:** Guard at top of component — `if (!conversation.taskId) return null`
- **Cycle detection:** `addTaskDependency` runs BFS cycle check server-side, returns 400 — UI shows toast
- **No blocker in waiting queue:** `rankAfterBlockers` falls back to `positionTwoRank()` — correct because if blockers are all working/gone, there's no queue position to slot after
- **Same task:** Picker excludes conversations with matching `taskId`
- **Idempotent add:** `POST /api/tasks/:id/dependencies` does `onConflictDoNothing`, returns 204
- **Orphan deps (dep task has no active conversation):** Shown with strikethrough in existing-blockers section, remove still works

## Verification

1. `./equin build` — deploy the changes
2. Open two conversations belonging to different tasks, both in "waiting" state
3. In conversation A's prompt bar, click the blocked-by button
4. Select conversation B from the list — confirm A's task now shows "blocked" status
5. Check the queue: conversation A should appear after conversation B
6. Send a turn to conversation A (make it cycle through working → waiting) — confirm it re-inserts after B, not at position 2
7. Remove the dependency via the X button — confirm A moves to position 2 on next cycle
