---
title: Create & queue child task — auto-launch on parent completion
date: 2026-04-28
category: tasks
status: draft
---

# Create & queue child task

## Context

Today, the `+ add child task` popover in the conversation toolbar (plugin
`new-child-task`) only has a **Create** button: it POSTs `{ parentId, title }`
to `/api/tasks`, creating a task row with no attempt and no agent attached.
Users who want a follow-up task to start the moment the current task lands a
push must either babysit the conversation, manually launch later, or set up
some external timer.

We want the popover to also offer **Create & Queue Sonnet** and **Create &
Queue Opus**: create the child task and arrange for it to auto-launch as a
new conversation as soon as the parent task transitions to status `done`. If
the parent is already `done` at click time, launch immediately. If the parent
is later dropped/held, the queue is cleared (the children remain as plain
tasks, manually launchable).

This is a small UX feature, but it forces us to introduce a real
**`tasks.statusChanged`** event in `tasks-core` — there is none today. That
event is reusable infra: future "do X when task Y completes" features (e.g.
auto-promote a held task, ping Slack on completion) drop straight onto it.

## Goals / Non-Goals

**Goals**

- Two new buttons in the new-child-task popover: `+ Sonnet`, `+ Opus`
  (creating-and-queueing). The plain `Create` button stays.
- Persisted queue state that survives server restart.
- A new typed `tasks.statusChanged` event in `tasks-core`, emitted from the
  mutations that change derived task status.
- A small queued indicator on the task row in `tasks-panel` so the user can
  see and cancel pending auto-launches.

**Non-goals**

