# Insert task between parent and children

## Context

When creating a "follow-up" task via the task-draft-form (Improve button or conversation +), the new task becomes a sibling with a dependency on the related task. But when the related task already has children, the user often wants to *interpose* the new task between the parent and its children — making it a child of the parent and re-parenting selected children under it. This creates a clean intermediary in the task tree.

## Approach

Add a conditional "insert before" section to the head card when `relateMode === "followup"` and the relate task has children. All children checked by default. On submit, the server creates the new task as a child of the relate task and re-parents selected children under it.

Five files to modify, one new component file:

### 1. Schema — `plugins/tasks/plugins/task-draft-form/core/types.ts`

Add `insertBefore` to `TaskChainRelateSchema`:

```ts
export const TaskChainRelateSchema = z.object({
  taskId: z.string().min(1),
  mode: TaskChainRelateModeSchema,
  insertBefore: z.array(z.string().min(1)).optional(),
});
```

### 2. New component — `plugins/tasks/plugins/task-draft-form/web/components/insert-before-children.tsx`

Stateless checkbox list. Props: `children: {id, title}[]`, `selectedIds: Set<string>`, `onChange`, `disabled`.

- 0 children → render nothing
- 1 child → single checkbox: `☐ Insert before "<title>"`
- N children → "Insert before N children" header with Select all/None toggle, then per-child checkboxes

Style matches the existing `ContextRow` pattern: `text-xs text-muted-foreground`, `h-3 w-3` checkboxes.

### 3. Popover state — `plugins/tasks/plugins/task-draft-form/web/components/task-draft-popover.tsx`

- Add `insertBeforeIds: Set<string>` state
- Derive `relateTaskChildren` from `tasks.filter(t => t.parentId === effectiveRelateTaskId)` (the `tasks` array from `useResource(tasksResource)` is already available)
- Initialize `insertBeforeIds` to all children's IDs on popover open
- Reset in `resetForm()`
- Include `insertBefore: Array.from(insertBeforeIds)` in the `effectiveRelate` when mode is "followup" and set is non-empty
- Pass `relateTaskChildren`, `insertBeforeIds`, `onInsertBeforeChange` to `TaskDraftForm`

### 4. Form component — `plugins/tasks/plugins/task-draft-form/web/components/task-draft-form.tsx`

- Add optional props: `relateTaskChildren`, `insertBeforeIds`, `onInsertBeforeChange`
- Render `<InsertBeforeChildren>` after the head card (inside the cards loop, after the head `TaskDraftCard` and before the first `ChainConnector`) when `isHead && relateMode === "followup" && relateTaskChildren.length > 0`

### 5. Server handler — `plugins/tasks/server/internal/handle-create-chain.ts`

- Import `updateTask` from `@plugins/tasks-core/server`
- **Pre-validation**: when `relate.mode === "followup"` and `insertBefore` is non-empty, verify each ID exists and is a child of `relate.taskId`
- **Post-creation** (head card only): when `insertBefore` is non-empty:
  1. Re-parent the new task under `relate.taskId` via `updateTask(newTask.id, { parentId: relate.taskId })`
  2. Re-parent each selected child under the new task via `updateTask(childId, { parentId: newTask.id })`

The existing dependency logic (`newTask → relateTask`) remains unchanged.

## Key design decisions

- **"Insert before" vs "insert between"**: The UI says "insert before <children>" since the user is choosing which children to push down. The mental model is: the new task slides in before the selected children in the tree.
- **All checked by default**: The common case is interposing before all children. Deselecting all degrades to a plain follow-up (no re-parenting).
- **Server-side re-parenting**: The `updateTask` mutation already handles cycle detection and parent expansion. Re-using it avoids duplicating safety logic.
- **No new API endpoint**: The existing `POST /api/tasks/chain` body is extended with one optional field. The server handler grows ~15 lines.
- **Placement in the form**: Below the head card, above the chain connector — visually tied to the relate context but not cluttering the card's props surface.

## Verification

1. `./equin build`
2. Open the app, create a parent task with 2-3 children
3. Open the Improve popover (or conversation +), select "Follow-up" pointing at the parent
4. Verify the "Insert before" section appears with all children checked
5. Uncheck one child, submit
6. Verify: new task is a child of the parent, checked children are children of the new task, unchecked child remains a child of the parent
7. Verify: new task has a dependency on the parent (follow-up)
8. Test edge cases: single child, all unchecked (plain follow-up), prerequisite mode (no insert section)
