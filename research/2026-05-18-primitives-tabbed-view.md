# Tabbed View Primitive + Task List Multi-View

## Context

The conversation sidebar has a hand-rolled tab system (queue / grouped / history) where sub-plugins contribute views to a `ConversationsView.View` slot. The task list has no such system — it renders a single tree view. The user wants to add a recency-sorted flat view to tasks, and the tab pattern should be extracted into a shared primitive so both surfaces (and future ones) get tabs for free.

## Plan

### Step 1 — Create `primitives/tabbed-view` primitive

**New files:**
- `plugins/primitives/plugins/tabbed-view/package.json`
- `plugins/primitives/plugins/tabbed-view/web/index.ts`
- `plugins/primitives/plugins/tabbed-view/web/internal/define-tabbed-view.tsx`

**API:** follows the `defineDetailSections` factory pattern.

```ts
function defineTabbedView<ViewProps extends Record<string, unknown>>(
  id: string,
  options?: { storageKey?: string },
): TabbedView<ViewProps>

interface TabbedView<ViewProps> {
  View: Slot<TabContribution<ViewProps>>;
  Host: ComponentType<ViewProps & { header?: ReactNode }>;
}

interface TabContribution<ViewProps> {
  id: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  order?: number;
  component: ComponentType<ViewProps>;
}
```

`Host` implementation (extracted from `conversation-list.tsx` lines 17–115):
- Reads `View.useContributions()`, sorts by `order`
- Persists selected tab ID to `localStorage` key `"${options?.storageKey ?? id}:active-view"`
- Renders tab bar only when `> 1` view exists
- Tab bar CSS matches the existing conversation-view style exactly
- Renders `header` prop above the tab bar (replaces the hard-coded `<LaunchButtons>`)
- Renders active `component` with `ViewProps` spread, inside a `no-scrollbar min-h-0 flex-1 overflow-y-auto` wrapper
- Falls back to first ordered contribution when stored ID is stale

Uses `defineSlot` (not `defineRenderSlot`) — the Host renders a single active component, not a list.

The `header` is passed as a prop on `Host` (not an option on `defineTabbedView`) because it often depends on runtime context (e.g. the conversation list passes `<LaunchButtons variant="outline" .../>` which imports from `@plugins/primitives/plugins/launch/web`). Keeping it at the render call-site avoids coupling the slot definition file to UI component imports.

### Step 2 — Refactor `conversations-view` to use the primitive

**Modified files:**
- `plugins/conversations/plugins/conversations-view/web/slots.ts`
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`
- `plugins/conversations/plugins/conversations-view/web/index.ts`

**`slots.ts`** — replace `defineSlot` + `ViewContribution` interface with `defineTabbedView`:
```ts
import { defineTabbedView } from "@plugins/primitives/plugins/tabbed-view/web";

export interface ViewProps {
  activeId: string | null;
  onNavigate: (id: string) => void;
  onCloseConversation: (id: string, e: React.MouseEvent) => Promise<void>;
}

export const ConversationsView = defineTabbedView<ViewProps>("conversations-view");
```

`ViewContribution` type is no longer needed — sub-plugins just call `ConversationsView.View({...})` as before, and the contribution shape is inferred from the slot.

**`conversation-list.tsx`** — shrinks to ~40 lines. Keeps: `activeIdFromPath`, URL sync `useEffect`, `navigate`, `closeConversation` handlers. Replaces the tab bar + active component rendering with:
```tsx
<ConversationsView.Host
  activeId={activeId}
  onNavigate={navigate}
  onCloseConversation={closeConversation}
  header={<LaunchButtons variant="outline" size="sm" className="w-full" />}
/>
```

**`index.ts`** — remove `ViewContribution` from exports (it was the old hand-rolled interface). Keep exporting `ViewProps` and `ConversationsView`.

**Sub-plugins unchanged** — `queue/web/index.ts`, `history/web/index.ts`, `grouped/web/index.ts` already call `ConversationsView.View({...})` which still works since `ConversationsView.View` is now the slot returned by the factory.

### Step 3 — Refactor `task-list` to use the primitive, extract tree sub-plugin

**Modified files:**
- `plugins/tasks/plugins/task-list/web/slots.ts`
- `plugins/tasks/plugins/task-list/web/index.ts`

**New files:**
- `plugins/tasks/plugins/task-list/plugins/tree/package.json`
- `plugins/tasks/plugins/task-list/plugins/tree/web/index.ts`

**`slots.ts`** — replace `Tasks.List` with `Tasks.View` from the factory, keep `TaskActions`/`ListActions`:
```ts
import { defineTabbedView } from "@plugins/primitives/plugins/tabbed-view/web";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";

export interface TaskViewProps {
  selectedId?: string;
  rootTaskId?: string;
  onSelect: (id: string) => void;
}

const tabbedView = defineTabbedView<TaskViewProps>("tasks");

