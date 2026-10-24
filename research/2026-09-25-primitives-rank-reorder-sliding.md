# Rank-reorder: sliding (sortable) drag within a section

## Context

DataView manual-order drag (list / icons / table views; e.g. the conversations
sidebar Queue) goes through `primitives/rank-reorder`, which is built on the low-level
`@dnd-kit/core` pieces: `useDraggable`, two `useDroppable` zones per row (before/after),
and a floating `DragOverlay` chip. Rows stay where they are and a 2px line marks
the drop point. `SortableList` (`@dnd-kit/sortable`) feels different: the real item follows
the cursor and its neighbours slide out of the way. The goal is that same feel for the flat
DataView views, **within a section**.

Decided: **the row itself follows the cursor** (no floating chip), with `CSS.Translate`
only, the same as `SortableItem`.

Out of scope: the tree (its third "child" zone makes a row a child of another, which doesn't
fit sliding rows, so it keeps the indicator model), animated moves *between* sections,
and the keyboard sensor.

## Design

### 1. `rank-reorder` gets a sortable flat mode

`plugins/primitives/plugins/rank-reorder/web/internal/`

- **`RankReorderProvider`** (flat consumers only: list, icons, table) stops using
  `RankReorderDndContext` and mounts its own `DndContext`:
  - one `SortableContext` over **all** items in display order (groups in the order the
    caller lists them, rank-sorted within each group). Items in the same group sit next to
    each other, so only rows of the dragged row's group move.
  - `strategy`: new prop `layout: "vertical" | "grid"` → `verticalListSortingStrategy` /
    `rectSortingStrategy` (icons passes `"grid"`).
  - `collisionDetection`: `closestCenter`, limited to droppables of the active item's
    group unless `onReseat` is given. That replaces the `drag-scope` "disable the other groups'
    zones" trick (`drag-scope.ts` is still used by the tree through `useRankReorderItem`).
  - `PointerSensor` distance 4, `MeasuringStrategy.Always` when `measuringAlways`
    (windowed lists), **no `DragOverlay`**.
  - render-prop `activeId` is kept (for `keepMounted`).
- **Drop resolution** is pulled out into a pure `resolveSortableDrop(items, activeId, overId, geometry)`:
  - same group: `overIndex > activeIndex` → `{targetId: over, zone: "after"}`, else
    `"before"`. Then the existing `computeFlatReorder` / no-op guard / `onMove`.
  - other group (only possible when `onReseat` is given): zone from the dragged item's
    translated centre vs `over.rect` centre → `onReseat`. This keeps today's behaviour, without
    a nice animation (follow-up).
- **New hook `useRankSortableItem(id, rank, group)`** (replaces `useRankReorderItem`
  for flat consumers) wraps `useSortable({ id, data: { id, rank, group } })` and returns
  `{ ref, attributes, listeners, style, isDragging }` where
  `style = { transform: CSS.Translate.toString(transform), transition }`, plus
  `position: relative` and a raised z-index token while dragging. With a null rank the caller
  never attaches the ref (same contract as today).
- `useRankReorderItem` + `RankReorderDndContext` + `drag-scope` stay, for the tree only
  (update the doc comments and the plugin description to say so).
- `@dnd-kit/sortable` is already a root dependency, and `rank-reorder/web/**` is already on
  the `no-raw-dnd-kit` allowlist. `no-scaling-transform` holds by construction
  (`CSS.Translate`).

### 2. Consumers

Every consumer does the same thing: swap `useRankReorderItem` for `useRankSortableItem`,
spread `style` + `attributes` + `listeners` on the element that already carries the drag ref,
**delete the before/after `Pin` indicator markup** and `dragOverlay`, and drop `opacity-40`
on the dragged row (the row is now what moves).

- `data-view/plugins/list/web/components/list-view.tsx`: `ManualOrderRow` (the inner div,
  **not** the `VirtualRows` `Placed` wrapper, which owns its own translateY).
- `data-view/plugins/icons/web/components/icons-view.tsx`: `ManualOrderTile`, `layout="grid"`.
  Lane windowing: `keepMounted` already pins the active lane.
- `data-view/plugins/table/web/components/table-view.tsx`: `useRowDecoration` returns the
  sortable `style`. **`data-table/web/internal/types.ts`** `DataTableRowDecoration` gains
  `style?: CSSProperties`, applied by `DataTableRow` on the subgrid row div. A transform on a
  subgrid item doesn't disturb the column tracks, and windowed table rows use spacers, not
  transforms, so there's no clash.
