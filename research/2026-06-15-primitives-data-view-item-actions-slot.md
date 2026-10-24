# Cross-view per-item action contribution slot for `data-view`

## Context

Per-item row actions (delete, expand-all, launch-agent, …) are **tree-only**
today and aren't even a `data-view` feature. Each consumer re-invents its own
bespoke slot:

- pages — `PageTree.RowActions` + `DeletePageAction`
- tasks — `Tasks.TaskActions` (child-count, expand-collapse-all, delete, launch-agent)
- agents — `Agents.AgentActions` (expand-collapse-all, delete)

Each then re-wires that slot into the tree through a **stopgap**:
`TreeViewOptions.renderItemActions?(row, { hasChildren })`, which only the tree
view honors (it maps 1:1 to `RowChrome.actions`). The table and gallery views
have **no** per-item action affordance at all (`DataCard` even has an unused
`actions` prop). This stopgap was always meant to be temporary — the data-view
tree-migration research doc (`research/2026-06-12-primitives-data-view-tree-view.md`,
lines 97–105) explicitly defers a real cross-view slot to "follow-up task 2",
which this plan delivers.

**Goal:** one `data-view`-owned per-item action mechanism. A plugin contributes
an item action **once**; every view renders it in its natural affordance —
tree-row hover-trailing, table-row hover-trailing, gallery-card top-right hover.
Replace `renderItemActions`; migrate pages, tasks, and agents onto it.

## Design

Add a **`defineItemActions<TRow>(id)` factory** to the data-view web barrel,
mirroring the established `detail-sections` / `tabbed-view` factory precedent.
Each consumer calls it **once** to mint its own typed item-action slot;
contributors register an action once; `<DataView>` renders all contributions in
every view's trailing affordance.

### Why a per-consumer factory, not one global `DataViewSlots.ItemActions`

The data-view CLAUDE.md already documents the rule: a **global slot** is for a
*fixed shared vocabulary* with one render-props contract (that's why `View` is
global); a **factory** is for "each host instantiates its own typed slot." Item
actions are the factory case:

- Row types are disjoint and unrelated — `Block`, `TaskListItem`, `Agent`. A
  single global slot would force `ComponentType<ItemActionProps<unknown>>` and
  make every action re-cast `row as Block` internally — exactly the erosion the
  typed factory avoids.
- A global slot needs a runtime `kind` discriminator to keep an agent's Delete
  off a page row. The slot **id** already is that discriminator; per-consumer
  slots are isolated by construction. A forgotten filter on a global slot leaks
  actions across apps.
- Contributor sets differ (pages 1, tasks 4, agents 2) — exactly the
  `detail-sections` / `tabbed-view` shape, not the `View` shape.

### Contribution shape — pass the full typed row

Contributors receive the **full `row: TRow`** plus `hasChildren: boolean`,
instead of bespoke `pageId` / `taskId` / `agentId`. Passing the row subsumes
pages' `title` channel (derive `pageData(row).title` inside the component) and is
strictly more capable.

## Implementation

### 1. Core types — `plugins/primitives/plugins/data-view/core/internal/types.ts`

`core` already references React types (`DataViewProps.actions?: ReactNode`), so
the descriptor interface (a bare `ComponentType`) can live here without `core`
importing `web`.

```ts
export interface ItemActionProps<TRow> {
  row: TRow;
  /** True when this row has at least one child in the data source's hierarchy. */
  hasChildren: boolean;
}

/**
 * Minimal item-actions surface the views consume. `defineItemActions` (web)
 * returns a value satisfying this PLUS the callable contribution-registrar.
 */
export interface ItemActionsDescriptor<TRow> {
  /** Renders ALL contributed actions for one row, each error-boundary-isolated. */
  Row: ComponentType<ItemActionProps<TRow>>;
}
```

