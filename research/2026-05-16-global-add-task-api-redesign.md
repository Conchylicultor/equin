# `add_task` MCP API Redesign + Group Concept

## Context

The `add_task` MCP tool has accumulated too many params (`title`, `description`, `parent`, `dependencies`, `autoStart`) and doesn't support the most common operation cleanly: inserting a follow-up into an existing dependency chain with automatic rewiring. Agents must specify `dependencies: ["current"]` + `autoStart: { model: "sonnet" }` for every follow-up — unnecessary ceremony.

Additionally, when a task gets expanded into a chain (A → X1 → X2), there's no visual grouping in the task-graph DAG. We introduce a `group_id` concept to cluster related tasks visually.

**Goals:**
1. Simplify the MCP API — the 90% case (follow-up) becomes `{ "title": "..." }` with everything else defaulted
2. Auto-rewire dependency chains on insertion (both follow-up and prerequisite)
3. Introduce `group_id` as a new DB column for visual clustering in the task-graph

---

## New MCP API

```typescript
add_task({
  title: z.string().min(1),
  description: z.string().optional(),
  relation: z.enum(["followup", "prerequisite", "independent"]).default("followup"),
  target: z.string().optional(),  // defaults to current conversation's task
  model: z.enum(["sonnet", "opus"]).nullable().optional(),
})
```

| Relation | Deps created | Rewiring | group_id | Default model |
|---|---|---|---|---|
| `followup` | new → target | Target's dependents rewired to new task | currentTaskId | `"sonnet"` |
| `prerequisite` | target → new | Target's deps rewired to new task | currentTaskId | `"sonnet"` |
| `independent` | none | none | null | null |

---

## Group Concept