- **Stacking under windowing:** each `VirtualRows` `Placed` wrapper has a transform, which
  starts its own stacking context, so a z-index on the inner row can't lift it above later
  wrappers. Add a `raisedKey?: string` prop to
  `virtual-rows/web/internal/virtual-rows.tsx` that puts the raised z-index class on that item's
  wrapper; list and icons pass `activeId` (the active lane key for icons).

### 3. No snap-back on drop: pending-move overlay in DataView

When a drop lands, dnd-kit clears the transforms right away. If the ranks haven't updated yet,
the row jumps back to its old slot, then jumps forward when the server push arrives. The Queue
already saves optimistically (`useOptimisticResource`), but `view-order`
(`useSetRowOrder` = plain `useEndpointMutation`) and `agents-list` do not. The fix goes in one
generic place instead of in each producer:

- New `web/internal/use-pending-move-overlay.ts` in `primitives/data-view`, applied where
  `data-view-body.tsx` builds the effective `ManualOrderConfig` (~line 439):
  - wraps `onMove`: records `{ id, rank: dest.rank, baseline: cfg.getRank(row) }`, then calls
    the real `onMove`.
  - wraps `getRank`: returns the pending `rank` for that id, so `orderSectionsByRank`
    (`web/internal/use-data-view-sections.ts:241`) renders the new order on the drop frame.
  - clears when the underlying `getRank` for that row stops equalling `baseline` (the
    server order or the producer's own optimistic order arrived), when the row disappears,
    or when the returned promise **rejects** (the error still surfaces through the producer's
    own path; the overlay never hides it).
  - Pure core (`applyPendingMove` / `shouldClear`) exported for tests.
- `view-order/web/components/row-order-contribution.tsx`: `onMove` returns the mutation
  promise so a rejection clears the overlay (check that `useEndpointMutation` exposes an async
  form; otherwise use `fetchEndpoint`).
- `dest.rank` is computed against the *rendered* rows. That's fine for **display** (the row
  lands between the rows the user saw); producers keep minting their own ranks.

## Files

- `plugins/primitives/plugins/rank-reorder/web/internal/`: `rank-reorder-provider.tsx`
  (rewritten around SortableContext), new `use-rank-sortable-item.ts`, new
  `resolve-sortable-drop.ts` (+ `.test.ts`), barrel `web/index.ts`, `CLAUDE.md`.
- `plugins/primitives/plugins/data-view/plugins/{list,icons,table}/web/components/*-view.tsx`
- `plugins/primitives/plugins/data-table/web/internal/{types.ts,data-table.tsx}`
- `plugins/primitives/plugins/virtual-rows/web/internal/virtual-rows.tsx` (`raisedKey`)
- `plugins/primitives/plugins/data-view/web/components/data-view-body.tsx` + new
  `web/internal/use-pending-move-overlay.ts` (+ test)
- `plugins/primitives/plugins/data-view/plugins/view-order/web/components/row-order-contribution.tsx`

## Verification

1. `./equin test plugins/primitives/plugins/rank-reorder plugins/primitives/plugins/data-view`:
   new pure tests for `resolveSortableDrop` (down→after, up→before, same slot → no-op,
   group-limited) and the pending-move clear rules (rank changed, row gone, rejected).
2. `./equin build` (runs the type-check, eslint including `no-scaling-transform` /
   `no-raw-dnd-kit`, and the docs-in-sync checks).
3. New e2e `plugins/primitives/plugins/data-view/plugins/list/e2e/sortable-reorder.ts`, with
   a raw pointer drag in the style of `task-draft-form/e2e/card-actions-verify.ts` (steps
   past the 4px activation) on the conversations sidebar Queue (needs ≥3 ranked rows;
   refuse loudly otherwise):
   - mid-drag: the dragged row's transform has scale 1 and moves with the pointer; a row in
     between has a non-zero translateY; no floating chip in the DOM.
   - after drop: sample row order on the next few animation frames. The moved row is
     at its new index on every frame (no snap-back), and it's still there after the push.
   - screenshots before / mid / after.
4. Manually on the deploy: list (sidebar Queue, plus one `view-order`-backed list with >100 rows
   for windowing + autoscroll), icons grid, table, grouped and ungrouped; the tree still shows
   its indicator lines.
