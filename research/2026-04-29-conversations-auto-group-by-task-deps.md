# Auto-Group Conversations by Task Dependency Clusters

## Context

When multiple active tasks are linked by dependencies (A depends on B), their conversations currently appear scattered throughout the sidebar list. Users lose track of which conversations are part of the same work chain. This change adds **auto-groups**: visually distinct groupings that automatically cluster conversations whose tasks share a dependency edge (or are transitively connected). Auto-groups form and dissolve as dependencies change, but on first interaction (rename or drag-into) they **promote** to a persistent user-defined group in the DB.

Auto-groups render between user-defined groups (DB-backed) and the truly-ungrouped tail.

---

## Files

| Action | Path |
|--------|------|
| **Create** | `plugins/conversations/plugins/conversation-groups/web/components/use-task-auto-groups.ts` |
| **Create** | `plugins/conversations/plugins/conversation-groups/web/components/auto-group-box.tsx` |
| **Modify** | `plugins/conversations/plugins/conversation-groups/web/components/grouped-conversation-list.tsx` |

No new DB tables, no new server endpoints. Purely client-side.

---

## 1. Hook: `use-task-auto-groups.ts`

```typescript
import { useMemo } from "react";
import type { Conversation, Task } from "@plugins/tasks-core/shared";

type AttemptGroup = Conversation[]; // [root, ...forks]

export interface AutoGroup {
  clusterKey: string;        // sorted task IDs joined with ":" — stable localStorage key
  title: string;             // e.g. "Task A · Task B …"
  taskIds: string[];
  attemptGroups: AttemptGroup[];
  rootConvIds: string[];     // root conv ID of each attempt-group (needed for promotion)
}

export interface UseTaskAutoGroupsResult {
  autoGroups: AutoGroup[];
  trulyUngrouped: AttemptGroup[];
}

const META_TASK_ID = "task-meta-conversations";
```

### Algorithm (union-find, O(N·α(N)))

```
1. Build taskById: Map<string, Task>
2. Build reverseDeps: Map<depId, taskId[]>  (reverse edge index over ALL tasks)
3. For each ungrouped attempt-group:
     root = ag[0]; tid = root.taskId
     Skip if tid == META_TASK_ID or not in taskById
     Accumulate activeTaskIds (Set) and taskIdToAttemptGroups (Map)
4. Union-Find over activeTaskIds:
     For each tid in activeTaskIds:
       union(tid, dep) for each dep in task.dependencies if dep in activeTaskIds
       union(tid, dependent) for each dependent in reverseDeps[tid] if in activeTaskIds
5. Group by cluster root → { taskIds, attemptGroups }
6. Clusters with < 2 attempt-groups → trulyUngrouped
7. For clusters with ≥ 2:
     title = first 2 task titles (sorted by title, then id) joined " · "
             + " …" if more than 2 tasks
     clusterKey = cluster.taskIds.sort().join(":")
     rootConvIds = cluster.attemptGroups.map(ag => ag[0].id)
     → autoGroups entry
8. trulyUngrouped also includes attempt-groups with meta-task or unknown taskId
```

All implemented inside a single `useMemo` with `[ungroupedAttemptGroups, tasks]` deps.

---

## 2. Component: `auto-group-box.tsx`

```typescript
interface AutoGroupBoxProps {
  clusterKey: string;
  title: string;
  /** All root conv IDs in this cluster — used to promote to a user group */
  rootConvIds: string[];
  children: ReactNode;
}
```

- **Visual style**: `rounded-md border border-dashed border-border/50 bg-muted/10 px-1 py-1` — dashed border distinguishes from user-group's solid `border-border/60`.
- **Header**: `MdCallMerge` icon (permanent decoration) + inline-editable title (reuse `GroupRename`) + `MdChevronRight` collapse toggle. No delete button.
- **Collapse state**: `useState` initialized from `localStorage.getItem("auto-group:collapsed:<clusterKey>")`. Persists via `localStorage.setItem` on toggle.
- **Drop target**: `useDroppable` with data `{ kind: "auto-group", rootConvIds, title }` so `onDragEnd` can promote.

### Promotion on rename
`AutoGroupBox` receives an `onRename` callback. When the user saves a new title via `GroupRename`:
```
POST /api/conversation-groups
  { title: newTitle, conversationIds: rootConvIds }
```
This creates a persistent user-defined group. The conversations move into `groupedAttemptGroups`, dissolving the auto-group naturally.

---

## 3. Wiring: `grouped-conversation-list.tsx`

### New imports
```typescript
import { tasksResource } from "@plugins/tasks/shared";
import { useTaskAutoGroups } from "./use-task-auto-groups";
import { AutoGroupBox } from "./auto-group-box";
```

### New hook calls (after `ungroupedAttemptGroups` memo)
```typescript
const { data: tasksData } = useResource(tasksResource);
const { autoGroups, trulyUngrouped } = useTaskAutoGroups(
  ungroupedAttemptGroups,
  tasksData ?? [],
);
```

### `onDragEnd` — new `auto-group` drop target case
Add before the existing `"group"` handler:
```typescript
if (target.kind === "auto-group") {
  // Promote the auto-group to a user-defined group and add the dragged conv
  const convIds = [...target.rootConvIds];
  if (!convIds.includes(draggedId)) convIds.push(draggedId);
  await fetch(`/api/conversation-groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: target.title, conversationIds: convIds }),
  });
  return;
}
```

The `DropTarget` union type in `draggable-row.tsx` needs a new member:
```typescript
| { kind: "auto-group"; rootConvIds: string[]; title: string }
```

### Updated render order
```
1. groups.map(g => <GroupBox ...>)               — user-defined groups (unchanged)
2. autoGroups.map(ag =>                          — NEW auto-groups
     <AutoGroupBox
       key={ag.clusterKey}
       clusterKey={ag.clusterKey}
       title={ag.title}
       rootConvIds={ag.rootConvIds}
       onRename={async (title) => {
         await fetch("/api/conversation-groups", {
           method: "POST",
           body: JSON.stringify({ title, conversationIds: ag.rootConvIds }),
         });
       }}
     >
       <SidebarMenu>
         {ag.attemptGroups.map(ag => renderAttemptGroup(ag))}
       </SidebarMenu>
     </AutoGroupBox>)
3. <SidebarMenu>
     {trulyUngrouped.map(renderAttemptGroup)}    — was ungroupedAttemptGroups
     {recentGone.map(...)}                        — unchanged
     {paginatedItems.map(...)}                    — unchanged
```

Conversations inside auto-groups have no `enclosingGroupId`, so dragging one onto a non-auto-group target still uses the existing paths (add to user group, or create new user group).

---

## Verification

1. Create tasks A and B; add dependency A→B; launch conversations for both.
2. Sidebar shows an auto-group titled `"<A title> · <B title>"` (dashed border) containing both conversations.
3. **Rename**: click the title, type a new name → auto-group vanishes, a regular user-defined group appears with both conversations.
4. **Drag-into**: drag a third ungrouped conversation onto the auto-group → it promotes to a user-defined group containing all three.
5. Collapse the auto-group; reload — collapsed state persists (localStorage).
6. Delete the dependency — auto-group dissolves; conversations return to ungrouped tail.
7. Three tasks A→B→C: all three cluster into one auto-group.
8. Conversation with `taskId == "task-meta-conversations"` — never appears in any auto-group.
9. `tasksData` is `undefined` (loading) — no crash; all conversations fall through to `trulyUngrouped`.

Deploy with `./equin build` and verify at `http://att-1777498415-247z.localhost:9000`.