Add `itemActions?: ItemActionsDescriptor<TRow>` to **both** `DataViewProps<TRow>`
and `DataViewRenderProps<TRow>`. Add to `DataViewRenderProps<TRow>`:

```ts
  /** True when `rowId` has ≥1 child — derived once by the host from
   *  `hierarchy.getParentId` over `rows`. Flat views (table/gallery) call this
   *  for a correct `hasChildren`; the tree uses its own node count. */
  hasChildren?: (rowId: string) => boolean;
```

Export `ItemActionProps`, `ItemActionsDescriptor` from `core/index.ts`.

### 2. Web factory — new `plugins/primitives/plugins/data-view/web/internal/define-item-actions.tsx`

```tsx
import type { ComponentType, ReactNode } from "react";
import { defineRenderSlot, type RenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { ItemActionProps, ItemActionsDescriptor } from "../../core";

export interface ItemActionContribution<TRow> {
  id: string;
  component: ComponentType<ItemActionProps<TRow>>;
  order?: number;
}

export interface ItemActions<TRow>
  extends RenderSlot<ItemActionContribution<TRow>>,
    ItemActionsDescriptor<TRow> {}

export function defineItemActions<TRow>(id: string): ItemActions<TRow> {
  const slot = defineRenderSlot<ItemActionContribution<TRow>>(id, {
    docLabel: (p) => p.id,
  });
  const Row = ({ row, hasChildren }: ItemActionProps<TRow>): ReactNode => (
    <slot.Render>
      {(item) => {
        const C = item.component;
        return <C row={row} hasChildren={hasChildren} />;
      }}
    </slot.Render>
  );
  // `slot` is a callable function-object (like every defineRenderSlot result);
  // attach `Row` the same way `.Render`/`.useContributions` are attached.
  return Object.assign(slot, { Row }) as ItemActions<TRow>;
}
```

The factory returns a value that is **callable for contributions**
(`PageActions({ id, component })`, unchanged from today's `defineRenderSlot`
call sites) and carries `.Row` for the descriptor. `.Render`'s render-prop
children already wrap each contribution in the error-boundary item middleware —
views render `<itemActions.Row …/>` directly, so there is exactly one isolation
layer (no double-wrap).

Export from `web/index.ts`:

```ts
export { defineItemActions } from "./internal/define-item-actions";
export type { ItemActions, ItemActionContribution } from "./internal/define-item-actions";
// add ItemActionProps, ItemActionsDescriptor to the existing `export type { … } from "../core"`
```

### 3. Host threading — `plugins/primitives/plugins/data-view/web/components/data-view.tsx`

Derive the `hasChildren` predicate once (memoized) from `hierarchy.getParentId`
over `rows` (absent hierarchy → always `false`), and pass both it and
`itemActions` (type-erased like `rows`/`hierarchy`) into `renderProps`:

```ts
const hasChildren = useMemo(() => {
  const parents = new Set<string>();
  if (hierarchy) {
    rows.forEach((row, i) => {
      const pid = hierarchy.getParentId(row as TRow);
      if (pid != null) parents.add(pid);
    });
  }
  return (rowId: string) => parents.has(rowId);
}, [rows, hierarchy]);
```

```ts
// in the renderProps object literal:
itemActions: itemActions as DataViewRenderProps<unknown>["itemActions"],
hasChildren,
```

(`getParentId` returns ids in the same space as `rowKey` — verified: pages
`b.parentId`/`b.id`, tasks `folderId`/`t.id`, agents `parentId`/`a.id`.)

### 4. Per-view affordance rendering

**Tree** — `plugins/primitives/plugins/data-view/plugins/tree/web/components/tree-view.tsx`
- Remove `renderItemActions?` from `TreeViewOptions` (`internal/types.ts`) and its
  doc line.
- Cast `props.itemActions` at the documented cast boundary; pass it into
  `DefaultRow` (add a prop) and add it to the `Row` `useCallback` deps.