**Rule:** `new_task.group_id = currentTaskId` (the calling agent's task, not the target).

Groups nest hierarchically:
- Agent in A creates X1 → X1.group_id = A
- Agent in A creates X2 with target=X1 → X2.group_id = A (same agent)
- Agent in X1 creates Y1 → Y1.group_id = X1 (nested sub-group)

Visual rendering: tasks sharing a `group_id` render as a bounded cluster in the task-graph DAG.

---

## Implementation Steps

### Step 1: Schema — add `group_id` column

**File:** `plugins/tasks-core/server/internal/tables.ts`

```typescript
groupId: text("group_id").references((): AnyPgColumn => _tasks.id, {
  onDelete: "set null",
}),
```

Add index: `index("tasks_group_id_idx").on(t.groupId)`

The `tasks_v` view and `TaskSchema` (via `createSelectSchema`) pick this up automatically. The `Task` type gains `groupId: string | null` everywhere.

### Step 2: Extend `createTask` to accept `groupId`

**File:** `plugins/tasks-core/server/internal/mutations/tasks.ts`

Add `groupId?: string | null` to `CreateTaskInput`. Thread through to the insert.

### Step 3: Add `getTaskDependencyIds` query

**File:** `plugins/tasks-core/server/internal/queries/tasks.ts`

```typescript
export async function getTaskDependencyIds(taskId: string): Promise<string[]> {
  const rows = await db
    .select({ dependsOnTaskId: _taskDependencies.dependsOnTaskId })
    .from(_taskDependencies)
    .where(eq(_taskDependencies.taskId, taskId));
  return rows.map((r) => r.dependsOnTaskId);
}
```

Export from `plugins/tasks-core/server/index.ts`.

### Step 4: Rewrite MCP tool handler

**File:** `plugins/tasks/server/internal/mcp-tools.ts`

Handler logic:

```
1. Resolve conversationId → currentTaskId
2. targetId = target ?? currentTaskId
3. Verify target exists
4. groupId = (relation !== "independent") ? currentTaskId : null
5. effectiveModel = model ?? (relation === "independent" ? null : "sonnet")
6. Create task: createTask({ parentId: currentTaskId, title, description, author: conversationId, groupId })
7. Wrap rewiring in withNotifyBatch:
   - followup:
     a. addTaskDependency(newTask.id, targetId)
     b. listDependentIds(targetId) → for each D ≠ newTask.id:
        removeTaskDependency(D, targetId) + addTaskDependency(D, newTask.id)
   - prerequisite:
     a. getTaskDependencyIds(targetId) → for each dep D:
        removeTaskDependency(targetId, D) + addTaskDependency(newTask.id, D)
     b. addTaskDependency(targetId, newTask.id)
   - independent: nothing
8. If effectiveModel: armTaskAutoStart({ taskId: newTask.id, model: effectiveModel, dependencies: [...] })
9. Return { task_id, relation, group_id, model }
```

Key imports: `withNotifyBatch` from `@server/resources`, `listDependentIds` and `getTaskDependencyIds` from `@plugins/tasks-core/server`.

Note: `parentId = currentTaskId` (same as today's default) — tree placement reflects who created the task. The `target` only affects dependency wiring.

### Step 5: Task-graph group rendering

**File:** `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx`

Approach: render group bounding boxes as background nodes (z-level below task nodes). No dagre compound mode needed — compute bounding boxes from member positions after standard layout.

Changes to `layoutDag`:

```typescript
// After dagre.layout(g), compute group bounding boxes:
const groupMembers = new Map<string, string[]>();
for (const t of sorted) {
  if (t.groupId && ids.has(t.groupId)) {
    const list = groupMembers.get(t.groupId) ?? [];
    list.push(t.id);
    groupMembers.set(t.groupId, list);
  }
}

// Also include the anchor task itself in its own group visual
for (const [groupId] of groupMembers) {
  if (ids.has(groupId) && !groupMembers.get(groupId)!.includes(groupId)) {
    groupMembers.get(groupId)!.push(groupId);
  }
}

const PAD = 16;
const backgroundNodes: Node[] = [];
for (const [groupId, memberIds] of groupMembers) {
  const positions = memberIds.map((id) => g.node(id));
  const minX = Math.min(...positions.map(p => p.x - NODE_WIDTH / 2)) - PAD;
  const minY = Math.min(...positions.map(p => p.y - NODE_HEIGHT / 2)) - PAD;
  const maxX = Math.max(...positions.map(p => p.x + NODE_WIDTH / 2)) + PAD;
  const maxY = Math.max(...positions.map(p => p.y + NODE_HEIGHT / 2)) + PAD;
  backgroundNodes.push({
    id: `group-${groupId}`,
    type: "groupBackground",
    data: { groupId },
    position: { x: minX, y: minY },
    style: { width: maxX - minX, height: maxY - minY },
    selectable: false,
    draggable: false,
  });
}

return { nodes: [...backgroundNodes, ...taskNodes], edges };
```

New node type `GroupBackground`:
```typescript
function GroupBackground({ style }: NodeProps) {
  return (
    <div
      className="rounded-lg border border-dashed border-border/50 bg-muted/15 pointer-events-none"
      style={{ width: style?.width, height: style?.height }}
    />
  );
}

const NODE_TYPES = { [NODE_TYPE]: TaskNode, groupBackground: GroupBackground };
```

Update `computeDagClosure` to pull in group anchors (so the group task is in the closure even if not directly connected):
```typescript
if (t.groupId && byId.has(t.groupId)) stack.push(t.groupId);
```

### Step 6: Update add-task tool-call renderer

**File:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/add-task/web/components/add-task-tool-view.tsx`

Update input/result types to match new schema. Optionally show a relation badge.

### Step 7: Update CLAUDE.md documentation

Update the MCP Tools section and the follow-up task guidance to reference the new API shape. Remove references to `dependencies: ["current"]` and `autoStart`.

---

## What stays unchanged

- `POST /api/tasks/chain` — the UI's TaskDraftPopover still uses this endpoint with its own `insertBefore` logic. No change needed.
- `POST /api/tasks/insert-between` — the graph edge "+" button. Consider setting `groupId` on tasks created this way in a future iteration.
- `parent_id` tree hierarchy — completely orthogonal. No changes.
- `task_dependencies` table — no schema change. Rewiring is purely about manipulating existing edges.

---

## Edge Cases

**Concurrent rewiring:** Two agents creating follow-ups on the same target simultaneously could conflict. Wrap rewiring in a DB transaction for atomicity. The existing `addTaskDependency` cycle detection (BFS) remains the safety net.

**Follow-up of a task with no dependents:** Rewiring is a no-op (nothing to rewire). The new task just depends on the target. This is the base case (brand-new chain).

**Prerequisite of a task with no deps:** Rewiring is a no-op. Target just gets a new dependency on the new task.

**Model override:** `model: null` explicitly suppresses auto-start for any relation. `model: "opus"` overrides the sonnet default.

---

## Verification

1. `./equin build` after schema change → migration generated and applied
2. Use `query_db` MCP tool to verify `group_id` column exists on tasks table
3. Create tasks via the new MCP API (test each relation mode):
   - `{ "title": "Test followup" }` → verify deps rewired, group_id set
   - `{ "title": "Test prereq", "relation": "prerequisite" }` → verify target depends on new task
   - `{ "title": "Test independent", "relation": "independent" }` → verify no deps, no group
4. Open task-graph in the UI → verify group clusters render as dashed boxes around grouped tasks
5. Verify existing UI flows (TaskDraftPopover, "+ Follow-up", "+ Prerequisite") still work via `POST /api/tasks/chain`

---

## Critical Files

| File | Change |
|---|---|
| `plugins/tasks-core/server/internal/tables.ts` | Add `groupId` column + index |
| `plugins/tasks-core/server/internal/mutations/tasks.ts` | Extend `CreateTaskInput` |
| `plugins/tasks-core/server/internal/queries/tasks.ts` | Add `getTaskDependencyIds` |
| `plugins/tasks-core/server/index.ts` | Export new query |
| `plugins/tasks/server/internal/mcp-tools.ts` | Rewrite tool |
| `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx` | Group rendering |
| `plugins/conversations/.../add-task/web/components/add-task-tool-view.tsx` | Update types |
| `CLAUDE.md` | Update docs |
