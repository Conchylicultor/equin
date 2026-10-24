# Fix: resumeConversation should clear droppedAt/heldAt on the task

## Context

When a conversation is dropped (via drop-and-exit) and then restored (via conversations-recover or resume), the task's `droppedAt` stays set even though the conversation is alive again. This causes the queue pin's `notBlocked` SQL — which reads raw `tasks.dropped_at IS NULL` — to treat the dependency as still dropped, while `tasks_v` computes `in_progress` because `hasActive` wins in the CASE precedence. The pin gets stuck on a conversation that is actually blocked.

The same inconsistency applies symmetrically to `heldAt`.

## Fix

In `resumeConversation()`, clear both `droppedAt` and `heldAt` on the underlying task after restarting the session.

### File: `plugins/conversations/server/internal/lifecycle.ts`

After the `runtime.create()` call (line 212), add:

```ts
import { updateTask } from "@plugins/tasks-core/server";

// ...inside resumeConversation, after runtime.create:
await updateTask(row.taskId, { drop: false, hold: false });
```

`updateTask` with `{ drop: false, hold: false }` sets `droppedAt = null` and `heldAt = null`. It then calls `emitStatusChangeIfChanged()`, which fires `taskStatusChanged` only if the computed status actually changed — so this is a no-op when neither flag was set.

The `taskStatusChanged` event triggers `queue.task-status-pin` job, which calls `validatePin()`, which re-checks `notBlocked` and advances the pin if the current pin is now blocked.

### Why clear both?

`resumeConversation` restarts the Claude CLI session — the agent is actively working. A task with an active agent should not remain dropped or held.

### Edge cases

- **Task was never dropped/held**: `updateTask` writes `null` over `null` — `emitStatusChangeIfChanged` sees no status change, no event emitted. No-op.
- **Task has multiple conversations**: `droppedAt` lives on the task row; `drop-and-exit` already guards against setting it when other active conversations exist. Clearing it on resume is always safe.
- **Task has a push**: `drop-and-exit` skips setting `droppedAt` when a push exists, so `droppedAt` would already be null. No-op.

## Verification

1. `./equin build`
2. Reproduce: create two tasks A→B (A depends on B). Drop B's conversation, verify A gets pinned. Restore B's conversation. A should no longer be pinned (B is blocking it again).
3. Check via `query_db`: `SELECT id, dropped_at, held_at FROM tasks WHERE id = '<task-b-id>'` — `dropped_at` should be null after restore.
