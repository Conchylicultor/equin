# Refactor: Move Above bands into TaskDetail & extract TaskTreeDetail

## Context

Three surfaces render a task detail view:
- **Standalone `/tasks`** (`TaskDetailBody` in `task-detail/web/panes.tsx`) — tree as sibling pane, Above bands + detail inline
- **Conversation toolbar** (`TasksPane` in `tasks-panel/web/components/tasks-pane.tsx`) — tree + Above bands + detail all stacked in one pane
- **Task-link side pane** (`SideTaskBody` in `side-task/web/components/side-task-body.tsx`) — **only** detail, missing tree AND Above bands (the bug)

The root cause is that `TaskDetail` is a leaf that only renders `Section` contributions. The `Above` slot (where task-graph lives) is wired by each host manually — and `SideTaskBody` forgot.

The fix has two parts:
1. Render Above bands inside `TaskDetail` itself so every host gets them for free
2. Extract a reusable `TaskTreeDetail` component (tree + detail) so `tasks-panel` and `side-task` share the same composition

## Plan

### Step 1 — Render Above bands inside `TaskDetail`

**File:** `plugins/tasks/plugins/task-detail/web/components/task-detail.tsx`

Add `TaskDetailSlots.Above.useContributions()`, sort, render above the sections. Wrap in an outer `flex flex-col` — Above bands render edge-to-edge (no padding), sections keep their `gap-4 p-6`.

### Step 2 — Remove duplicate Above wiring from hosts

**File:** `plugins/tasks/plugins/task-detail/web/panes.tsx` — `TaskDetailBody`

Remove `aboveBands`/`orderedAbove` logic and the band map. Simplify body to just a scrollable `TaskDetail`. Remove unused `TaskDetailSlots` import.

**File:** `plugins/conversations/.../tasks-panel/web/components/tasks-pane.tsx` — `TasksPane`

Remove `aboveBands`/`orderedAbove` logic and the band map. Remove `TaskDetailSlots` import.

### Step 3 — Create `TaskTreeDetail` component

**File:** `plugins/tasks/plugins/task-detail/web/components/task-tree-detail.tsx` (new)

Controlled component extracted from `TasksPane`'s layout:

```tsx
interface TaskTreeDetailProps {
  rootTaskId: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onFileOpen?: (path: string) => void;
}
```

Internals:
- `useResource(tasksResource)` — subscribes to task list updates
- `TaskNavigateProvider value={onSelect}` — wraps everything so graph node clicks resolve to selection
- `TasksList` (max 40% height, border-b) at top
- `TaskFileOpenProvider` + `TaskDetail` (flex-1, overflow-auto) at bottom
- `key={selectedId}` on `TaskDetail` to reset section state on selection change

No state of its own — fully controlled by the host. This keeps `TasksPane` able to expose state via `TasksPaneContext`.

### Step 4 — Export from barrel

**File:** `plugins/tasks/plugins/task-detail/web/index.ts`

Add: `export { TaskTreeDetail } from "./components/task-tree-detail";`

### Step 5 — Simplify `TasksPane` to use `TaskTreeDetail`

**File:** `plugins/conversations/.../tasks-panel/web/components/tasks-pane.tsx`

Replace the inline tree+detail layout with `<TaskTreeDetail>`. Keep `TasksPaneContext.Provider` (needed by GoToParent/ExpandToTasks toolbar actions) and `PaneChrome`. Remove now-unused imports (`TaskDetail`, `TaskDetailSlots`, `TaskFileOpenProvider`, `TaskNavigateProvider`, `useResource`, `tasksResource`, `TasksList`).

### Step 6 — Upgrade `SideTaskBody` to use `TaskTreeDetail`

**File:** `plugins/conversations/.../side-task/web/components/side-task-body.tsx`

Replace bare `<TaskDetail>` with `<TaskTreeDetail>`. Use `key={taskId}` to reset tree state when the URL param changes. `onSelect` keeps the existing behavior: `taskSidePane.open({ convId, taskId: id })` — navigating re-opens the pane at the new task. Remove now-unused imports (`TaskDetail`, `TaskFileOpenProvider`, `TaskNavigateProvider`).

## Files modified

| File | Change |
|---|---|
| `plugins/tasks/plugins/task-detail/web/components/task-detail.tsx` | Add Above band rendering |
| `plugins/tasks/plugins/task-detail/web/components/task-tree-detail.tsx` | **New** — reusable tree+detail composition |
| `plugins/tasks/plugins/task-detail/web/index.ts` | Export `TaskTreeDetail` |
| `plugins/tasks/plugins/task-detail/web/panes.tsx` | Simplify `TaskDetailBody` (remove Above wiring) |
| `plugins/conversations/.../tasks-panel/web/components/tasks-pane.tsx` | Use `TaskTreeDetail`, remove inline layout |
| `plugins/conversations/.../side-task/web/components/side-task-body.tsx` | Use `TaskTreeDetail`, remove bare `TaskDetail` |

## Verification

1. `./equin build` — must compile and deploy
2. Open the standalone Tasks view (`/tasks`) — graph should render above sections (now scrolling with content instead of pinned)
3. Open a conversation → click the Tasks toolbar button → verify tree + graph + detail all render as before
4. In a conversation transcript, click a `task-<id>` chip → verify the side pane now shows tree + graph + detail (was only showing detail before)
5. In the side-task pane, click a different task in the tree → verify the pane navigates to that task
6. In the side-task pane, click expand (↗) → verify it opens the standalone `/tasks/<id>` view
