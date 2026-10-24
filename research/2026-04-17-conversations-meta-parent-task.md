# Meta "Conversations" parent task for auto-created conversation tasks

## Context

When `POST /api/conversations` is called without a `taskId` or `attemptId`, `createConversation()` synthesises a fresh root task (one per conversation) at `plugins/conversations/server/internal/lifecycle.ts:56-66`. Every conversation therefore lands as its own top-level node in the tasks tree.

Now that the tasks panel surfaces this hierarchy, the flat list is noisy: a user running 20 ad-hoc conversations ends up with 20 unrelated roots. Group them under a single meta task **"Conversations"** so the tree has one logical container for chat-originated work, mirroring the sidebar label.

A one-time backfill re-parents existing orphan root tasks that already have an attempt (i.e. tasks that were originally auto-created from past conversations).

## Design

- Meta task has a **stable hardcoded id**: `task-meta-conversations`. Ensures idempotent inserts via PK conflict, no title-based lookups, no race on concurrent first-conversation creation.
- The tasks plugin owns the meta-task concern and exports it via `api.ts`, so the conversations plugin can reference it without a cross-plugin internal import.
- `ensureConversationsMetaTask()` is idempotent (`INSERT … ON CONFLICT DO NOTHING`) and called **only from the tasks plugin's `onReady`**. The server awaits `Promise.all(plugins.map(p => p.onReady?.()))` (`server/src/index.ts:13-19`) before `Bun.serve()` starts accepting requests, so no HTTP handler can race the ensure.
- Backfill runs **iff `ensureConversationsMetaTask()` just inserted the row** — signalled by `.returning()` yielding one row. On every subsequent restart the INSERT is a no-op (ON CONFLICT), the signal is `false`, and backfill is skipped. This guarantees one-shot semantics even if a user has manually un-parented an attempt-backed task between restarts.

## Files to change

### 1. `plugins/tasks/server/internal/meta-conversations.ts` *(new)*

```ts
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../../../server/src/db/client";
import { _attempts, _tasks } from "../schema_internal";
import { tasksResource } from "./resources";

export const CONVERSATIONS_META_TASK_ID = "task-meta-conversations";
const TITLE = "Conversations";

// Idempotent. Returns true if the row was inserted by this call.
export async function ensureConversationsMetaTask(): Promise<boolean> {
  const rows = await db
    .insert(_tasks)
    .values({ id: CONVERSATIONS_META_TASK_ID, title: TITLE })
    .onConflictDoNothing({ target: _tasks.id })
    .returning({ id: _tasks.id });
  return rows.length === 1;
}

// One-shot migration: re-parent orphan roots that have >=1 attempt.
export async function backfillConversationsMetaParent(): Promise<number> {
  const rows = await db
    .update(_tasks)
    .set({ parentId: CONVERSATIONS_META_TASK_ID })
    .where(
      and(
        isNull(_tasks.parentId),
        ne(_tasks.id, CONVERSATIONS_META_TASK_ID),
        sql`EXISTS (SELECT 1 FROM ${_attempts} a WHERE a.task_id = ${_tasks.id})`,
      ),
    )
    .returning({ id: _tasks.id });
  if (rows.length > 0) tasksResource.notify();
  return rows.length;
}
```

### 2. `plugins/tasks/server/api.ts`

Re-export only the constant (the helper stays internal — `onReady` is the sole caller):

```ts
export {
  attemptsResource,
  pushesResource,
  tasksResource,
} from "./internal/resources";
export { CONVERSATIONS_META_TASK_ID } from "./internal/meta-conversations";
```

### 3. `plugins/tasks/server/index.ts`

Run ensure + (conditional) backfill before `startPushWatcher`:

```ts
onReady: async () => {
  const created = await ensureConversationsMetaTask();
  if (created) {
    const n = await backfillConversationsMetaParent();
    console.log(`[tasks] backfilled ${n} orphan root tasks under Conversations`);
  }
  await startPushWatcher();
},
```

Only backfill when we just created the meta row — ensures this is truly one-shot and never re-parents user-moved tasks on subsequent restarts.

### 4. `plugins/conversations/server/internal/lifecycle.ts`

Inside the `if (!taskId)` branch (currently lines 56-66) — no inline ensure call; rely on `onReady` having created the meta row before the server accepts requests:

```ts
const newTaskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const [t] = await db
  .insert(_tasks)
  .values({
    id: newTaskId,
    parentId: CONVERSATIONS_META_TASK_ID,
    title: synthesiseTitle(opts.prompt),
  })
  .returning();
taskId = t!.id;
tasksResource.notify();
```

Imports `CONVERSATIONS_META_TASK_ID` and `tasksResource` come from `@plugins/tasks/server/api`. The added `tasksResource.notify()` also fixes a latent bug — the previous code only surfaced the new task via the coincidental cascade from `attemptsResource.notify()` below.

## Non-changes

- **Schema**: no drizzle migration (no column/table changes; only rows).
- **Delete handling**: existing `handleDelete` already 409s when a task has children; the meta task is protected while conversations are nested under it. No change needed.
- **Status view**: an empty meta task renders as `status: 'new'`, consistent with any empty parent. Acceptable — behaves like an empty folder.
- **UI tree**: `plugins/tasks/web/components/tasks-list.tsx:18-29` already builds the tree from `parentId`; nothing frontend-side to change.

## Verification

1. **Cold start, existing orphans** — restart server on current DB; expect log `[tasks] backfilled N orphan root tasks`; `SELECT id, parent_id FROM tasks_v WHERE parent_id IS NULL` returns only `task-meta-conversations`.
2. **Restart idempotency** — second restart skips backfill (meta already exists), no re-parenting runs. Confirm via absence of log line.
3. **New auto-conversation** — `curl -X POST http://singularity.localhost:9000/api/conversations -H 'Content-Type: application/json' -d '{"prompt":"hi"}'`; verify the returned `taskId`'s `parent_id = 'task-meta-conversations'`.
4. **Explicit taskId path** — POST with `{taskId: "existing"}`; that task's `parent_id` is untouched (branch not entered).
5. **UI tree** — open the tasks pane at `/tasks`; "Conversations" is a single expandable root containing every auto-created task.
6. **Delete protection** — `DELETE /api/tasks/task-meta-conversations` with children returns 409 (existing behaviour).
7. **Manual un-parent stays** — PATCH an auto-task to `parent_id = null`; restart; it remains at root (backfill gated on first-time ensure).
8. **Deploy** — `./equin build`; app at `http://<worktree>.localhost:9000`.

## Critical files

- `plugins/tasks/server/internal/meta-conversations.ts` *(new)*
- `plugins/tasks/server/api.ts`
- `plugins/tasks/server/index.ts`
- `plugins/conversations/server/internal/lifecycle.ts`
