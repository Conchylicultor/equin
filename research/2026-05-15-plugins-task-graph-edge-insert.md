# Edge Insert Buttons for Task Dependency Graph

## Context

The task-graph plugin renders a left-to-right DAG of task dependencies using React Flow v12 + dagre. It's currently fully read-only (pan/zoom only). We want to add a `+` button at the midpoint of each edge that, when clicked, creates a new task spliced into that edge — turning `A → C` into `A → new → C`. This is the most discoverable pattern for graph editing (used by Linear, n8n, Retool Workflows).

## Plan

### 1. Create custom edge component

**New file:** `plugins/tasks/plugins/task-graph/web/components/insertable-edge.tsx`

A custom React Flow edge that renders the same smoothstep path as today, plus a `+` button at the midpoint via `EdgeLabelRenderer`.

```
imports: BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps, type Edge from @xyflow/react
```

**Edge data type:**
```ts
type InsertableEdgeData = {
  sourceTaskId: string;
  targetTaskId: string;
  targetParentId: string | null;
  onNavigate: (taskId: string) => void;
};
```

**Hover behavior:** Local `isHovered` state via `onMouseEnter`/`onMouseLeave` on a wrapping `<g>`. The `+` button uses `opacity-0 → opacity-100` transition, gated on `isHovered`. The `<g>` wrapper is needed because `BaseEdge` renders an SVG path and `EdgeLabelRenderer` portals into an HTML overlay — coordinating hover across both requires a shared ancestor.

**Button styling:** 20×20 rounded-full, `bg-background border shadow-sm`, hover becomes `bg-primary text-primary-foreground`. Matches the codebase's existing small-action-button patterns (e.g. `DepChip` remove button). Include `pointer-events-auto` and `nodrag nopan` classes (required by React Flow for interactive elements inside `EdgeLabelRenderer`).

**Insert logic (`handleClick`):**
1. Set `inserting = true` (disables button)
2. `POST /api/tasks` — create task with `{ parentId: data.targetParentId, dependencies: [data.sourceTaskId] }`
3. `DELETE /api/tasks/${data.targetTaskId}/dependencies/${data.sourceTaskId}` — remove old edge
4. `POST /api/tasks/${data.targetTaskId}/dependencies` with `{ dependsOnTaskId: newTask.id }` — wire new edge
5. Call `data.onNavigate(newTask.id)` — navigate to the new task so user can fill in the title
6. Set `inserting = false` in `finally`

Steps 3–4 must be sequential (not `Promise.all`) — adding the new dep before removing the old one could theoretically fail cycle detection if the graph already has paths through the new task.

### 2. Update `task-graph.tsx`

**Changes to `layoutDag`:**
- New parameter: `onNavigate: (taskId: string) => void`
- Edge `type` changes from `"smoothstep"` to `"insertable"`
- Each edge gets a `data` field: `{ sourceTaskId: dep, targetTaskId: t.id, targetParentId: byId.get(t.id)?.parentId ?? null, onNavigate }`

**New module-level constant:**
```ts
import { InsertableEdge } from "./insertable-edge";
const EDGE_TYPES = { insertable: InsertableEdge };
```
Must be module-level (like existing `NODE_TYPES`) to avoid React Flow re-registering on every render.

**`TaskGraphInner`:** Add `edgeTypes={EDGE_TYPES}` prop to `<ReactFlow>`.

**`TaskGraph`:** Pass `onNavigate` to `layoutDag` in the `useMemo`. `onNavigate` is already a stable `useCallback`, so add it as a dependency.

### 3. Parent ID resolution

Use the **target task's `parentId`**. The new task is semantically "inserted before C", so it belongs in the same subtree. The `byId` map already exists in `layoutDag` from the closure, so `byId.get(t.id)?.parentId ?? null` is zero-cost.

## Files

| File | Action |
|------|--------|
| `plugins/tasks/plugins/task-graph/web/components/insertable-edge.tsx` | Create |
| `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx` | Modify |

No server changes — all three mutations use existing REST endpoints (`POST /api/tasks`, `DELETE /api/tasks/:id/dependencies/:depId`, `POST /api/tasks/:id/dependencies`).

## Verification

1. `./equin build`
2. Open a task that has dependencies (shows the graph band)
3. Hover an edge → `+` button fades in at midpoint
4. Click `+` → new "Untitled" task appears in the graph, wired between the two original tasks
5. View navigates to the new task's detail pane
6. Verify the old direct edge is gone and replaced by two edges through the new task
7. Verify clicking `+` on an edge in a longer chain (3+ nodes) works correctly
8. Verify rapid double-click doesn't create two tasks (button disabled during insert)
