# Queue: Cascade blocked dependents on demote

## Context

When demoting a conversation in the queue (demote, step-down, or drag-reorder), conversations from tasks *blocked by* the demoted conversation's task can end up ranked above their blocker. This breaks the invariant "blockers ranked above items they block" and creates a deadlock — a blocked item is queued before the item it's waiting on.

The existing `taskStatusPinJob` handles the case when a dependency is *created* (task becomes blocked → push it below blockers via `rankAfterBlockers`). But it doesn't fire when a blocker *moves*, since the task's status doesn't change.

**Example:** Queue `[C(blocked by B), B(blocked by A), A, D]`. User demotes A → `[C, B, D, A]`. Now B is above A (its blocker) and C is above B (its blocker).

## Plan

### 1. Add `listDependentIds(taskId)` to tasks-core

**File:** `plugins/tasks-core/server/internal/queries/tasks.ts`

Reverse of `listBlockingDepIds` — returns all task IDs that directly depend on a given task (`SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1`). No status filter — used by the cascade to find the full dependency fan-out.

**File:** `plugins/tasks-core/server/index.ts` — export `listDependentIds` from the queries block.

### 2. Create `cascade-blocked.ts`

**File:** `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/cascade-blocked.ts`

Export `cascadeBlockedDependents(conversationId, tx: RankExecutor)`:

1. Find the demoted conversation's task (`findTaskIdForConversation`)
2. BFS from that task through the dependency graph (blocker → dependents direction via `listDependentIds`)
3. For each dependent task:
   - Find its lead conversation (topmost-ranked live conversation in the queue)
   - Get its active blockers via `listBlockingDepIds`
   - Compute required position via `rankAfterBlockers`
   - Compare current rank vs required: only move DOWN (`Rank.compare(current, required) < 0`), never up
   - If needed: `upsertRank` + `reseatGroupMembers`
4. Continue BFS even when no move is needed, so transitive dependents are checked

BFS order guarantees that by the time we process C (depends on B), B has already been repositioned, so `rankAfterBlockers(C, [B])` sees B's updated rank.

### 3. Call cascade from handlers

Add `await cascadeBlockedDependents(conversationId, tx)` after `reseatGroupMembers` but before `validatePin` in:

- `handle-demote.ts`
- `handle-step-down.ts`
- `handle-reorder.ts` (both before/after zones — moving up could also violate the invariant for items that were between old and new positions)

### Files to modify

| File | Change |
|------|--------|
| `plugins/tasks-core/server/internal/queries/tasks.ts` | Add `listDependentIds` |
| `plugins/tasks-core/server/index.ts` | Export `listDependentIds` |
| `plugins/conversations/.../queue/server/internal/cascade-blocked.ts` | New file |
| `plugins/conversations/.../queue/server/internal/handle-demote.ts` | Add cascade call |
| `plugins/conversations/.../queue/server/internal/handle-step-down.ts` | Add cascade call |
| `plugins/conversations/.../queue/server/internal/handle-reorder.ts` | Add cascade call |

### Key reuse

- `rankAfterBlockers` — already computes the correct rank after all blockers
- `reseatGroupMembers` — already handles pulling task-group siblings along
- `listBlockingDepIds` / `hasBlockingDep` — existing dependency queries (use `db` directly, safe since task_dependencies is not mutated in the queue transaction)
- `findTaskIdForConversation` — existing task lookup

## Verification

1. `./equin build`
2. Create tasks A, B, C with dependencies: B depends on A, C depends on B
3. In the queue, verify order is `[A, B, C]`
4. Demote A → verify all three cascade: `[..., A, B, C]`
5. Step-down A by 1 → verify B and C follow
6. Drag-reorder A below C → verify B and C end up after A
7. Verify promoting a non-blocker doesn't cascade anything (no-op path)
