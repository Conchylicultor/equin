# Sync Haiku Title to Conversation on Async Task Title Update

## Context

When a task is created with a description, two titles are generated:

1. **Synchronous fallback** — `synthesiseTitleFallback(description)` (first line, ≤80 chars) is set immediately on the task row so creation is instant.
2. **Async Haiku upgrade** — `scheduleTaskTitleUpdate()` fires a background Haiku call and, when it returns, does a CAS update on `tasks.title` if it still holds the fallback.

`conversations.title` starts as `null` (rendered as "Starting…" in the UI). It is only populated by the 1-second poller in `poller.ts`, which syncs the live tmux pane title once Claude sets something informative. This means there is a window (often several seconds) where:

- The task has a Haiku-generated title.
- Every conversation attached to that task still shows "Starting…".

The goal is to close that gap: when Haiku upgrades the task title, also push that title into any linked conversations that still have `null` titles.

---

## Architecture context

The existing title-sync flow goes **pane title → conversation → task** (poller direction). This change adds a new **Haiku → task + conversation** path:

- `conversations.title` is `null` by default (schema: `text("title")`, nullable, no default).
- "Starting…" is a pure UI fallback in the frontend; it is never stored in the DB.
- The poller never writes an uninformative title to `conversations.title` — it only writes when the pane title is informative (not in `UNINFORMATIVE_TITLES`).
- Therefore `title IS NULL` is the right CAS guard for the new path.

---

## Implementation

### 1. Add `updateConversationsTitleForTask` to `tasks-core`

**File:** `plugins/tasks-core/server/internal/mutations/conversations.ts`

Append a new function that finds all conversations for a task (via the `attempts` join) where `title IS NULL` and sets them to the given title:

```ts
export async function updateConversationsTitleForTask(
  taskId: string,
  title: string,
): Promise<void> {
  const rows = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .innerJoin(_attempts, eq(_conversations.attemptId, _attempts.id))
    .where(and(eq(_attempts.taskId, taskId), isNull(_conversations.title)));

  if (rows.length === 0) return;

  await db
    .update(_conversations)
    .set({ title, updatedAt: new Date() })
    .where(inArray(_conversations.id, rows.map((r) => r.id)));

  recentConversationsResource.notify();
}
```

`_attempts` is already imported at the top of `conversations.ts` (used in `taskIdForConversation`). Add `isNull` and `inArray` to the `drizzle-orm` import.

### 2. Export from `tasks-core` barrel

**File:** `plugins/tasks-core/server/index.ts`

Add `updateConversationsTitleForTask` to the conversation-mutations re-export block (alongside `updateConversation`, `insertConversation`, etc.).

### 3. Call from `scheduleTaskTitleUpdate`

**File:** `plugins/tasks/plugins/task-title/server/internal/generate-title.ts`

Import `updateConversationsTitleForTask` from `@plugins/tasks-core/server`. After the existing `updateTaskTitle` call, add the conversation update — unconditionally (we don't check whether the task CAS succeeded, because the conversation title is independent of whether the task title was user-edited):

```ts
import { updateTaskTitle, updateConversationsTitleForTask } from "@plugins/tasks-core/server";

// inside the IIFE:
const generated = await generateTaskTitle(description, taskId);
if (generated === fallbackTitle) return;
await updateTaskTitle(taskId, generated, [fallbackTitle]);
await updateConversationsTitleForTask(taskId, generated);
```

---

## Files to change

| File | Change |
|------|--------|
| `plugins/tasks-core/server/internal/mutations/conversations.ts` | Add `updateConversationsTitleForTask` |
| `plugins/tasks-core/server/index.ts` | Export `updateConversationsTitleForTask` |
| `plugins/tasks/plugins/task-title/server/internal/generate-title.ts` | Import and call `updateConversationsTitleForTask` after task update |

---

## Interaction with the poller

After this change, the conversation title lifecycle becomes:

1. **t=0** — conversation created, `title = null` (shown as "Starting…")
2. **t=~2–5s** — Haiku returns, sets `conversations.title = <haiku-title>` (where still null)
3. **t=later** — poller sees an informative tmux pane title → overwrites `conversations.title` with the pane title (always wins over Haiku, which is correct — pane title reflects live work context)

The poller's subsequent `updateTaskTitle` call uses `UNINFORMATIVE_TITLES` as its CAS guard. Haiku's task title is not in that list, so the poller will NOT overwrite the task title once Haiku has set it. Task and conversation can diverge after step 3, which is intentional.

---

## Verification

1. Run `./equin build` and open `http://att-<id>.localhost:9000`.
2. Create a new task with a description (or start a conversation that auto-creates a task).
3. Observe the conversation sidebar row — it should show "Starting…" for ~2–5 seconds, then switch to the Haiku-generated title (matching the task title) before the tmux pane title kicks in.
4. Confirm that a conversation with an already-set title (pane-title path) is not overwritten.
5. Check the `debug/claude-cli-calls` pane to confirm the Haiku call for title generation fired.
