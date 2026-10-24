# Task-Group-Based Queue Scheduling

## Context

The queue sidebar currently treats individual conversations as the scheduling unit. While a client-side `TaskCluster` groups conversations by `taskId` for display in the Queue section, this grouping is shallow: it only covers waiting conversations, working conversations are shown flat without chip counts, and rank operations (demote/step-down/reorder) move individual conversations — which can break the intra-group order and cause the "selected" representative to change unexpectedly.

The goal is to make the **task group** the real scheduling unit. All conversations from the same task (across all attempts) form a group. The top-ranked member is the "selected" representative shown in every section. Rank operations move the entire cluster atomically. The queue becomes a list of task groups, not conversations.

## Design

### Core type

```ts
type TaskGroup = {
  taskId: string;
  selected: RankedConversation;   // top-ranked member (best/lowest rank)
  members: RankedConversation[];  // all members sorted by rank
  count: number;                  // members.length — displayed as chip
};
```

### Server-side: group-aware rank operations

All five rank mutation handlers (`promote`, `demote`, `step-down`, `reorder`, `rerank`) become group-aware by following the same pattern:

1. Wrap in `db.transaction` + `lockDeck(tx)` for serialization
2. Compute the new rank for the target conversation (existing math)
3. Upsert the target's rank
4. Call `reseatGroupMembers(targetId, newRank, tx)` to move siblings
5. Pin validation + notify

**`reseatGroupMembers`** — the core new helper:
1. Look up `taskId` for the target (join `_conversations` → `_attempts`)
2. Fetch all other ranked live-status siblings for that `taskId`, sorted by rank
3. If no siblings → return (single-conversation group)
4. Find the upper bound: rank of the next non-group conversation after `targetNewRank`
5. Chain `Rank.between(prev, upperBound)` for each sibling to produce evenly-spaced ranks between the target and the upper bound, preserving relative order
6. Batch update all sibling ranks

### Server-side: group-aware step-down

`rankAfterN` currently counts individual conversations. With task groups, "step down 5" should skip 5 visible groups, not 5 individual conversations. Change the implementation to:
1. Fetch all live-status ranked conversations below the current rank (excluding same-task members)
2. Group by taskId in JS, keeping only the first (best-ranked) conversation per task
3. Skip N groups, find the boundary rank

### Server-side: group-aware seed rank

When a new conversation is created for a task that already has ranked members, place it after the group's selected member (not at absolute top). This prevents the new conversation from displacing the existing representative.

1. Look up `taskId` for the new conversation
2. Check if any ranked conversations exist for that task
3. If yes → place after the selected (top-ranked) member but before any non-group conversation
4. If no → place at top as before

### Server-side: group-aware pin

- `topWaitingByRank`: add optional `excludeTaskId` parameter. When advancing the pin (user answered the pinned conversation), exclude all conversations from the same task so the pin advances to the next task group's representative.
- `validatePin`: after checking the pinned conversation is still waiting+unblocked, also verify it's the top-ranked member of its group. If not, advance to the group's selected member.
- `advancePinJob`: look up the pinned conversation's `taskId`, pass it as `excludeTaskId`.

### Client-side: unified grouping

Replace the current partition-then-cluster `useMemo` with a unified approach:
1. Group ALL ranked active conversations (waiting + working + starting) by `taskId`
2. For each group, sort by rank, pick top-ranked as `selected`
3. Partition groups by `selected.status`:
   - `workingGroups` → selected is working/starting
   - `waitingGroups` → selected is waiting
4. Working section renders groups with chip counts (using the same `QueueRow` component minus DnD/action buttons)

### Rank function status filter change

Change `rankForTop`, `rankForBottom`, `rankAfterN`, `rankAdjacentTo` from filtering only `status = 'waiting'` to `status IN ('waiting', 'working', 'starting')` (the existing `LIVE_STATUSES` constant). This prevents groups from interleaving across status boundaries. These functions are only called by queue handlers — no external consumers affected.

## Files to modify

### Server — new helpers in `queue-ranks.ts`
`plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/queue-ranks.ts`

- Add `findTaskIdForConversation(id, executor)` — joins `_conversations` + `_attempts`
- Add `findGroupSiblings(taskId, excludeId, executor)` — all ranked live-status conversations for a task
- Add `findNextNonGroupRank(afterRank, excludeTaskId, executor)` — upper bound for reseating
- Add `reseatGroupMembers(targetId, newRank, executor)` — the core group-move logic
- Add `upsertRank(id, rank, executor)` — extract the insert-on-conflict pattern for use in transactions
- Change `joinedWaiting` → `joinedLive` (rename + filter to `LIVE_STATUSES` instead of `waiting`)
- Update `rankForTop`, `rankForBottom` to use `LIVE_STATUSES`
- Rewrite `rankAfterN` to skip N distinct task groups

### Server — pin logic
`plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/pinned.ts`

- Add optional `excludeTaskId` param to `topWaitingByRank`
- Add `isSelectedMemberOfGroup(id, executor)` check
- Update `validatePin` to check group-selected invariant

### Server — all five handlers
- `handle-promote.ts` — wrap in tx + lockDeck, add reseatGroupMembers
- `handle-demote.ts` — wrap in tx + lockDeck, add reseatGroupMembers
- `handle-step-down.ts` — wrap in tx + lockDeck, add reseatGroupMembers
- `handle-reorder.ts` — wrap in tx + lockDeck, add reseatGroupMembers
- `handle-rerank.ts` — wrap in tx + lockDeck, add reseatGroupMembers; if task has existing group, join group instead of going to top

### Server — jobs
- `seed-rank-job.ts` — check for existing group members; place after selected if group exists
- `advance-pin-job.ts` — pass `excludeTaskId` to `topWaitingByRank`

### Client
`plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx`

- Replace `TaskCluster` with `TaskGroup`
- Rewrite the main `useMemo` for unified cross-status grouping
- Replace the flat `working` section with `workingGroups` rendering (using `QueueRow` without DnD handles and rank action buttons)
- Update `pinnedCluster` to search `waitingGroups`

## Implementation order

1. `queue-ranks.ts` — new helpers + status filter change
2. `pinned.ts` — group-aware pin validation
3. All five handlers — transaction wrapping + reseatGroupMembers calls
4. `seed-rank-job.ts` — group-aware seeding
5. `advance-pin-job.ts` — exclude task from pin advancement
6. `queue-view.tsx` — unified client-side grouping + working section chip counts
7. Build + manual test

## Verification

1. `./equin build` — must compile and run
2. Open `http://<worktree>.localhost:9000`, go to Queue view
3. Create 2+ conversations for the same task → verify they collapse into one row with chip count
4. Verify the selected conversation (top-ranked) is displayed as the representative
5. Demote a group → verify all members move together, representative stays the same
6. Promote a group → verify it moves to top with all members
7. Verify a working group appears in the Working section with chip count
8. Verify DnD reorder moves the entire group
9. Create a new conversation for a task with existing group → verify it joins the group (chip count increases) without changing the representative
