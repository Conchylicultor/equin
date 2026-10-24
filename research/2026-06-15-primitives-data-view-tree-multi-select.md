# data-view tree view: multi-select + migrate tasks & agents

## Context

The unified `data-view` tree view (`plugins/primitives/plugins/data-view/plugins/tree`)
shipped (per `research/2026-06-12-primitives-data-view-tree-view.md`) **without**
checkbox multi-select. This was explicitly filed as follow-up task #1 of that plan.

As a result, the two surfaces that need multi-select — the **tasks tree tab**
(`plugins/tasks/plugins/task-list/plugins/tree/web/tasks-list.tsx`) and the
**agents list** (`plugins/conversations/plugins/agents/web/components/agents-list.tsx`)
— still run on their own bespoke `TreeList` wiring: each hand-rolls
`MultiSelectProvider` + `SelectionBar` + a `deriveVisibleOrder` helper, and tasks
additionally needs `folderId↔parentId` mapping, `hideTerminal` filtering, and
`rootId` subtree scoping. They can't move onto the unified surface until it supports
selection.

**Goal:** add multi-select to the unified tree view, then migrate tasks and agents
onto it, deleting both bespoke `deriveVisibleOrder` implementations and the
hand-placed selection wiring.

## Key insight — multi-select belongs in the `tree` primitive, not the adapter

`TreeList` (`plugins/primitives/plugins/tree/web/internal/tree-list.tsx`) already
computes the **visible nested tree** (`visibleTree`, lines 169–175): rootId scope →
optimistic-expand overlay → `buildTree` → search `filterTree` → `hideTerminalSubtrees`.
The `deriveVisibleOrder` helpers in tasks (`tasks-list.tsx:80`) and agents
(`agents-list.tsx:84`) re-derive *exactly* this DFS-skip-collapsed walk to feed
`MultiSelectProvider.orderedIds`.