- Replace the `actions={options.renderItemActions?.(…)}` line in `DefaultRow`:
  ```tsx
  actions={
    itemActions ? (
      <itemActions.Row row={row} hasChildren={node.children.length > 0} />
    ) : undefined
  }
  ```
  (`row` is `node.__row`; `node.children.length` stays the tree's hasChildren
  source.) Import `ItemActionsDescriptor` from the data-view web barrel.

**Table** — give the **`data-table` primitive** a first-class `rowActions` prop
(clean reusable affordance; the row-hover named group belongs in the primitive,
not a magic class injected from data-view):

`plugins/primitives/plugins/data-table/web/internal/types.ts` — add to
`DataTableProps<TRow>`:
```ts
  /** Trailing per-row actions, hover-revealed in their own column. */
  rowActions?: (row: TRow, index: number) => ReactNode;
```
`plugins/primitives/plugins/data-table/web/internal/data-table.tsx`:
- When `rowActions` is set, append an `"auto"` track to the grid `template` and an
  empty trailing header span.
- Add `group/dt-row` to the row `div` className.
- After the column cells, render the actions cell:
  ```tsx
  {rowActions && (
    <div
      className="flex items-center justify-end gap-xs opacity-0 transition-opacity group-hover/dt-row:opacity-100 focus-within:opacity-100"
      onClick={(e) => e.stopPropagation()}
    >
      {rowActions(row, i)}
    </div>
  )}
  ```

`plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx`
— forward it:
```ts
const itemActions = props.itemActions as ItemActionsDescriptor<unknown> | undefined;
// on <DataTable …>:
rowActions={
  itemActions
    ? (row, i) => (
        <itemActions.Row row={row} hasChildren={props.hasChildren?.(props.rowKey(row, i)) ?? false} />
      )
    : undefined
}
```

**Gallery** — `plugins/primitives/plugins/data-view/plugins/gallery/web/components/gallery-view.tsx`
— pass the existing `DataCard.actions` (already hover-reveal + stopPropagation)
in the default-card path only (custom `renderCard` owns its own actions):
```tsx
actions={
  itemActions ? (
    <itemActions.Row row={row} hasChildren={props.hasChildren?.(props.rowKey(row, i)) ?? false} />
  ) : undefined
}
```

### 5. Migrate the three consumers

Each: replace the bespoke `defineRenderSlot` with `defineItemActions<Row>(id)`
(keep the slot id stable); change each action component's props to
`ItemActionProps<Row>` (read `row.id`, etc.); leave the `index.ts` contribution
calls unchanged in shape/order; swap `viewOptions.tree.renderItemActions` for
`itemActions={…}` on `<DataView>`. **Preserve every behavior.**

**Pages** — `plugins/apps/plugins/pages/plugins/page-tree/`
- `web/slots.ts`: `RowActions: defineItemActions<Block>("pages.tree.row-actions")`
  (keep `PageDetail.Section` and its `defineRenderSlot` import).
- `web/components/delete-page-action.tsx`: `({ row }: ItemActionProps<Block>)` →
  `const pageId = row.id; const title = pageData(row).title;` — loading guard
  (`pagesResource`), confirm dialog, descendant count, hard `deleteBlock` all
  unchanged.
- `web/components/pages-sidebar.tsx`: drop `renderItemActions` from
  `viewOptions.tree`; add `itemActions={PageTree.RowActions}`.

**Tasks** — `plugins/tasks/plugins/task-list/`
- `web/slots.ts`: `TaskActions: defineItemActions<TaskListItem>("tasks.task-actions")`
  (leave `View` / `Host` / `ListActions` untouched).
- The four components (`child-count`, `expand-collapse-all`, `delete`,
  `launch-agent`): props → `ItemActionProps<TaskListItem>`, `const taskId = row.id;`.
  Null-on-leaf (child-count, expand-collapse), soft-drop + leaf-only-disabled
  (delete), always-on launch — all unchanged.
