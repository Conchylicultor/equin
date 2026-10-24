# Fix duplicate toasts: thread causality through `spawnedBy`

## Context

When a user submits a task via the Improve button, two toasts fire:
1. `TaskDraftPopover` — "Launched with Sonnet" (immediate, on HTTP response)
2. `AutoLaunchWatcher` — "Auto-started queued task · Sonnet" (~1s later, on live resource update)

Root cause: `spawnedBy: "auto-start"` conflates immediate user-initiated launches with deferred dependency-resolution launches. The watcher can't distinguish them.

A DOM custom event bandaid (`task-chain-submitted`) was added but is fragile and only covers the chain form — not `handleCreate`, `handleSetAutoStart`, or MCP `add_task`.

## Design

**Principle:** `spawnedBy` should capture *why* the conversation was created, not *which codepath* created it. The form owns task-level feedback ("Launched with Sonnet"). The watcher owns conversation-lifecycle feedback ("Auto-started queued task") and should only fire for events the user doesn't already know about.

**New `spawnedBy` values** replacing `"auto-start"`:

| Caller | New `spawnedBy` | Watcher toasts? |
|---|---|---|
| `handleCreateChain` (Improve form) | `"user-launch"` | No |
| `handleCreate` (POST /api/tasks with autoStart) | `"user-launch"` | No |
| `handleSetAutoStart` (toggle in task header) | `"user-launch"` | No |
| `addTaskTool` (MCP add_task) | `"mcp-add-task"` | Yes |
| `maybeLaunchDependentsJob` (dep resolved) | `"dep-resolved"` | Yes |

All other `spawnedBy` values (`"agents-plugin"`, `"conversation-summary"`, `"poller"`, worktree env fallback) are unchanged.

## Changes

### 1. Extend `maybeLaunchTaskJob` input to accept `cause`

**File:** `plugins/conversations/server/internal/auto-start-jobs.ts`

- Add `cause` to the Zod input schema with `.default("dep-resolved")` for backwards compatibility with in-flight jobs
- Handler passes `input.cause` as `spawnedBy` instead of hardcoded `"auto-start"`
- `maybeLaunchDependentsJob` explicitly passes `cause: "dep-resolved"` when fanning out

### 2. Add `cause` parameter to `armTaskAutoStart`

**File:** `plugins/tasks/server/internal/arm-auto-start.ts`

- Add `cause` to the args object
- Forward it to `maybeLaunchTaskJob.enqueue({ taskId, cause })`

### 3. Update all four callers of `armTaskAutoStart`

| File | Cause |
|---|---|
| `plugins/tasks/server/internal/handle-create-chain.ts` | `"user-launch"` |
| `plugins/tasks/server/internal/handle-create.ts` | `"user-launch"` |
| `plugins/tasks/server/internal/handle-set-auto-start.ts` | `"user-launch"` |
| `plugins/tasks/server/internal/mcp-tools.ts` | `"mcp-add-task"` |

### 4. Update `AutoLaunchWatcher` — use causality, remove bandaid

**File:** `plugins/conversations/plugins/conversations-view/web/components/auto-launch-watcher.tsx`

- Remove the `task-chain-submitted` custom event listener and `recentlySubmittedTaskIdsRef`
- Change filter from `spawnedBy === "auto-start"` to `spawnedBy === "dep-resolved" || spawnedBy === "mcp-add-task"`

### 5. Remove custom event dispatch from `TaskDraftPopover`

**File:** `plugins/tasks/plugins/task-draft-form/web/components/task-draft-popover.tsx`

- Remove the `window.dispatchEvent(new CustomEvent("task-chain-submitted", ...))` block

## Not changed

- `describeOutcome` wording — "Launched with Sonnet" is valid task-level feedback
- Other `spawnedBy` values (`"agents-plugin"`, `"conversation-summary"`, `"poller"`, worktree env)
- DB schema — `spawnedBy` is already a free-form `text` column, no migration needed

## Verification

1. `./equin build` — confirm clean build
2. Submit a single-card Sonnet task via Improve → should see ONE toast ("Launched with Sonnet"), NOT the "Auto-started" toast
3. Submit a chained task where card 2 depends on card 1 → complete card 1's task → card 2 should auto-start and show "Auto-started queued task" toast
4. Toggle auto-start on a task from the task header → no duplicate toast
5. Verify MCP `add_task` with `autostart: "sonnet"` → should show "Auto-started" toast (since user didn't initiate)
