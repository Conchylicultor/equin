# Reactive task title generation

## Context

Task title generation in `lifecycle.ts` is imperative — `scheduleTaskTitleUpdate` is called inline, interleaved with entity creation. This has produced **4 bugs in recent commits**, all from the same root cause: the call fires at the wrong time, in the wrong branch, or with the wrong CAS guard. The latest: `scheduleTaskTitleUpdate` fires before `insertConversation`, so when Haiku returns quickly the conversation row doesn't exist yet and the title update silently fails.

The fix is structural: make title generation a **reactive concern** owned entirely by the `task-title` plugin, triggered by events — not called inline by lifecycle or handlePostTurn.

### Scope

Only conversation-domain title logic moves to event subscribers. The two task-creation endpoints (`handle-create.ts`, `handle-create-chain.ts`) keep their inline `scheduleTaskTitleUpdate` calls unchanged — they don't have ordering bugs (the task row exists before the call).

## Changes

### 1. Extend `conversationCreated` payload

**File:** `plugins/conversations/server/internal/tables-created-event.ts`

Add `prompt` and `kind` to `ConversationCreatedPayload`:

```ts
export interface ConversationCreatedPayload {
  conversationId: string;
  taskId: string;
  model: ConversationModel;
  spawnedBy: string;
  createdAt: string;
  prompt?: string;       // NEW
  kind?: string;         // NEW
  [key: string]: unknown;
}
```

**File:** `plugins/conversations/server/internal/lifecycle.ts` — pass them at the emit site:

```ts
await conversationCreated.emit({
  conversationId: conv.id,
  taskId: conv.taskId,
  model: conv.model,
  spawnedBy: conv.spawnedBy!,
  createdAt: conv.createdAt.toISOString(),
  prompt: opts.prompt?.trim() || undefined,  // NEW
  kind: conv.kind,                           // NEW
});
```

### 2. New event: `conversation.userTurnSent`

**New file:** `plugins/conversations/server/internal/tables-user-turn-sent-event.ts`

```ts
import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";

export interface UserTurnSentPayload {
  conversationId: string;
  taskId: string;
  text: string;
  [key: string]: unknown;
}

export const {
  event: userTurnSent,
  table: _userTurnSentTriggers,
} = defineTriggerEvent<UserTurnSentPayload>({
  name: "conversation.userTurnSent",
  filters: {
    conversationId: text("conversation_id"),
  },
});
```

**Export from barrel:** `plugins/conversations/server/index.ts` — add `userTurnSent` and `UserTurnSentPayload` exports.

**Register:** Add `userTurnSent` to the `register` array in the conversations server plugin definition.

### 3. Emit `userTurnSent` from `handlePostTurn`

**File:** `plugins/conversations/server/internal/handle-post-turn.ts`

Replace the entire fire-and-forget title block (lines 49-60) with an event emission:

```ts
const conv = await getConversation(id);
if (conv) {
  await userTurnSent.emit({
    conversationId: id,
    taskId: conv.taskId,
    text: body.text as string,
  });
}
```

Remove the `scheduleTaskTitleUpdate`, `getTask` imports, and the `UNINFORMATIVE_TITLES` constant.

### 4. Remove title logic from `lifecycle.ts`

**File:** `plugins/conversations/server/internal/lifecycle.ts`

- Remove imports: `scheduleTaskTitleUpdate`, `synthesiseTitleFallback` (from `@plugins/tasks/plugins/task-title/server`)
- Remove the `synthesiseTitle` helper function (lines 39-43)
- Remove the `UNINFORMATIVE_TITLES` constant (line 45)
- Remove the `titleIsUpgradeable` variable and its computation in both branches
- Remove the `updateTaskTitle` call in the existing-task branch (line 123)
- Remove the `scheduleTaskTitleUpdate` call (lines 126-128)

The new-task branch simplifies to:

```ts
if (!taskId) {
  const parentId =
    opts.kind === "system" ? SYSTEM_META_TASK_ID : CONVERSATIONS_META_TASK_ID;
  const task = await createTask({
    parentId,
    title: "Untitled",
    author: spawnedBy,
  });
  taskId = task.id;
} else {
  // Task already exists — nothing to do here.
  // The task-title plugin will upgrade the title reactively
  // when it receives the conversationCreated event.
}
```

Also remove `updateTaskTitle` from the `@plugins/tasks-core/server` import if no longer used.

### 5. Add event subscribers to `task-title` plugin

**File:** `plugins/tasks/plugins/task-title/server/internal/generate-title.ts`

Add a new function for the reactive path:

```ts
const UNINFORMATIVE_TITLES = ["Untitled", "Untitled conversation"];

export function scheduleTaskTitleUpgrade(taskId: string, text: string): void {
  if (!text.trim()) return;
  void (async () => {
    try {
      const task = await getTask(taskId);
      if (!task || !UNINFORMATIVE_TITLES.includes(task.title)) return;

      const generated = await generateTaskTitle(text, taskId);
      await updateTaskTitle(taskId, generated, UNINFORMATIVE_TITLES);
      await updateConversationsTitleForTask(taskId, generated);
    } catch (err) {
      console.warn("[task-title] scheduleTaskTitleUpgrade failed:", err);
    }
  })();
}
```