- `plugins/tree/web/tasks-list.tsx`: drop `renderItemActions` from `treeOptions`;
  add `itemActions={TasksSlots.TaskActions}`.

**Agents** — `plugins/conversations/plugins/agents/`
- `web/slots.ts`: `AgentActions: defineItemActions<Agent>("agents.agent-actions")`
  (`Agent` from `./shared/resources`; leave the other slots).
- `web/components/{delete-agent-action,expand-collapse-all-action}.tsx`: props →
  `ItemActionProps<Agent>`, `const agentId = row.id;` — hard delete + leaf-only
  (delete), null-on-leaf (expand-collapse) unchanged.
- `web/components/agents-list.tsx`: drop `renderItemActions` from
  `viewOptions.tree`; add `itemActions={AgentsSlots.AgentActions}`.

### 6. Docs & build

Update CLAUDE.md prose: `data-view` (new `defineItemActions` factory +
`itemActions` prop), `data-view/tree` (drop `renderItemActions`), `data-table`
(new `rowActions` prop + `group/dt-row` row group). Run `./equin build` —
it regenerates `web.generated.ts` and the autogen plugin-reference blocks.

## Critical files

- `plugins/primitives/plugins/data-view/core/internal/types.ts` (+ `core/index.ts`)
- `plugins/primitives/plugins/data-view/web/internal/define-item-actions.tsx` (new)
- `plugins/primitives/plugins/data-view/web/index.ts`
- `plugins/primitives/plugins/data-view/web/components/data-view.tsx`
- `plugins/primitives/plugins/data-view/plugins/tree/web/{components/tree-view.tsx,internal/types.ts}`
- `plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx`
- `plugins/primitives/plugins/data-view/plugins/gallery/web/components/gallery-view.tsx`
- `plugins/primitives/plugins/data-table/web/internal/{types.ts,data-table.tsx}`
- pages: `…/page-tree/web/{slots.ts,components/delete-page-action.tsx,components/pages-sidebar.tsx}`
- tasks: `…/task-list/web/{slots.ts,components/*-action.tsx}`, `…/task-list/plugins/tree/web/tasks-list.tsx`
- agents: `…/agents/web/{slots.ts,components/{delete-agent-action,expand-collapse-all-action,agents-list}.tsx}`

## Verification

1. `./equin build` succeeds; `rg renderItemActions plugins` returns
   nothing.
2. App at `http://<worktree>.localhost:9000`:
   - **Pages tree**: hover a page → Delete reveals; click → confirm dialog with
     correct descendant count; delete removes page + descendants.
   - **Tasks tree**: leaf row → Delete (drop) enabled, no child-count/expand-all;
     parent row → child-count + expand-all + Delete disabled; Launch on all.
   - **Agents tree**: leaf → Delete enabled; parent → expand-all + Delete
     disabled (hard delete works).
   Capture before/after with `e2e/screenshot.mjs` (hover via `--click` won't
   reveal; use a scripted run that hovers the row, or assert button presence).
3. Forward-looking flat check (verification-only, revert after): temporarily add
   `views={["tree", "table"]}` to tasks and confirm the trailing actions reveal
   on table-row hover with correct `hasChildren` (child-count shows on a parent).

## Risks

- **Type erosion at the View-slot boundary** — `itemActions` arrives
  `ItemActionsDescriptor<unknown>`; views re-cast at the documented boundary
  (same as `rows`/`fields`/`hierarchy`). Action *components* keep full typing via
  the closed `TRow` in `defineItemActions`.
- **`data-table` row group** — adding `group/dt-row` + an `"auto"` track is
  additive and inert for existing `DataTable` consumers (studio/debug) that don't
  pass `rowActions`.
- **Click propagation** — tree action buttons already `stopPropagation`;
  `DataCard.actions` and the new table actions cell stop it themselves, so row
  activation never fires from an action click.
