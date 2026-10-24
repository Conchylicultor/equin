# Align POST /api/tasks/chain with add_task MCP Semantics

## Context

Commit `8b757d7b` redesigned the `add_task` MCP tool with a cleaner relation/target/group_id model and full auto-rewiring. The UI's `POST /api/tasks/chain` endpoint (used by TaskDraftPopover) was intentionally left unchanged in that commit but now needs alignment:

- **No groupId** — chain-created tasks never get a `group_id`, so they don't render as visual clusters in the task-graph DAG.
- **Weak prerequisite** — only adds `target → new` edge without transferring the target's existing deps to the new task.
- **No batching** — each `addTaskDependency`/`removeTaskDependency` fires its own WebSocket notification instead of coalescing.

The MCP tool handles all three correctly. Goal: share the rewiring logic between both callers.

## Plan

### Step 1 — Create shared `rewire-dependencies.ts`

**New file:** `plugins/tasks/server/internal/rewire-dependencies.ts`

```ts
import {
  addTaskDependency,
  removeTaskDependency,
  listDependentIds,
  getTaskDependencyIds,
} from "@plugins/tasks-core/server";

export async function rewireDependencies(opts: {
  newTaskId: string;
  targetId: string;
  relation: "followup" | "prerequisite";
  /** Followup only: rewire only these IDs. Omit to rewire ALL dependents. */
  selectiveInsertBefore?: string[];
}): Promise<void> {
  if (opts.relation === "followup") {
    await addTaskDependency(opts.newTaskId, opts.targetId);
    const idsToRewire =
      opts.selectiveInsertBefore ?? (await listDependentIds(opts.targetId));
    for (const depId of idsToRewire) {
      if (depId === opts.newTaskId) continue;
      await removeTaskDependency(depId, opts.targetId);
      await addTaskDependency(depId, opts.newTaskId);
    }
  } else {
    const targetDeps = await getTaskDependencyIds(opts.targetId);
    for (const depId of targetDeps) {
      await removeTaskDependency(opts.targetId, depId);
      await addTaskDependency(opts.newTaskId, depId);
    }
    await addTaskDependency(opts.targetId, opts.newTaskId);
  }
}
```

Caller is responsible for wrapping in `withNotifyBatch` — keeps the utility composable.

### Step 2 — Update `handle-create-chain.ts`

Key changes:

1. **Compute `groupId`** before the loop:
   ```ts
   const groupId = body.relate ? body.relate.taskId : null;
   ```

2. **Wrap entire card loop** in `withNotifyBatch(async () => { ... })`.

3. **Pass `groupId` to `createTask`** for every card.

4. **Replace inline relation wiring** (head card) with:
   ```ts
   if (isHead && body.relate) {
     const selective =
       body.relate.mode === "followup" && body.relate.insertBefore?.length
         ? body.relate.insertBefore
         : undefined;
     await rewireDependencies({
       newTaskId: newTask.id,
       targetId: body.relate.taskId,
       relation: body.relate.mode,
       selectiveInsertBefore: selective,
     });
   }
   ```

5. **Fix auto-start deps for prerequisite** — after rewiring, read the new task's actual deps from DB:
   ```ts
   if (isHead && body.relate?.mode === "prerequisite") {
     depsForAutoStart = await getTaskDependencyIds(newTask.id);
   }
   ```

Non-head cards keep their existing `linkedToPrev` → `addTaskDependency(new, prev)` logic unchanged.

### Step 3 — Refactor `mcp-tools.ts` to use shared utility

Replace the inline `withNotifyBatch` rewiring block with:

```ts
if (relation !== "independent") {
  await withNotifyBatch(() =>
    rewireDependencies({ newTaskId: task.id, targetId, relation })
  );
}
```

Remove now-unused inline imports (`listDependentIds`, `getTaskDependencyIds`, `removeTaskDependency`) if no other code in the file uses them.

### Step 4 — No type/schema changes needed

- `groupId` is already in `CreateTaskInput`.
- `insertBefore` in `TaskChainRelateSchema` is already `optional()`.
- `listDependentIds`/`getTaskDependencyIds` already exported from `@plugins/tasks-core/server`.

## Critical files

| File | Action |
|------|--------|
| `plugins/tasks/server/internal/rewire-dependencies.ts` | Create |
| `plugins/tasks/server/internal/handle-create-chain.ts` | Modify |
| `plugins/tasks/server/internal/mcp-tools.ts` | Refactor to use shared utility |

## groupId semantics

| Caller | groupId value | Rationale |
|--------|--------------|-----------|
| MCP `add_task` | `currentTaskId` (agent's own task) | "All tasks created by this agent cluster together" |
| UI chain endpoint | `relate.taskId` | "All tasks created in relation to X cluster together" |
| Either, independent | `null` | No clustering |

Both map to "the context task from which new tasks are spawned."

## Multi-card chain behavior

**Followup chain [A, B, C] against target T:**
- A: `rewireDependencies(followup, T)` → A depends on T, T's dependents rewired to A
- B: depends on A (linkedToPrev), groupId = T
- C: depends on B (linkedToPrev), groupId = T
- Result: `... → T → A → B → C → (former dependents of T)`

**Prerequisite chain [A, B, C] against target T:**
- A: `rewireDependencies(prerequisite, T)` → A inherits T's deps, T depends on A
- B: depends on A (linkedToPrev), groupId = T
- C: depends on B (linkedToPrev), groupId = T
- Result: `(T's former deps) → A → B → C`, `T → A`

## Verification

1. `./equin build` — migrations unchanged, just runtime logic
2. TaskDraftPopover followup: create a followup chain, verify groupId set and dependents rewired
3. TaskDraftPopover prerequisite: create a prerequisite, verify target's deps transferred and groupId set
4. `query_db` to verify `group_id` values on newly created tasks
5. Task-graph: verify grouped tasks render within dashed cluster boxes
6. MCP `add_task`: verify behavior unchanged after refactor to shared utility