Key differences from existing `scheduleTaskTitleUpdate`:
- No `fallbackTitle` parameter — CAS guards against `UNINFORMATIVE_TITLES` internally
- Checks the task's current title first — skips if already meaningful
- The existing `scheduleTaskTitleUpdate` stays unchanged for `handle-create.ts` and `handle-create-chain.ts` callers

**New file:** `plugins/tasks/plugins/task-title/server/internal/title-subscribers.ts`

```ts
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { z } from "zod";
import { scheduleTaskTitleUpgrade } from "./generate-title";

export const titleOnConversationCreatedJob = defineJob({
  name: "task-title.on-conversation-created",
  input: z.object({}).passthrough(),
  event: z.object({
    taskId: z.string(),
    prompt: z.string().optional(),
    kind: z.string().optional(),
  }).passthrough(),
  run: async ({ event }) => {
    if (!event?.prompt || event.kind === "system") return;
    scheduleTaskTitleUpgrade(event.taskId, event.prompt);
  },
});

export const titleOnUserTurnSentJob = defineJob({
  name: "task-title.on-user-turn-sent",
  input: z.object({}).passthrough(),
  event: z.object({
    taskId: z.string(),
    text: z.string(),
  }).passthrough(),
  run: async ({ event }) => {
    if (!event?.text) return;
    scheduleTaskTitleUpgrade(event.taskId, event.text);
  },
});
```

**File:** `plugins/tasks/plugins/task-title/server/index.ts`

Add `onReady` hook and `register` array to the plugin definition. Follow the established boot-time pattern (delete-then-reinsert for idempotent re-registration):

```ts
import { deleteTriggersFor, trigger } from "@plugins/infra/plugins/events/server";
import { conversationCreated } from "@plugins/conversations/server";
import { userTurnSent } from "@plugins/conversations/server";
import {
  titleOnConversationCreatedJob,
  titleOnUserTurnSentJob,
} from "./internal/title-subscribers";

export default {
  id: "tasks-task-title",
  name: "Tasks: Task Title",
  description: "...",
  register: [titleOnConversationCreatedJob, titleOnUserTurnSentJob],
  onReady: async () => {
    await deleteTriggersFor(titleOnConversationCreatedJob);
    await trigger({
      on: conversationCreated,
      do: titleOnConversationCreatedJob,
      with: {},
      oneShot: false,
    });

    await deleteTriggersFor(titleOnUserTurnSentJob);
    await trigger({
      on: userTurnSent,
      do: titleOnUserTurnSentJob,
      with: {},
      oneShot: false,
    });
  },
} satisfies ServerPluginDefinition;
```

### 6. Barrel / export updates

- `plugins/tasks/plugins/task-title/server/index.ts` — add `scheduleTaskTitleUpgrade` export
- `plugins/conversations/server/index.ts` — add `userTurnSent`, `UserTurnSentPayload`, `_userTurnSentTriggers` exports; add `userTurnSent` to `register` array

## File summary

| File | Action |
|------|--------|
| `plugins/conversations/server/internal/tables-created-event.ts` | Add `prompt`, `kind` to payload type |
| `plugins/conversations/server/internal/tables-user-turn-sent-event.ts` | **New** — define `userTurnSent` event |
| `plugins/conversations/server/internal/lifecycle.ts` | Remove all title logic; simplify to `createTask("Untitled")` |
| `plugins/conversations/server/internal/handle-post-turn.ts` | Replace title block with `userTurnSent.emit()`; remove title imports |
| `plugins/conversations/server/index.ts` | Export + register `userTurnSent` |
| `plugins/tasks/plugins/task-title/server/internal/generate-title.ts` | Add `scheduleTaskTitleUpgrade`; keep existing `scheduleTaskTitleUpdate` |
| `plugins/tasks/plugins/task-title/server/internal/title-subscribers.ts` | **New** — two `defineJob` subscribers |
| `plugins/tasks/plugins/task-title/server/index.ts` | Add `onReady`, `register`, new exports |

## Verification

1. `./equin build` — generates the new trigger table migration, rebuilds everything
2. Create a conversation **with** a prompt → task title should start as "Untitled", then upgrade to Haiku-generated within ~5s
3. Create a conversation **without** a prompt (bare Launch button) → task title stays "Untitled". Send a turn via the prompt input → title upgrades within ~5s
4. Create a system conversation (via summary plugin) → title stays "Untitled", no Haiku call
5. Create a task directly via POST /api/tasks with description → fallback title appears instantly, Haiku upgrades (unchanged behavior)
6. `./equin check` passes