- No new agent picker / no support for queueing on an arbitrary other task
  (only on the immediate parent — the conversation's own task). Future work.
- Chained queues (queueing a queued task) are out of scope, but the design
  does not preclude them.
- No retry/timeout/cancel-after semantics: the queue is a one-shot
  registration that fires on the next `done` transition or is explicitly
  cleared.

## UX

The popover (`plugins/conversations/plugins/conversation-view/plugins/new-child-task/web/components/new-child-task-action.tsx`)
gains a second button row. The textarea is unchanged.

```
┌─ Create child task ───────────────────────────────┐
│ ┌───────────────────────────────────────────────┐ │
│ │ Describe the task…                            │ │
│ └───────────────────────────────────────────────┘ │
│                                                   │
│              Cancel    Create     [primary]       │
│                                                   │
│   Auto-start when parent is done:                 │
│              + Sonnet     + Opus                  │
└───────────────────────────────────────────────────┘
```

- `Create` — unchanged: POST `/api/tasks` with `{ parentId, title }`.
- `+ Sonnet` / `+ Opus` — POST `/api/tasks` with
  `{ parentId, title, autoStart: { model: "sonnet" | "opus" } }`.

The submit handler reuses the same trim/validate/toast logic; the buttons
just differ in the body they send.

**Queued indicator.** In `tasks-panel`'s task list row (`plugins/conversations/plugins/conversation-view/plugins/tasks-panel/web/`),
tasks with `autoStartAt IS NOT NULL` and no live attempt show a small chip
like `Queued · Sonnet` next to the title. Clicking the chip clears the queue
(DELETE `/api/tasks/:id/auto-start`). MVP can render a static badge; the
clear-action can be a follow-up if scope is tight.

## Server design

### 1. Schema additions (tasks-core)

In `plugins/tasks-core/server/internal/tables.ts`, add to `_tasks`:

```ts
autoStartAt: timestamp("auto_start_at", { withTimezone: true }),
autoStartModel: text("auto_start_model"), // ConversationModel: "sonnet" | "opus"
```

Both nullable. Set together (one row → either both null or both populated).
No new table. Surfaced through the existing `Task` SQL view in `schema.ts`
without participating in the computed `status`.

### 2. Event: `tasks.statusChanged`

In `plugins/tasks-core/server/internal/tables-events.ts`, alongside
`pushLanded`:

```ts
export type TaskStatusChangedPayload = {
  taskId: string;
  parentId: string | null;
  status: TaskStatus;        // "new" | "in_progress" | ... | "done" | "held" | "dropped"
  previousStatus: TaskStatus;
};

export const { event: taskStatusChanged, table: _taskStatusChangedTriggers } =
  defineTriggerEvent<TaskStatusChangedPayload>({
    name: "tasks.statusChanged",
    filters: {
      taskId: text("task_id"),
      status: text("status"),
    },
  });
```

Two filter columns (`taskId`, `status`) so a queued child can subscribe with
`taskStatusChanged.where({ taskId: parentId, status: "done" })`.

### 3. Emission

Status is computed (SQL view), not stored. The mutations that can flip a
task's computed status are all in `tasks-core`:

| Mutation                          | Can change status to     |
|-----------------------------------|--------------------------|
| `updateTask({ drop, hold })`      | `dropped`, `held`        |
| `createAttempt`                   | `in_progress`            |
| `insertConversation`              | `in_progress`            |
| `updateConversation` (→ "gone")   | `done`, `attempted`, …   |
| `markConversationClosed`          | `done`, `attempted`, …   |
| `insertPush`                      | `done` (with conv gone)  |
| `deleteTask`                      | n/a                      |

We add a small helper in `tasks-core/server/internal/mutations/`:

```ts
async function emitStatusChange(taskId: string, before: TaskStatus | null) {
  const after = await readTaskStatus(taskId);  // SELECT status FROM tasks WHERE id=…
  if (before !== after) {
    await taskStatusChanged.emit({
      taskId,
      parentId: ...,
      status: after,
      previousStatus: before ?? after,
    });
  }
}
```

Each affected mutation calls `before = readTaskStatus(taskId)` before its
work, then `emitStatusChange(taskId, before)` after commit. (Mutations that
operate on conversations/attempts pass through to find the owning task.)

This is a few extra lines per mutation, but keeps emission centralized in
the same module that owns status semantics. No domain logic in feature
plugins.

### 4. Job: `launchQueuedChildrenJob`

In a new file `plugins/conversations/server/internal/jobs/launch-queued.ts`
(this is where `createConversation` lives):

```ts
export const launchQueuedChildrenJob = defineJob({
  name: "tasks.launch-queued-children",
  input: z.object({
    parentTaskId: z.string(),
  }),
  run: async ({ parentTaskId }, ctx) => {
    const queued = await db
      .select()
      .from(_tasks)
      .where(and(eq(_tasks.parentId, parentTaskId),
                 isNotNull(_tasks.autoStartAt)));
    for (const t of queued) {
      // Skip if it already has a live conversation/attempt
      if (await taskHasLiveAttempt(t.id)) continue;
      await createConversation({
        taskId: t.id,
        model: t.autoStartModel ?? "sonnet",
      });
      await db.update(_tasks)
        .set({ autoStartAt: null, autoStartModel: null })
        .where(eq(_tasks.id, t.id));
    }
  },
});
```

A second job `cancelQueuedChildrenJob` clears the columns when the parent
goes to `dropped` or `held`. Both jobs are subscribed in the conversations
plugin's startup.

### 5. Endpoint: `POST /api/tasks`

Extend the existing `/api/tasks` body parser
(`plugins/tasks/server/internal/handle-create.ts`) to accept:

```ts
{ parentId, title, autoStart?: { model: "sonnet" | "opus" } }
```

When `autoStart` is provided:

1. `createTask(...)` (unchanged).
2. Read the parent's current status.
3. **If parent already `done`**: call `createConversation({ taskId, model })`
   directly (immediate launch). Skip the autoStart columns.
4. **Otherwise**: write `autoStartAt = now()`, `autoStartModel = model` on
   the new task, and register two triggers:
   ```ts
   await trigger({
     on: taskStatusChanged.where({ taskId: parentId, status: "done" }),
     do: launchQueuedChildrenJob,
     with: { parentTaskId: parentId },
     oneShot: true,
   });
   await trigger({
     on: taskStatusChanged.where({ taskId: parentId, status: "dropped" }),
     do: cancelQueuedChildrenJob,
     with: { parentTaskId: parentId },
     oneShot: true,
   });
   await trigger({
     on: taskStatusChanged.where({ taskId: parentId, status: "held" }),
     do: cancelQueuedChildrenJob,
     with: { parentTaskId: parentId },
     oneShot: true,
   });
   ```

   Triggers must be idempotent w.r.t. duplicate registration: if the parent
   already has a `launchQueuedChildren` trigger registered (because a
   sibling was queued earlier), don't register a second one — the existing
   job already iterates **all** queued children of that parent. Use a
   uniqueness query on `_taskStatusChangedTriggers` keyed by
   `(jobName, taskId)` before inserting. (Or fold it into the trigger
   registration helper as `onConflictDoNothing`.)

Steps 1+4 happen inside one transaction so a crash between them can't leave
a queued task with no trigger.

### 6. Cancel endpoint (small)

`DELETE /api/tasks/:id/auto-start` clears `autoStartAt`/`autoStartModel`. It
does not delete triggers — the next time the queued-children job fires, it
finds no rows and no-ops, then the trigger is consumed (one-shot).
Alternatively, scan triggers and delete the parent's queue trigger if no
children remain queued; both are fine, deferring to whichever is simpler at
implementation time.

## Edge cases

- **Race: parent completes between create-task and trigger-registration.**
  Resolved by step (2) reading parent status under the same transaction;
  if status is already `done`, we launch immediately and never register a
  trigger.
- **Multiple children queued.** All launch in parallel inside the same job
  invocation (the job iterates `_tasks` for `parentId = X` with
  `autoStartAt NOT NULL`). One trigger per parent thanks to the dedup in
  step (5). `oneShot: true` is fine: re-arming for a future parent
  re-completion is not a useful behavior.
- **Parent dropped → un-dropped → done later.** `cancelQueuedChildrenJob`
  clears the columns when the dropped trigger fires, so reviving the parent
  gives a clean slate; user can re-queue manually.
- **Server restart.** Triggers and queue columns persist in Postgres, so
  events fired after restart still drive the job.
- **Queued child manually launched by user before parent completes.** The
  job's `taskHasLiveAttempt` check skips it; the columns are cleared on the
  next emission.

## Files to modify / create

**Schema & events (tasks-core)**

- `plugins/tasks-core/server/internal/tables.ts` — add `autoStartAt`,
  `autoStartModel` columns.
- `plugins/tasks-core/server/internal/tables-events.ts` — add
  `taskStatusChanged` event + `_taskStatusChangedTriggers` table.
- `plugins/tasks-core/server/internal/schema.ts` — surface the new columns
  on the `Task` view (no impact on computed `status`).
- `plugins/tasks-core/server/internal/mutations/tasks.ts` — emit
  `taskStatusChanged` from `updateTask`, `createTask` (covers parent-state
  change and dependency edits if any), `deleteTask`.
- `plugins/tasks-core/server/internal/mutations/attempts.ts` — emit from
  `createAttempt`.
- `plugins/tasks-core/server/internal/mutations/conversations.ts` — emit
  from `insertConversation`, `updateConversation`,
  `markConversationClosed`, `deleteConversationRow`.
- `plugins/tasks-core/server/internal/mutations/pushes.ts` — emit from
  `insertPush`.
- `plugins/tasks-core/server/index.ts` — re-export `taskStatusChanged`,
  `_taskStatusChangedTriggers`, types.

**Job & subscriptions (conversations)**

- `plugins/conversations/server/internal/jobs/launch-queued.ts` — new file:
  `launchQueuedChildrenJob`, `cancelQueuedChildrenJob`, helper
  `taskHasLiveAttempt`.
- `plugins/conversations/server/index.ts` — register jobs at startup; add
  `taskHasAutoStartHelpers` if needed.

**Endpoint (tasks)**

- `plugins/tasks/server/internal/handle-create.ts` — accept `autoStart`
  field; on creation, either launch immediately or set columns + register
  trigger(s) atomically.
- `plugins/tasks/server/internal/handle-clear-auto-start.ts` (new) — DELETE
  endpoint for `/api/tasks/:id/auto-start`.
- `plugins/tasks/server/index.ts` — wire route.

**UI**

- `plugins/conversations/plugins/conversation-view/plugins/new-child-task/web/components/new-child-task-action.tsx`
  — replace single "Create" button with `Create` + `Auto-start when parent
  done:` row containing `+ Sonnet` and `+ Opus`. Submit helper takes an
  optional `{ model }` argument.
- `plugins/conversations/plugins/conversation-view/plugins/tasks-panel/web/components/...`
  — render queued chip on task rows where `autoStartAt` is set; chip click
  → DELETE `/api/tasks/:id/auto-start`.

**Plugin docs**

- `./equin build` regenerates `docs/plugins-details.md` and
  per-plugin autogen blocks. Run last.

## Reused primitives

- `defineTriggerEvent` / `trigger()` —
  `plugins/infra/plugins/events/server/internal/event.ts` and `trigger.ts`.
  Pattern shown by `pushLanded` in `tasks-core/tables-events.ts`.
- `defineJob` — `plugins/infra/plugins/jobs/server/internal/registry.ts`.
  Pattern shown by `buildRunJob` in `plugins/build/server/internal/build-run-job.ts`.
- `createConversation` —
  `plugins/conversations/server/internal/lifecycle.ts`. Handles attempt
  creation, worktree setup, and tmux runtime spawn atomically.
- `conversationPane.useData()` — already used by the popover for
  `conversation.taskId`.

## Verification

Manual end-to-end after `./equin build`:

1. Open a conversation that has an active task with NO push yet.
2. Click `+`, enter a title, click `+ Sonnet`. Toast confirms creation.
   Open the parent in `tasks-panel`; the new child shows `Queued · Sonnet`.
3. In the parent conversation, push (`./equin push -m "..."`). Watch
   the events panel (`/queue` debug pane) — `tasks.statusChanged` emits
   with `status: "done"`, the launch job fires, child gains an attempt and
   a Sonnet conversation appears. The chip disappears from the child row.
4. Repeat with `+ Opus` and verify the spawned conversation uses Opus.
5. **Cancel-on-drop.** Queue another child, then drop the parent. Verify
   the child loses its `Queued` chip and was NOT launched.
6. **Already-done.** On a parent task that already has a push and a closed
   conversation (status `done`), open `+`, click `+ Sonnet`. Verify the
   child is created AND immediately spawns a Sonnet conversation (no
   trigger row written).
7. **Restart resilience.** Queue a child, restart the server with
   `./equin build`, then push the parent. Verify the queued child
   still launches.
8. **Multiple queued.** Queue 3 children under one parent, push parent,
   verify all 3 launch in parallel.

If the queued chip + cancel UI proves fiddly, ship steps 1-4 first as a
single PR and add the chip in a follow-up.
