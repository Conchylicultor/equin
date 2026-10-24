# Task Graph: Drag-to-Connect + Hover-X Edge Editing

## Context

The task-graph plugin renders a dependency DAG using React Flow + dagre layout. Nodes are tasks; directed edges mean "depends on." Currently you can insert a task between two connected tasks (hover edge → click "+"), but there's no way to **add a new dependency edge** or **remove an existing one** from the graph view itself — you have to use the detail pane's dependency chips.

This plan adds two graph-level interactions:
1. **Drag-to-connect** — drag from a source handle to a target handle to create a dependency
2. **Hover-x on edge** — an "×" button appears alongside the existing "+" on edge hover to remove the dependency

## Files to modify

- `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx`
- `plugins/tasks/plugins/task-graph/web/components/insertable-edge.tsx`

No server changes — mutation endpoints already exist:
- `POST /api/tasks/:id/dependencies` (body: `{ dependsOnTaskId }`) — cycle detection built in
- `DELETE /api/tasks/:id/dependencies/:depId`

## Implementation

### 1. Drag-to-connect (`task-graph.tsx`)

**a) Add `Connection` type import** from `@xyflow/react`.

**b) Make handles visible on hover.** The `TaskNode` component already has invisible `Handle` elements and a `hovered` state. Change handles from `!bg-transparent !border-0 !w-1 !h-1` to styled circles that fade in on hover:

```tsx
<Handle
  type="target"
  position={Position.Left}
  className="!bg-muted-foreground/60 !border-border !w-2.5 !h-2.5 !rounded-full"
  style={{ opacity: hovered ? 1 : 0, transition: "opacity 150ms", cursor: "crosshair" }}
/>
```

Same for source handle on the right.

**c) Enable connecting on ReactFlow.** Change `nodesConnectable={false}` → `nodesConnectable={true}`. Add `connectionRadius={20}` for snap tolerance.

**d) Wire `onConnect`.** In the `TaskGraph` outer component, add:

```ts
const onConnect = useCallback((connection: Connection) => {
  if (!connection.source || !connection.target) return;
  void fetch(`/api/tasks/${connection.target}/dependencies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dependsOnTaskId: connection.source }),
  });
}, []);
```

Pass through `TaskGraphInner` to `<ReactFlow onConnect={onConnect}>`.

Edge cases handled automatically:
- **Self-connection**: React Flow prevents same-node connections (source ≠ target handle types)
- **Duplicate edge**: Server is idempotent or returns error; live-state won't create duplicates
- **Cycles**: Server returns 4xx; fetch resolves non-ok; graph stays unchanged

### 2. Hover-x on edge (`insertable-edge.tsx`)

**a) Add `deleting` state** alongside existing `inserting`.

**b) Add delete handler:**

```ts
const handleDelete = useCallback(async (e: React.MouseEvent) => {
  e.stopPropagation();
  if (!data || deleting) return;
  setDeleting(true);
  try {
    await fetch(`/api/tasks/${data.targetTaskId}/dependencies/${data.sourceTaskId}`, {
      method: "DELETE",
    });
  } finally {
    setDeleting(false);
  }
}, [data, deleting]);
```

**c) Layout buttons side by side.** Change the `EdgeLabelRenderer` container from a single button to a flex row with gap:

```tsx
<div className="... flex items-center gap-1" style={{ ... }}>
  <button>+</button>   {/* existing insert-between */}
  <button>×</button>   {/* new delete — hover:bg-destructive style */}
</div>
```

The "×" button mirrors the node delete button styling: `hover:bg-destructive hover:text-destructive-foreground`.

## Verification

1. `./equin build`
2. Open the app, navigate to a task with dependencies so the graph renders
3. **Test drag-to-connect**: hover a node → handles appear → drag from right handle of node A to left handle of node B → edge created, graph updates via live-state
4. **Test hover-x**: hover an edge → both "+" and "×" buttons appear → click "×" → edge removed, graph updates
5. **Test cycle prevention**: try connecting A→B when B→A already exists → no edge created (server rejects)
6. **Test insert-between still works**: hover edge → click "+" → new task inserted
