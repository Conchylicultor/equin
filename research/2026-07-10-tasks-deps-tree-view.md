# Tasks: tree-based dependency view (`task-deps-tree`)

## Context

The task-detail graph section (`tasks/task-graph`, xyflow canvas) is hard to read. The root cause is that it renders two distinct relations in one picture: the **creation tree** (which task created which — already persisted as `tasks.folderId`, with `tasks.author` recording the creating conversation) and the **dependency chain** (`task_dependencies` edges driving auto-start order).

This plan adds a new task-detail section with two switchable tree views — one per relation — while keeping the graph section as-is. Decisions made with the user:

- **Deps tree representation: nesting = runs-after, siblings = parallel.** Every `task_dependencies` edge is a literal tree edge; dependencies are fully inferred from tree shape, no cut/markers needed. (A task's dependents render as its children.)
- **Fan-in** (task depending on 2+ tasks): rendered once under a deterministic *primary parent* (oldest edge); other prerequisites shown as removable "also after: X" chips.
- **Drop onto a row = splice** (insert into the chain: target's old children rewire to depend on the dragged task); **drop in a before/after sibling zone = branch** (parallel child of that zone's parent).
- **Drag moves the single task, not its subtree**: the old position *heals* (its children rewire to its old parents) — this is what makes chain reorder (`0→1→2→3` → `0→2→1→3`) expressible.
- **Per-row detach** removes the edge to the rendered parent (task becomes a root; its subtree follows).
- Drag-and-drop exists **only** in the deps view; the creation view is read-only.
- All multi-edge mutations are atomic via the existing `withTaskStatusBatch` so no intermediate zero-blocker state can fire auto-start. (A *final* state with zero blockers on an armed task will auto-start it — that is intended semantics, not a transient.)
- Graph section stays (its connect-handle remains the add-new-edge affordance; `onCreate` is deliberately omitted from the deps tree in v1).

## Verified substrate (why no primitive changes are needed)

- `task_dependencies(taskId, dependsOnTaskId, createdAt)` — M2M, `taskId` depends on `dependsOnTaskId`, **no order column**; `tasks_v` aggregates `dependencies: string[]` ordered by edge `createdAt` (⇒ `dependencies[0]` is the deterministic oldest-edge primary parent).
- `addTaskDependency` / `removeTaskDependency` (`plugins/tasks/plugins/tasks-core/server/internal/mutations/tasks.ts:143-195`) accept a tx, cycle-check via `TaskGraph.dependsOn`, and coalesce status events inside `withTaskStatusBatch` (`.../tasks-core/server/internal/status-batch.ts`) — the exact pattern `rewireDependencies` and `insertTaskBetween` already use.
- The generic tree already conveys splice-vs-branch intent to `HierarchyConfig.onMove` (`plugins/primitives/plugins/tree/web/internal/tree-list.tsx` `onDragEnd`): a drop **onto** a row arrives as `{ targetId: null, parentId: <that row> }`; a sibling-zone drop arrives as `{ targetId: <sibling>, parentId: <zone parent> }`. So: `dest.targetId === null ⇒ splice`, else branch.
- `TasksSubtree` (`plugins/tasks/plugins/task-list/web/components/tasks-subtree-view.tsx`) already renders the folderId tree scoped to a `rootTaskId` — the creation view is a reuse, not a rebuild. It currently ships drag (`taskHierarchy.onMove`); it gains a `readOnly` prop.
- `view-switcher` primitive: `useActiveViewId(storageKey)` + `ViewSwitcher` pure chrome. `data-view`'s `rows`/`hierarchy` are single props (not per-view-instance), and the two views have different row sets AND parent functions — so **two independent mounts behind a local switcher**, not a data-view generalization (rejected: heavy change to load-bearing props for one consumer).

## Implementation

### 1. New plugin `plugins/tasks/plugins/task-deps-tree/`

- `package.json` — mirror `task-graph`'s.
- `core/deps-tree.ts` + `core/index.ts` — pure derivation:
  ```ts
  export interface DepsTreeRow extends TaskListItem {
    depsParentId: string | null;   // primary parent (tree edge)
    extraDeps: TaskListItem[];     // fan-in → "also after" chips
  }
  export function buildDepsTree(tasks: readonly TaskListItem[], rootId: string): DepsTreeRow[];
  ```
  `TaskGraph.from(tasks).closure(rootId, { includeGroups: false })` (connected dependency component, same scoping philosophy as the graph section, groups excluded); return `[]` when closure ≤ 1. Per task: in-closure `deps = task.dependencies.filter(inClosure)`; `depsParentId = deps[0] ?? null`; `extraDeps = deps.slice(1)`. Multiple roots = top-level siblings. Settled tasks stay in rows (muted at render).
- `core/deps-tree.test.ts` — bun:test: linear chain, fan-in, fan-out, diamond, multiple roots, settled-in-middle, closure ≤ 1 ⇒ `[]`.
- `web/index.ts` — contributes `TaskDetailSlots.Section({ id: "deps-tree", label: "Dependencies", component: DepsTreeSection })`.
- `web/components/deps-tree-section.tsx` — `useActiveViewId("task-deps-tree:view")` (default to `"deps"` when unset) + `ViewSwitcher` over `[{id:"deps",title:"Dependencies"},{id:"creation",title:"Created"}]`; renders `<DepsTreeView taskId/>` or `<TasksSubtree rootTaskId={taskId} readOnly …/>`. Renders `null` when the deps closure ≤ 1 **and** the folder subtree is empty (mirrors the graph section's self-hide).
- `web/components/deps-tree-view.tsx` — the deps `DataView`:
  ```tsx
  const DEPS_TREE_VIEW = defineDataView("task-deps-tree");
  // rows = buildDepsTree(allTasks, taskId) from useResource(tasksResource)
  <DataView<DepsTreeRow> rows fields rowKey views={["tree"]} storageKey={DEPS_TREE_VIEW}
    selectedRowId={taskId} onRowActivate={navigate} hierarchy={depsHierarchy}
    viewOptions={{ tree: depsTreeOptions }} itemActions={DepsActions} />
  ```
  `depsHierarchy`: `getParentId: r => r.depsParentId`; `getRank: r => r.rank` (folder rank reused as *cosmetic* deterministic sibling order — siblings are parallel, no order is persisted, and `dest.rank` is discarded since `onMove` is endpoint-based per the documented projection rule in data-view `types.ts`); no `isExpanded`/`onToggleExpanded` (local expand state); no `onCreate`;
  ```ts
  onMove: (id, dest) => fetchEndpoint(moveTaskInDepsTree, { id },
    { body: { newParentId: dest.parentId, mode: dest.targetId === null ? "splice" : "branch" } })
  ```
- `web/internal/deps-tree-fields.tsx` — `FieldDef<DepsTreeRow>[]`: `title` (primary, `onEdit` → `patchTask`) + `status` badge; `depsTreeOptions: TreeViewOptions<DepsTreeRow>`: status `leadingIcon`, muted/struck `labelClassName` for settled rows (same styling as the graph), `trailing: r => r.extraDeps.map(d => <AlsoAfterChip …/>)`, `expandAll: true`, `dragOverlay`. (Define fields locally — `task-list`'s `taskFields` is barrel-internal.)
- `web/internal/deps-actions.tsx` — `defineItemActions<DepsTreeRow>("task-deps-tree.actions")` with `DetachAction` (`MdLinkOff`, shown when `depsParentId != null`) → existing `DELETE /api/tasks/:id/dependencies/:depId`; `AlsoAfterChip` (removable chip, precedent: `task-dependencies` chips) → same DELETE endpoint.

### 2. Server: atomic drag rewire

- `plugins/tasks/core/endpoints.ts` — add:
  ```ts
  export const DepsMoveBodySchema = z.object({
    newParentId: z.string().nullable(), mode: z.enum(["splice", "branch"]) });
  export const moveTaskInDepsTree = defineEndpoint({
    route: "POST /api/tasks/:id/deps-move", body: DepsMoveBodySchema });
  ```
- `plugins/tasks/server/internal/deps-tree-move.ts` — **sibling** of `rewire-dependencies.ts` (that one models "insert a NEW task"; this models "move an EXISTING node with heal" — don't overload it). One `withTaskStatusBatch` tx:
  1. **Heal X's old position**: snapshot X's parents (`oldDeps`) and children (`oldDependents`); remove `X→p` for each parent; for each child C: remove `C→X`, add `C→p` for every old parent p (cross-product bridge — C still runs after everything X ran after).
  2. **Attach**: splice ⇒ snapshot Y's children *before* adding; `add X→Y`; each old child C≠X of Y: `remove C→Y`, `add C→X`. Branch ⇒ `add X→Y` only. `newParentId === null` ⇒ healed root (ready/parallel).
  Cycle safety: every `addTaskDependency` cycle-checks on the tx and throws, aborting the whole batch; the web-side `isDescendant` guard pre-blocks drops onto own rendered subtree.
- `plugins/tasks/server/internal/handle-deps-move.ts` — `implement(moveTaskInDepsTree, …)`; register in `plugins/tasks/server/index.ts` `httpRoutes`.
- `plugins/tasks/server/internal/deps-tree-move.test.ts` — bun:test via `db-test-fixture` (precedent: `session-chain/server/internal/record.test.ts`): seed chain `0←1←2←3`; splice-move 1 onto 2 ⇒ `0←2←1←3`; branch-to-root; fan-in heal cross-product; cycle rejection throws.

### Edge operations per gesture (all `A→B` = "A depends on B")

| Gesture | Trigger | Edge ops (one tx where >1) |
|---|---|---|
| drag-splice | drop X onto Y (`dest.targetId === null`) | heal X; `add X→Y`; ∀ old child C of Y: `remove C→Y`, `add C→X` |
| drag-branch | drop X in sibling zone of parent Z | heal X; if Z ≠ null `add X→Z` |
| detach | row unlink action | `remove X→renderedParent` only — **no heal**, subtree follows (existing DELETE endpoint) |
| chip-remove | click "also after: P" chip | `remove X→P` (existing DELETE endpoint) |

### 3. Read-only creation view

`plugins/tasks/plugins/task-list/web/components/tasks-subtree-view.tsx` (+ `internal/tasks-data-view.tsx`): add `readOnly?: boolean` to `TasksSubtree` — when set, pass a hierarchy without `onMove`/`onCreate` (omitting `onMove` already disables drag in the tree primitive). No fork, one derived variant.

### 4. Config (required by `data-view:configs-authored`)

`config/tasks/task-deps-tree/task-deps-tree.jsonc`:
```jsonc
{ "views": [{ "name": "Tree", "view": { "type": "tree", "visibleFields": ["title"] } }] }
```
`./equin build` regenerates `data-views.generated.ts`, scaffolds `.origin.jsonc`, fills `@hash`. Creation tab reuses the existing `tasks-subtree` config — nothing new.

## Files

**Create**: `plugins/tasks/plugins/task-deps-tree/{package.json, core/index.ts, core/deps-tree.ts, core/deps-tree.test.ts, web/index.ts, web/components/deps-tree-section.tsx, web/components/deps-tree-view.tsx, web/internal/deps-tree-fields.tsx, web/internal/deps-actions.tsx}`; `plugins/tasks/server/internal/deps-tree-move.ts`; `plugins/tasks/server/internal/handle-deps-move.ts`; `plugins/tasks/server/internal/deps-tree-move.test.ts`; `config/tasks/task-deps-tree/task-deps-tree.jsonc`.

**Modify**: `plugins/tasks/core/endpoints.ts`; `plugins/tasks/server/index.ts`; `plugins/tasks/plugins/task-list/web/components/tasks-subtree-view.tsx` + `web/internal/tasks-data-view.tsx` (readOnly variant).

**Autogen (build)**: plugin `CLAUDE.md`, registries, `data-views.generated.ts`, `.origin.jsonc`, `docs/plugins-*.md`.

## Verification

1. `./equin build` (registry + data-view manifest + checks).
2. `bun test plugins/tasks/plugins/task-deps-tree/core` and `bun test plugins/tasks/server/internal/deps-tree-move.test.ts`.
3. Scripted Playwright (`bun e2e/screenshot.mjs --url http://att-1783675998-rkth.localhost:9000/agents/... `): open a task with a dependency chain; capture both switcher tabs; exercise detach and chip-remove; verify a splice-move via `query_db` on `task_dependencies` before/after.

## Resolved design calls & remaining risks

- **Heal = cross-product bridge** to all old parents (children keep running after everything the moved task ran after). Can densify heavily fan-in graphs; acceptable, and chips make extra edges visible/removable.
- **Closure scope = connected component** (matches the graph section's closure semantics; forward-only would hide dependents, which are the interesting part here).
- **Section stacking**: graph (`h-60`) + natural-height deps tree both render in the detail scroll; check vertical budget at screenshot time (cosmetic).
- **Client cycle guard is tree-shaped only** — a drop that forms a cycle through a chip-edge passes the client guard but is rejected server-side (tx aborts, loud error). Acceptable: rare, safe, visible.
