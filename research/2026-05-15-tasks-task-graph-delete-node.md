# Task Graph: Delete Node with Dependency Bridging

## Context

The task graph renders a left-to-right DAG of task dependencies above a task's detail pane. Nodes only support click-to-navigate. Users need a way to delete tasks directly from the graph. When a task in the middle of a chain (X→Y→Z) is deleted, the dependency edges should be bridged automatically (X→Z) so the DAG stays connected.

## Changes

### 1. Server: Add dependency bridging to `deleteTask`

**File:** `plugins/tasks-core/server/internal/mutations/tasks.ts` — replace `deleteTask` (lines 130–142)

Before deleting, collect edges to bridge:
1. Query upstream deps: `SELECT dependsOnTaskId FROM _taskDependencies WHERE taskId = id` → `upstreamIds`
2. Query downstream dependents: `SELECT taskId FROM _taskDependencies WHERE dependsOnTaskId = id` → `downstreamIds`
3. Snapshot status of each downstream task via `readTaskStatus()` (before cascade wipes their blocking edge)
4. Delete the task — cascade drops all dependency edges
5. Bridge: for each (downstream, upstream) pair, call `addTaskDependency(downstream, upstream)` — handles conflict-on-dup and status events internally
6. For downstream tasks that got no bridge (upstream set was empty), emit `emitStatusChangeIfChanged()` so they transition from blocked→unblocked

Add `import type { TaskStatus } from "../schema"` for the status snapshot map.

No `withNotifyBatch` needed — the extra notifications from `addTaskDependency` are harmless for the typical 0–4 bridged edges. Keeps `tasks-core` from importing `@server/resources`.

### 2. Client: Add hover X button to `TaskNode`

**File:** `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx`

**a) Add `useState` import** (add to the existing React import line)

**b) Extend `TaskNodeData`:**
```ts
type TaskNodeData = {
  task: Task;
  selected: boolean;
  hasChildren: boolean;
};
```

**c) Update `layoutDag` signature** to accept `allTasks: readonly Task[]`:
- Compute `hasChildren` per node: `allTasks.some(t => t.parentId === task.id)`
- Thread into each node's `data`

**d) Refactor `TaskNode`** to add hover delete button:
- Add `useState(false)` for `hovered` and `deleting`
- Add `relative` to root div className
- Add `onMouseEnter`/`onMouseLeave` on root div
- Add absolute-positioned X button at top-right corner (`-top-2 -right-2`)
- Button: `h-5 w-5 rounded-full border shadow-sm bg-background` with `hover:bg-destructive hover:text-destructive-foreground`
- Opacity transition: inline style `opacity: hovered && !hasChildren ? 1 : 0` with `transition: "opacity 150ms"` (mirrors `insertable-edge.tsx` pattern)
- `onClick`: `e.stopPropagation()` (prevents `onNodeClick` navigate), then `fetch(/api/tasks/${id}, { method: "DELETE" })` directly (matches the `InsertableEdge` pattern of inline fetch)
- Icon: inline `×` text (matches `+` in InsertableEdge — no icon library import)

**e) Update `TaskGraph`** to pass `allTasks` through to `layoutDag`:
```ts
const { nodes, edges } = useMemo(
  () => layoutDag(closure, allTasks, taskId, onNavigate),
  [closure, allTasks, taskId, onNavigate],
);
```

## Files to modify

| File | Change |
|---|---|
| `plugins/tasks-core/server/internal/mutations/tasks.ts` | Replace `deleteTask` with bridging logic |
| `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx` | Add hover X button to `TaskNode`, thread `allTasks` through `layoutDag` |

## Verification

1. `./equin build`
2. Open a task with dependencies in the graph (at least X→Y→Z)
3. Hover Y — X button appears at top-right corner
4. Click X — Y is deleted, graph updates to show X→Z
5. Hover a task with children — no X button appears
6. Hover a task with no dependencies — X button appears, clicking it deletes cleanly