So multi-select must live where the visible order already exists — **inside
`TreeList`** — not be re-implemented a third time in the data-view adapter (which
never computes the order; it hands raw rows to `TreeList`). Deriving `orderedIds`
by flattening `visibleTree` is free *and* strictly more correct (it uses the
expand state reconciled with the optimistic overlay, so selection never transiently
desyncs from what's painted).

This also eliminates the per-consumer hand-placed `<SelectionCheckbox>`: `RowChrome`
renders it automatically when selection is active.

## Design — four layers

### Layer 1 — `tree` primitive gains opt-in multi-select

`TreeList` accepts `multiSelect?: { actions?: ReactNode }`. When present:

- Derive `orderedIds` by DFS-flattening `visibleTree` (push `node.id`; recurse
  `node.children` only when `node.expanded`).
- Wrap the rows column (the `flex flex-col gap-2xs` div, `tree-list.tsx:296`) in
  `<MultiSelectProvider orderedIds={orderedIds}>`, rendering
  `<SelectionBar actions={multiSelect.actions}/>` just above `visibleTree.map`
  (`:344`).
- Add `multiSelect: boolean` to `TreeListContextValue` (`use-tree-row.tsx`).
- `RowChrome` reads `ctx.multiSelect` and passes a `leading={<SelectionCheckbox
  id={node.id}/>}` into `TreeRowChrome` (new `leading?: ReactNode` prop, rendered
  after the chevron block, before `{children}`).

**Files**
- `tree/web/internal/tree-list.tsx` — `multiSelect` prop; `orderedIds` memo;
  conditional `MultiSelectProvider` + `SelectionBar`; `multiSelect` in ctx.
- `tree/web/internal/use-tree-row.tsx` — `multiSelect: boolean` on
  `TreeListContextValue`.
- `tree/web/internal/row-chrome.tsx` — pass `leading` checkbox when active.
- `tree/web/internal/tree-row-chrome.tsx` — `leading?: ReactNode` prop, wrapped in
  a `group-hover/tree-row:opacity-100` reveal span when not active (see Risk R1).
- New imports: `MultiSelectProvider`, `SelectionBar`, `SelectionCheckbox` from
  `@plugins/primitives/plugins/multi-select/web`. Edge `tree → multi-select` is
  acyclic (multi-select imports neither tree nor anything that reaches it).

### Layer 2 — `data-view` core gains a `selection` capability

Mirror the existing `hierarchy` field: a data source declares itself selectable.

```ts
// data-view/core/internal/types.ts
export interface SelectionConfig {
  /** Bulk-action buttons in the SelectionBar (rendered inside the multi-select
   *  provider, so they may call useMultiSelect()). */
  bulkActions?: ReactNode;
}
// DataViewProps<TRow> and DataViewRenderProps<TRow> each gain:
selection?: SelectionConfig;
```

The host (`web/components/data-view.tsx`) threads `selection` into `renderProps`
unconditionally (presence-gated downstream, **not** `bulkActions` truthiness — tasks
passes `selection={{}}`). Export `SelectionConfig` from the core + web barrels.
Only the tree view implements it now (document table/gallery can adopt later via
their own `useFlatRows` order).

**Files**
- `data-view/core/internal/types.ts` — `SelectionConfig`, `selection` on both prop
  types.
- `data-view/core/index.ts` + `data-view/web/index.ts` — export `SelectionConfig`.
- `data-view/web/components/data-view.tsx` — destructure + thread `selection`.

### Layer 3 — `data-view/tree` adapter wires selection + tree-toolbar knobs

`TreeViewOptions` (`data-view/plugins/tree/web/internal/types.ts`) gains the knobs
tasks/agents need (additive to existing `renderRow`/`renderItemActions`/`rowMenu`/
`dragOverlay`/`addLabel`/`leadingIcon`):

```ts
rootId?: string;
hideTerminal?: { isTerminal: (row: TRow) => boolean };
expandAll?: boolean;
toolbarStart?: ReactNode;
labelClassName?: (row: TRow) => string | undefined;   // preserves done/dropped styling
renderItemActions?: (row: TRow, ctx: { hasChildren: boolean }) => ReactNode;  // gains ctx
```

`tree-view.tsx`:
- Pass `multiSelect={props.selection ? { actions: props.selection.bulkActions }
  : undefined}` to `TreeList`.
- Thread `rootId={options.rootId}`, and extend the `TreeList.toolbar` object
  (currently only `search`, `:207`) with `expandAll: options.expandAll`,
  `hideTerminal: options.hideTerminal && { isTerminal: (r) =>
  options.hideTerminal!.isTerminal(r.__row) }` (unwrap `__row`), and
  `start: options.toolbarStart`.
- In `DefaultRow`, pass `{ hasChildren: node.children.length > 0 }` to
  `renderItemActions`, and apply `options.labelClassName?.(row)` to both the
  `RenameInput` and the read-only label.

### Layer 4 — migrate tasks & agents onto `<DataView>`

Both follow the **pages-sidebar precedent** (`apps/pages/.../pages-sidebar.tsx`):
keep the outer `useResource` + pending guard, pass resolved rows to
`<DataView views={["tree"]} hierarchy={…} selection={…} viewOptions={{ tree: {…} }}>`.
`ViewSwitcher` already returns `null` for a single view (`view-switcher.tsx:17`), so
no lone switcher chip.

**Tasks** (`tasks-list.tsx`):
- Fields: `[{ id: "title", primary: true, value: (t) => t.title }]`.
- `hierarchy`: `getParentId: (t) => t.folderId`, `getRank: (t) => t.rank`,
  `isExpanded: (t) => t.expanded`,
  `onToggleExpanded: (id, next) => patchTask(id, { expanded: next })`,
  `onMove: (id, d) => patchTask(id, { folderId: d.parentId, rank: d.rank })`,
  `onRename: (id, next) => patchTask(id, { title: next })`,
  `onCreate: createTaskRow`. (Drop the `{...t, parentId: t.folderId}` projection —
  `getParentId` subsumes it.)
- `viewOptions.tree`: `leadingIcon: (t) => <StatusIcon status={t.status}/>`,
  `labelClassName: (t) => cn(t.status === "dropped" && "text-muted-foreground/70
  line-through italic", t.status === "done" && "text-muted-foreground")`,
  `hideTerminal: { isTerminal }`, `expandAll: true`, `rootId: rootTaskId`,
  `addLabel: rootTaskId ? null : "Add"`,
  `toolbarStart: <Tasks.ListActions.Render/>`,
  `renderItemActions: (t, { hasChildren }) => <Tasks.TaskActions.Render>{(a) =>
  <a.component taskId={t.id} hasChildren={hasChildren}/>}</Tasks.TaskActions.Render>`,
  `rowMenu: ({ addBelow }) => [{ icon: MdAdd, label: "Add item below", onClick:
  () => void addBelow() }]`, `dragOverlay: (t) => t.title || "Untitled"`.
- `selection={{}}` (parity — tasks has no bulk actions today).
- Delete `deriveVisibleOrder`, `isInSubtree`, `TaskRow`, and the
  `MultiSelectProvider`/`SelectionBar`/`SelectionCheckbox`/`TreeList`/`buildTree`/
  `hideTerminalSubtrees` imports.

**Agents** (`agents-list.tsx`):
- Render `<SystemFolder/>` above `<DataView>` (it never participates in
  multi-select; with the provider now inside `TreeList` it is cleanly outside).
- Fields: `[{ id: "name", primary: true, value: (a) => a.name }]`.
- `hierarchy`: accessors + `onToggleExpanded`/`onMove`/`onRename`/`onCreate` →
  `patchAgent` (agents store `parentId` natively — no mapping).
- `viewOptions.tree`: `leadingIcon: (a) => <><Avatar …/><AgentStatus
  agentId={a.id}/></>`, `renderItemActions: (a, { hasChildren }) =>
  <Agents.AgentActions.Render>{(a2) => <a2.component agentId={a.id}
  hasChildren={hasChildren}/>}</…>`, `rowMenu` "Add agent below",
  `expandAll: true`, `addLabel: "Agent"`, `toolbarStart:
  <Agents.ListActions.Render/>`.
- `selection={{ bulkActions: <DeleteSelectedAction/> }}` — `DeleteSelectedAction`
  calls `useMultiSelect()`; it stays in scope because it renders inside
  `SelectionBar` inside `TreeList`'s provider.
- **Keep `export async function patchAgent`** (the agents web barrel exports it;
  `ExpandCollapseAllAction` imports it). Move to its own module if the component is
  heavily rewritten. Delete `deriveVisibleOrder`/`AgentRow`.

The per-row slot contributors (Tasks/Agents `*Actions`: delete, expand-collapse,
child-count, launch-agent, agent-status) are **unchanged** — each takes only
`{ id, hasChildren }` and fetches its own data via `useResource`. The `*.ListActions`
toolbar slots are pure hosts → `toolbarStart`. No slot or schema changes.

## Risks & decisions

- **R1 — checkbox hover-reveal (must fix).** `SelectionCheckbox` hides via bare
  `group-hover:opacity-100`, but the tree row's hover group is the **named**
  `group/tree-row`. Centralizing the checkbox in `TreeRowChrome`, wrap it in a
  `group-hover/tree-row:opacity-100` reveal span (mirroring the chevron/actions
  reveal at `tree-row-chrome.tsx:81,96`) so hover-reveal is correctly scoped.
- **R2 — strikethrough styling.** Tasks styles the label per status
  (`tasks-list.tsx:70`). Preserved generically via the new
  `TreeViewOptions.labelClassName(row)` hook (Layer 3).
- **R3 — `renderItemActions` needs `hasChildren`.** It currently receives only the
  flat row; delete/child-count/expand-collapse actions disable on `hasChildren`.
  Add the `{ hasChildren }` ctx arg (Layer 3). Optional second param → pages-sidebar
  keeps compiling.
- **R4 — two toolbar rows.** With `views={["tree"]}` the host renders its own
  search row and `TreeList` renders expand-all/hide-completed/ListActions — two
  stacked rows for tasks/agents. Functionally correct and matches the data-view
  host/view split (pages already lives with the host search row). Keep
  `TreeList`'s own search input hidden (`hideInput: true`, already set) so there is
  only one search box. Collapsing to one row is a future host enhancement, out of
  scope.
- **R5 — `selection={{}}` activates.** Presence of `selection` enables multi-select,
  not `bulkActions` truthiness. Gate on `props.selection != null` in the adapter.

## Verification

1. `./equin build` from the worktree — regenerates the plugin registry +
   CLAUDE.md graphs (surfaces the new `tree → multi-select` edge and any illegal
   import), runs `./equin check` (boundaries, type-check, eslint,
   plugins-doc-in-sync, migrations-in-sync). Confirm clean start at
   `http://att-1781475612-b441.localhost:9000`.
2. Tasks tree (scripted `e2e/screenshot.mjs`): checkboxes appear on row hover and
   when active; **shift-range across a collapsed section selects only visible
   rows** (proves `orderedIds == visibleTree`); hide-completed prunes rows *and*
   their selection; expand-all works; per-row delete/launch/child-count still
   render and disable on children; `rootId` subtree mode hides the root Add button;
   done/dropped rows keep their muted/strikethrough label.
3. Agents list: bulk **Delete** via `DeleteSelectedAction` works from the bar;
   `SystemFolder` renders above and is not selectable; rename/move/create still
   round-trip; `patchAgent` consumers elsewhere still resolve.
4. Pages sidebar (regression): no checkboxes (no `selection`), tree nav unchanged.
5. Confirm gallery/table consumers (`apps/home/app-cards`) are untouched.

## Files

**Layer 1 (tree primitive):** `tree/web/internal/{tree-list,use-tree-row,row-chrome,
tree-row-chrome}.tsx`.
**Layer 2 (data-view core/host):** `data-view/core/internal/types.ts`,
`data-view/core/index.ts`, `data-view/web/index.ts`,
`data-view/web/components/data-view.tsx`.
**Layer 3 (adapter):** `data-view/plugins/tree/web/internal/types.ts`,
`data-view/plugins/tree/web/components/tree-view.tsx`.
**Layer 4 (consumers):** `tasks/plugins/task-list/plugins/tree/web/tasks-list.tsx`,
`conversations/plugins/agents/web/components/agents-list.tsx` (+ extract
`patch-agent.ts` if needed).
