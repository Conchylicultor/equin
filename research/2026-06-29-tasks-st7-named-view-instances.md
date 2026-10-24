# ST7 — Migrate tasks Tree/Recent to config-driven named view instances

> Sub-task **ST7** of [`2026-06-15-global-unified-view-switcher.md`](./2026-06-15-global-unified-view-switcher.md).
> Optional / later. Depends on **ST6** (done — `view-core` extracted).

## Context

The tasks app's **Tree** and **Recent** views are hardcoded tabs via
`defineTabbedView("tasks")` (`task-list/web/slots.ts`). The outer tab strip
switches between **two separate `<DataView>` surfaces**:

- `tasks-list` (defined in `task-list/plugins/tree/`) — tree-only, `views={["tree"]}`,
  hierarchy config, single `title` field.
- `tasks-recent` (defined in `task-list/plugins/recent/`) — list-only,
  `views={["list"]}`, three fields, rows pre-sorted by `updatedAt` in JS.

This produces **doubled chrome** (the outer tabbed-view strip *plus* each inner
DataView's own switcher) and is the last consumer blocking the unified,
config-driven named-instance model. Every other DataView is already config-backed
with a committed `views` config; tasks is the exception because it predates the
model and uses the bespoke tab host.

**Outcome:** one `<DataView>` over `tasksResource` with **two config-authored
named instances** — `Tree` (type `tree`) and `Recent` (type `list`, sort
`updatedAt` desc). The outer `defineTabbedView` is retired; the single DataView's
own `EditableViewSwitcher` becomes the Tree/Recent switcher. Users/agents can then
add, rename, duplicate, reorder, and customize task views by editing the config
file — exactly like `sonata/library`. `Tasks.TaskActions` / `Tasks.ListActions`
slots are retained.

### Key constraint discovered

The `views={[…]}` whitelist gates only the **add-view (+) menu** (`available` in
`view-core/web/use-view-model.ts:97`), **not** which config instances render —
`buildInstanceFromRow` filters only on unknown/hierarchical type
(`resolve-instances.ts:29-31`). So a single shared surface cannot show Tree+Recent
in the main pane while hiding Recent in the embedded sub-tree. The embedded
rooted sub-tree (conversation tasks panel, `task-tree-detail.tsx`) therefore needs
its **own** tree-only surface.

## Target state

Two DataView surfaces (down from the two today — `tasks-recent` is folded away,
`tasks-subtree` is added), both owned by the consolidated `task-list` plugin:

| Surface id | Where | Views | Instances (config) | Used by |
|---|---|---|---|---|
| `tasks-list` | `task-list/web` | `["tree","list"]` | Tree (tree), Recent (list, sort updatedAt desc) | main Tasks pane |
| `tasks-subtree` | `task-list/web` | `["tree"]` | Tree (tree) | embedded conversation sub-tree |

`tasks-recent` surface + config are **deleted**.

### Plugin consolidation (confirmed)

Delete both `task-list/plugins/tree/` and `task-list/plugins/recent/`. The views
are now config rows, not plugins; the view-*type* extensibility already lives in
`data-view/plugins/{tree,list}`. Everything moves into `task-list/web`:

```
task-list/
  web/
    slots.ts                      # DROP tabbed-view; keep TaskActions + ListActions
    index.ts                      # contribute row actions (unchanged) + export the two views
    internal/tasks-data-view.tsx  # NEW shared: fields, hierarchy, treeOptions, createTaskRow, isTerminal
    components/
      tasks-list-view.tsx         # NEW TasksListView — main combined surface (tasks-list)
      tasks-subtree-view.tsx      # NEW TasksSubtree — embedded tree-only surface (tasks-subtree)
      child-count-action.tsx      # (existing row actions, unchanged)
      delete-task-action.tsx
      expand-collapse-all-action.tsx
      launch-agent-action.tsx
  plugins/  (tree/ and recent/ DELETED)
```

### Accepted behavior changes (field merge)

One shared `FieldDef[]` (`title` primary+onEdit, `status` enum align-end cell
StatusBadge, `updatedAt` date align-end cell RelativeTime) serves both instances.
Consequences (all additive — confirmed acceptable):
- **Tree** gains `status`/`updatedAt` as filter dimensions in the Filter pill
  (tree only renders the `primary` field; non-primary fields are filter-only).
- **Recent** list rows gain hover **item actions** (delete/launch/…) via
  `itemActions={Tasks.TaskActions}` and **inline title rename** (primary `onEdit`).
- Recent's JS pre-sort is dropped; the `Recent` instance's config `sort`
  (`updatedAt` desc) seeds `state.sort`, which the list view applies via
  `useFlatRows`.

## Implementation

### 1. Shared module `task-list/web/internal/tasks-data-view.tsx`

Extract the pieces both views share (today duplicated/spread across
`tree/tasks-list.tsx` and `recent/.../tasks-recent-view.tsx`):

- `taskFields: FieldDef<TaskListItem>[]` — the merged schema above. (`status`
  options from `STATUS_META`, mirroring `tasks-recent-view.tsx:17-19`.)
- `createTaskRow(args)` — verbatim from `tasks-list.tsx:18-24`.
- `taskHierarchy: HierarchyConfig<TaskListItem>` — `getParentId`/`getRank`/
  `isExpanded`/`onToggleExpanded`/`onMove`/`onCreate`, verbatim from
  `tasks-list.tsx:82-90` (uses `patchTask`, `createTaskRow`).
- `buildTreeOptions({ rootTaskId }): TreeViewOptions<TaskListItem>` — verbatim from
  `tasks-list.tsx:42-58` (leadingIcon, labelClassName, hideTerminal, expandAll,
  rootId, addLabel, `toolbarStart: <Tasks.ListActions.Render/>`, rowMenu,
  dragOverlay).
- `isTerminal` — verbatim from `tasks-list.tsx:28-29`.

### 2. `tasks-list-view.tsx` — main combined surface

```tsx
const TASKS_LIST_VIEW = defineDataView("tasks-list");

export function TasksListView({ selectedId, onSelect }: {
  selectedId?: string; onSelect: (id: string) => void;
}) {
  const result = useResource(tasksResource);
  return (
    <ResourceView resource={result} fallback={<Loading variant="rows" />}>
      {(rows) => (
        <DataView<TaskListItem>
          rows={rows}
          fields={taskFields}
          rowKey={(t) => t.id}
          views={["tree", "list"]}
          defaultView="tree"
          storageKey={TASKS_LIST_VIEW}
          selectedRowId={selectedId}
          onRowActivate={(t) => onSelect(t.id)}
          selection={{}}
          hierarchy={taskHierarchy}
          viewOptions={{ tree: buildTreeOptions({}), list: {} }}
          itemActions={Tasks.TaskActions}
          emptyState="No tasks yet."
        />
      )}
    </ResourceView>
  );
}
```

`defaultView="tree"` (instance id derives from `slug("Tree")` = `"tree"`).
Drop the stale `// Embedded: the tab host already owns the scroll surface…`
comment — the pane now owns the scroll (see step 5).

### 3. `tasks-subtree-view.tsx` — embedded tree-only surface

Same shape as the current `TasksList` but its own surface id + tree-only:

```tsx
const TASKS_SUBTREE_VIEW = defineDataView("tasks-subtree");

export function TasksSubtree({ selectedId, rootTaskId, onSelect }: {
  selectedId?: string; rootTaskId?: string; onSelect: (id: string) => void;
}) {
  // ResourceView over tasksResource → DataView with
  //   views={["tree"]} storageKey={TASKS_SUBTREE_VIEW}
  //   hierarchy={taskHierarchy} viewOptions={{ tree: buildTreeOptions({ rootTaskId }) }}
  //   itemActions={Tasks.TaskActions} selection={{}}
}
```

### 4. `slots.ts` — drop tabbed-view

```ts
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { TaskListItem } from "@plugins/tasks/plugins/tasks-core/core";
import type { ComponentType } from "react";

export const Tasks = {
  TaskActions: defineItemActions<TaskListItem>("tasks.task-actions"),
  ListActions: defineRenderSlot<{ component: ComponentType }>(
    "tasks.list-actions", { docLabel: (p) => p.id },
  ),
};
```

Remove `defineTabbedView`, `Tasks.View`, `Tasks.Host`, and the `TaskViewProps`
export (used only by the deleted recent view + the tree view; both replaced by
local prop types). `Tasks.ListActions` is retained as a slot (zero contributors
today — preserved for API stability, rendered tree-scoped via
`buildTreeOptions().toolbarStart`).

### 5. `task-detail` rewiring

- `panes.tsx:44` — replace `<Tasks.Host className="h-full p-lg" …>` with the
  agents-pane precedent (`agents/web/panes.tsx:61-72`):
  ```tsx
  <PaneChrome pane={tasksRootPane} title="Tasks">
    <Inset pad="lg">
      <TasksListView selectedId={selectedId} onSelect={…} />
    </Inset>
  </PaneChrome>
  ```
  `PaneChrome` routes its body through `<PaneScroll>`, so the natural-height
  DataView scrolls for free (replaces the tabbed-view `Column fill` scroller).
  Import `TasksListView` + `Inset`; drop the `Tasks` import here.
- `task-tree-detail.tsx:4,32` — swap `TasksList` → `TasksSubtree` from
  `@plugins/tasks/plugins/task-list/web`. The existing `<Scroll>` wrapper stays
  (provides the embedded scroll ancestor).

### 6. `index.ts`

Drop `export type { TaskViewProps }`; add
`export { TasksListView } from "./components/tasks-list-view"` and
`export { TasksSubtree } from "./components/tasks-subtree-view"`. Row-action
contributions unchanged.

### 7. Delete

- `task-list/plugins/tree/` and `task-list/plugins/recent/` (whole trees).
- `config/tasks/task-list/tree/tasks-list.jsonc` (+ `.origin.jsonc`) — old path.
- `config/tasks/task-list/recent/tasks-recent.jsonc` (+ `.origin.jsonc`).

### 8. Author configs

After a build regenerates the origins, copy the `// @hash` (the descriptor shape
is constant → hash `edfdc62ed108`, matching every existing `*.origin.jsonc`):

`config/tasks/task-list/tasks-list.jsonc`:
```jsonc
// @hash edfdc62ed108
{
  "views": [
    { "name": "Tree", "view": { "type": "tree" } },
    { "name": "Recent", "view": { "type": "list", "sort": { "fieldId": "updatedAt", "direction": "desc" } } }
  ]
}
```

`config/tasks/task-list/tasks-subtree.jsonc`:
```jsonc
// @hash edfdc62ed108
{ "views": [{ "name": "Tree", "view": { "type": "tree" } }] }
```

Both land under `tasks.task-list` (the consuming plugin) per config_v2 path
derivation. `./equin build` regenerates `data-views.generated.ts`
(drops `tasks-recent`, repoints `tasks-list` to `tasks.task-list`, adds
`tasks-subtree`) and the `.origin.jsonc` files.

## Critical files

- `plugins/tasks/plugins/task-list/web/slots.ts` (drop tabbed-view)
- `plugins/tasks/plugins/task-list/web/index.ts` (exports)
- `plugins/tasks/plugins/task-list/web/internal/tasks-data-view.tsx` (NEW shared)
- `plugins/tasks/plugins/task-list/web/components/tasks-list-view.tsx` (NEW)
- `plugins/tasks/plugins/task-list/web/components/tasks-subtree-view.tsx` (NEW)
- `plugins/tasks/plugins/task-list/plugins/{tree,recent}/` (DELETE)
- `plugins/tasks/plugins/task-detail/web/panes.tsx` (TasksListView + Inset)
- `plugins/tasks/plugins/task-detail/web/components/task-tree-detail.tsx` (TasksSubtree)
- `config/tasks/task-list/{tasks-list,tasks-subtree}.jsonc` (NEW); delete old tree/recent configs
- Reuse: `defineDataView`, `DataView`, `Tasks.TaskActions`, `buildTreeOptions`
  pieces from existing `tasks-list.tsx`; `agents/web/panes.tsx` as the pane
  precedent.

## Verification

1. `./equin build` — green; regenerates manifest + origins + both CLAUDE.md
   docs. Then `./equin check` — specifically `data-view:configs-authored`
   (both new ids have configs, `tasks-recent` gone), `data-views-in-sync`,
   `plugins-registry-in-sync`, `plugins-doc-in-sync`, `type-check`,
   `plugin-boundaries`.
2. App at `http://<worktree>.localhost:9000/agents` (Tasks pane): single switcher
   shows **Tree | Recent + (+)** — no doubled chrome. Tree renders the hierarchy;
   switching to Recent shows the flat list sorted by recency. Use
   `e2e/screenshot.mjs --click "Recent"` to capture before/after switch and
   confirm the bordered tab box is gone.
3. Named-instance actions: rename/duplicate/reorder/add a view via the switcher →
   persists to `config/tasks/task-list/tasks-list.jsonc` on disk and survives
   reload (active-id stays device-local).
4. Embedded sub-tree: open a conversation's tasks panel (the
   `ConversationTasksBody` path) → rooted tree-only renders, **no Recent tab**,
   item actions + rename work, scoped to `rootTaskId`.
5. No console `[DataView …] no scroll ancestor` warning in either surface (logs at
   `~/.singularity/worktrees/<wt>/logs/`).
6. `rg "defineTabbedView|Tasks\.Host|Tasks\.View|TaskViewProps" plugins/tasks` →
   nothing. `tabbed-view` plugin itself stays (still used by conversations +
   debug/slow-ops — ST8 scope).
