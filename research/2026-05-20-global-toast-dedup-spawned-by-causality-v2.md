# Separate task-creation feedback from conversation-lifecycle feedback

## Context

When a user submits a task via the Improve button, two toasts fire with overlapping concerns:
1. `TaskDraftPopover` — "Launched with Sonnet" (task creation + launch conflated)
2. `AutoLaunchWatcher` — "Auto-started queued task · Sonnet" (conversation appeared)

Root cause: nobody drew the line between task creation and conversation lifecycle. The form claims "Launched" (a conversation concern), and the watcher independently notices the same conversation.

A DOM custom event bandaid (`task-chain-submitted`) was added but is the wrong fix — it patches the symptom instead of separating the concerns.

## Design

Two independent feedback channels, one per domain:

1. **Task creation** — owned by the form (`TaskDraftPopover`). Says what happened to the *task*: "Created", "Queued", "Chained 3 tasks". Never mentions launching, models, or conversations.

2. **Conversation lifecycle** — owned by `AutoLaunchWatcher`. The single authority on "something started running." Toasts for *every* new auto-start conversation, including user-initiated ones. Message: "Started · Sonnet" or "Task X started · Opus".

Two toasts for a direct launch is correct — they're two different events (task created, then conversation started). The ~1s gap between them reinforces that these are separate things.

### `spawnedBy` captures causality

`spawnedBy` changes from a mechanism label (`"auto-start"`) to a causality signal. New values replacing `"auto-start"`:

| Caller | New `spawnedBy` | Watcher behavior |
|---|---|---|
| `handleCreateChain` (Improve form) | `"user-launch"` | Toast: "Started · Sonnet" |
| `handleCreate` (POST /api/tasks) | `"user-launch"` | Toast: "Started · Sonnet" |
| `handleSetAutoStart` (toggle) | `"user-launch"` | Toast: "Started · Sonnet" |
| `addTaskTool` (MCP add_task) | `"mcp-add-task"` | Toast: "Started · Sonnet" |
| `maybeLaunchDependentsJob` (dep resolved) | `"dep-resolved"` | Toast: "Task X unblocked · Sonnet" |

All other `spawnedBy` values (`"agents-plugin"`, `"conversation-summary"`, `"poller"`, worktree env) are unchanged — they don't go through the auto-start path.

## Changes

### 1. `describeOutcome` — task-level only

**File:** `plugins/tasks/plugins/task-draft-form/web/internal/submit.ts`

Remove all launch/model language. New messages:

| Case | Before | After |
|---|---|---|
| Single card, queue | "Queued" | "Queued" (unchanged) |
| Single card, non-queue | "Launched with Sonnet" | "Created" |
| Multi card, all queue | "Queued N tasks" | "Queued N tasks" (unchanged) |
| Multi card, mixed | "Chained N tasks (M armed)" | "Created N tasks" |

### 2. Extend `maybeLaunchTaskJob` input to accept `cause`

**File:** `plugins/conversations/server/internal/auto-start-jobs.ts`

- Add `cause` to the Zod input schema with `.default("dep-resolved")` for backwards compat with in-flight jobs
- Handler passes `input.cause` as `spawnedBy` instead of hardcoded `"auto-start"`
- `maybeLaunchDependentsJob` explicitly passes `cause: "dep-resolved"` when fanning out

### 3. Add `cause` parameter to `armTaskAutoStart`

**File:** `plugins/tasks/server/internal/arm-auto-start.ts`

- Add `cause` to the args object
- Forward it to `maybeLaunchTaskJob.enqueue({ taskId, cause })`

### 4. Update all four callers of `armTaskAutoStart`

| File | Cause |
|---|---|
| `plugins/tasks/server/internal/handle-create-chain.ts` | `"user-launch"` |
| `plugins/tasks/server/internal/handle-create.ts` | `"user-launch"` |
| `plugins/tasks/server/internal/handle-set-auto-start.ts` | `"user-launch"` |
| `plugins/tasks/server/internal/mcp-tools.ts` | `"mcp-add-task"` |

### 5. Update `AutoLaunchWatcher` — toast for all causes, remove bandaid

**File:** `plugins/conversations/plugins/conversations-view/web/components/auto-launch-watcher.tsx`

- Remove the `task-chain-submitted` custom event listener and `recentlySubmittedTaskIdsRef`
- Change filter from `spawnedBy === "auto-start"` to check for the new causality values: `"user-launch"`, `"dep-resolved"`, `"mcp-add-task"`
- Tailor toast message per cause:
  - `"user-launch"` / `"mcp-add-task"`: "Started · Sonnet" (with task title if available)
  - `"dep-resolved"`: "Task X unblocked · Sonnet"
- Keep `linkTo: /c/${conv.id}` on all toasts

### 6. Remove custom event dispatch from `TaskDraftPopover`

**File:** `plugins/tasks/plugins/task-draft-form/web/components/task-draft-popover.tsx`

- Remove the `window.dispatchEvent(new CustomEvent("task-chain-submitted", ...))` block

## Not changed

- Other `spawnedBy` values (`"agents-plugin"`, `"conversation-summary"`, `"poller"`, worktree env)
- DB schema — `spawnedBy` is already a free-form `text` column, no migration needed
- `conversation-item.tsx` display — only renders `spawnedBy` for `kind === "system"` conversations, unaffected

## Verification

1. `./equin build` — clean build
2. Submit single-card Sonnet via Improve → see "Created" toast (immediate) then "Started · Sonnet" toast (~1s later, from watcher)
3. Submit single-card queue via Improve → see "Queued" toast only, no conversation toast
4. Submit chained tasks (card 1 sonnet, card 2 depends on card 1) → "Created 2 tasks" toast. Card 1 gets "Started · Sonnet" toast. Complete card 1 → card 2 gets "Task X unblocked · Sonnet" toast
5. Toggle auto-start on a task from task header → "Started · Sonnet" toast from watcher
6. MCP `add_task` with `autostart: "sonnet"` → "Started · Sonnet" toast from watcher