export const Tasks = {
  View: tabbedView.View,
  Host: tabbedView.Host,
  TaskActions: defineSlot<{
    id: string;
    component: ComponentType<{ taskId: string; hasChildren: boolean }>;
  }>("tasks.task-actions", { docLabel: (p) => p.id }),
  ListActions: defineSlot<{
    id: string;
    component: ComponentType;
  }>("tasks.list-actions", { docLabel: (p) => p.id }),
};
```

`Tasks.List` (zero consumers) is deleted and replaced by `Tasks.View` + `Tasks.Host`.

**`index.ts`** — export `Tasks` and `TaskViewProps`. Remove `TasksList` export (it moves to the tree sub-plugin, but is only imported by `task-detail/web/panes.tsx` which will use `Tasks.Host` instead). Keep the `TaskActions` contributions.

**tree sub-plugin** (`plugins/tasks/plugins/task-list/plugins/tree/`):
- `package.json`: `@singularity/plugin-tasks-task-list-tree`
- `web/index.ts`: contributes `Tasks.View({ id: "tree", title: "Tree", icon: MdAccountTree, order: 10, component: TasksTreeView })`
- `TasksTreeView` component: exactly the current `TasksList` body from `tasks-list.tsx`, accepting `TaskViewProps`. Moves the file as-is, renames the function, adjusts the import of `Tasks` from the parent barrel.

### Step 4 — Update `task-detail/web/panes.tsx`

**Modified file:** `plugins/tasks/plugins/task-detail/web/panes.tsx`

`TasksRoot` changes from:
```tsx
<TasksList selectedId={selectedId} onSelect={...} />
{lists.length > 0 && ...}
```
to:
```tsx
<Tasks.Host
  selectedId={selectedId}
  onSelect={(id) => openPane(taskDetailPane, { taskId: id }, { mode: "push" })}
/>
```

The `Tasks.List.useContributions()` call and the extra lists rendering block are removed (zero contributors).

### Step 5 — New `task-list/plugins/recent/` sub-plugin

**New files:**
- `plugins/tasks/plugins/task-list/plugins/recent/package.json`
- `plugins/tasks/plugins/task-list/plugins/recent/web/index.ts`
- `plugins/tasks/plugins/task-list/plugins/recent/web/internal/tasks-recent-view.tsx`

**`package.json`**: `@singularity/plugin-tasks-task-list-recent`

**`index.ts`**: contributes `Tasks.View({ id: "recent", title: "Recent", icon: MdHistory, order: 20, component: TasksRecentView })`

**`tasks-recent-view.tsx`**: flat list of tasks sorted by `updatedAt` desc.
- Uses `useResource(tasksResource)` for data (same subscription as the tree view)
- `useMemo` to sort by `updatedAt` descending
- Filters out terminal tasks (done/dropped) by default with a toggle — or show all with a muted style for terminals, matching the tree view's `hideTerminal` behavior
- Renders simple rows: `StatusIcon` + title + `RelativeTime` for the `updatedAt` timestamp
- Click calls `onSelect(task.id)` from `TaskViewProps`
- Active row highlighted with `bg-accent`
- The `rootTaskId` prop is respected (filter to subtree) for consistency, even though the primary use is the full task list

## Key files

| File | Action |
|------|--------|
| `plugins/primitives/plugins/tabbed-view/web/internal/define-tabbed-view.tsx` | **Create** — factory implementation |
| `plugins/primitives/plugins/tabbed-view/web/index.ts` | **Create** — barrel |
| `plugins/primitives/plugins/tabbed-view/package.json` | **Create** |
| `plugins/conversations/plugins/conversations-view/web/slots.ts` | **Modify** — use `defineTabbedView` |
| `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` | **Modify** — delegate to `Host` |
| `plugins/conversations/plugins/conversations-view/web/index.ts` | **Modify** — remove `ViewContribution` export |
| `plugins/tasks/plugins/task-list/web/slots.ts` | **Modify** — replace `Tasks.List` with `Tasks.View`/`Tasks.Host` |
| `plugins/tasks/plugins/task-list/web/index.ts` | **Modify** — update exports |
| `plugins/tasks/plugins/task-list/plugins/tree/web/index.ts` | **Create** — tree view sub-plugin |
| `plugins/tasks/plugins/task-detail/web/panes.tsx` | **Modify** — use `Tasks.Host` |
| `plugins/tasks/plugins/task-list/plugins/recent/web/internal/tasks-recent-view.tsx` | **Create** — recent view |
| `plugins/tasks/plugins/task-list/plugins/recent/web/index.ts` | **Create** — recent view barrel |

## Verification

1. `./equin build` — must compile and generate correct plugin registry entries
2. `./equin check` — plugin boundaries, eslint, migrations-in-sync must pass
3. Conversation sidebar: tabs (Queue / Grouped / History) render and switch identically to before
4. Task list sidebar: Tree tab renders and behaves identically to the current tree view
5. Task list sidebar: Recent tab shows tasks sorted by `updatedAt` desc, clicking selects and opens detail
6. Tab selection persists across page reloads (localStorage)
7. Single-tab state: if a sub-plugin is removed, the tab bar hides and the remaining view renders directly
