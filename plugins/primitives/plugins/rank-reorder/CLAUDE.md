# rank-reorder

Rank-based drag-reorder. The lifted, shared home for the `@dnd-kit` wiring +
rank arithmetic that the `data-view` manual-order (list / icons / table) and the
`tree` primitive's sibling (before/after) zones both build on. Two gestures, one
rank model:

- **Flat views slide** (`RankReorderProvider` + `useRankSortableItem`): the
  dragged row itself follows the pointer and the other rows of its group slide
  out of its way, like `sortable-list`.
- **The tree marks** (`RankReorderDndContext` + `useRankReorderItem`): rows stay
  put, a line marks the drop point and a chip follows the pointer. Its third
  `child` zone (make a row a child of another) does not fit sliding rows.

## What it owns

- **`RankReorderProvider`** — the sortable flat host. Props `{ items, layout?,
  onMove, onReseat?, measuringAlways? }`. Mounts one `DndContext` (`PointerSensor`
  4px activation, `closestCenter`, no `DragOverlay`) and one `SortableContext`
  over **every** item in display order: groups in the order `items` first lists
  them, rank-sorted within each. `layout` picks the slide: `"vertical"` (default,
  `verticalListSortingStrategy`) or `"grid"` (`rectSortingStrategy`). A drop
  resolves through `resolveSortableDrop` — moving down lands `after` the row it
  is over, moving up `before` — to a `Rank` via `rank`'s `computeFlatReorder`
  within the group; `onMove(id, { rank, group, targetId, zone })` fires only for
  real (non-no-op) moves. Its `children` may be a render-prop receiving the
  active drag id.
- **`useRankSortableItem(id, rank, group?)`** — per-row `useSortable`. Returns
  `{ ref, listeners, style, isDragging }`; put `ref`, `listeners` and `style`
  on the ONE element that is the row. dnd-kit's `attributes` are deliberately
  not returned: they make the element a focusable `role="button"` sortable,
  promising a keyboard drag the pointer-only provider does not have, and steal
  the row's own tab stop. `style` is `CSS.Translate` + the sortable
  `transition`, plus `position: relative` and the `raised` z-layer while
  dragging. A `null` rank disables the item (callers that must call the hook
  unconditionally never attach the ref). Data: `{ id, rank, group }`.
- **`RankReorderDndContext`** — the tree's indicator-line shell: `DndContext`,
  `PointerSensor`, `pointerWithin` collision, the active-id lifecycle,
  `MeasuringStrategy.Always` for windowed lists, and the `DragOverlay` chip. Drop
  resolution is injected via `onDragEnd`.
- **`useRankReorderItem(id, rank)`** — the tree's per-row draggable +
  before/after droppables. Returns `{ dragSource, isDragging, beforeRef,
  afterRef, isOverBefore, isOverAfter }`. Draggable data `{ id, rank }`,
  droppable data `{ zone: "before" | "after", targetId }` (the tree adds its own
  `zone: "child"` droppable alongside these, and keeps its `isDescendant` cycle
  guard tree-local while delegating sibling rank math to `computeFlatReorder`).

## Composition with group-by

`items` carry an optional `group` key, and each row passes its own group to
`useRankSortableItem(id, rank, group)`. Because the sortable order keeps a
group's items contiguous, only the dragged row's group slides.

A drop into **another** group is a separate capability, expressed by **handler
presence**, not a flag:

- **`onReseat` absent** → collision detection only considers the dragged row's
  own group, so the drag can neither slide nor land anywhere else. The refusal
  is visible mid-drag — do *not* re-implement it as an `onDragEnd` early-return,
  which reads to the user as a drag that silently did nothing.
- **`onReseat` supplied** → cross-group drops are allowed and reported
  anchor-only (`{ group, targetId, zone }`, no rank — minting a rank in a group
  whose membership the host is about to rewrite is not the primitive's call).
  The side is read from geometry (the dragged box's centre against the target's)
  and nothing slides while the pointer is over another group; an animated
  cross-group move is future work.

The tree mounts `RankReorderDndContext` once per section, so cross-section drags
are unrepresentable there.

## Windowing while dragging

Every consumer windows **and** drags — an unbounded list stays reorderable.
Three knobs compose to make it work, and a windowed consumer must pass them all:

- **`measuringAlways`** → `MeasuringStrategy.Always`, so a row that mounts
  mid-drag (dnd-kit's autoscroll bringing an off-screen target into view) is
  measured and becomes a valid drop target.
- **the render-prop `activeId`** → the consumer forwards it as its virtualizer's
  `keepMounted` (`virtual-rows`), pinning the drag source in the DOM. Without
  it, scrolling the source out of the window unmounts its sortable and dnd-kit
  cancels the drop.
- **`raisedKey`** (sortable only) → the same id (or, for the icons grid, the
  active lane's key) as `VirtualRows`' `raisedKey`. Each windowed wrapper is
  transformed, so it is its own stacking context: a z-index on the row inside
  cannot lift it over later wrappers, so the wrapper itself is raised.

Only rows in the DOM are drop targets, which is exactly right: you can only drop
where you can see. `tree` (`tree-list.tsx`), `data-view/list`, `data-view/icons`
and `data-view/table` all compose these this way (the table's windowed body uses
spacers, not transforms, so its rows need no `raisedKey`).

## Boundaries

Depends only on `rank` (core) + `@dnd-kit` (+ `css/text` for the tree's chip).
It must NOT import `tree` or `data-view` — the dependency graph stays a DAG
(both of those depend on `rank-reorder`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Rank-based drag-reorder primitive. Flat lists and grids: a sortable RankReorderProvider (one SortableContext, the dragged row follows the pointer and its group's rows slide, drops resolved to a Rank via computeFlatReorder, group-by aware) and useRankSortableItem per row. The tree: RankReorderDndContext + useRankReorderItem (indicator-line before/after droppables and a drag chip). Depends only on rank + dnd-kit.
- Web:
  - Uses: `primitives/css/text.Text`
  - Exports (types):
    - `RankReorderDndContextProps`
    - `RankReorderItem`
    - `RankReorderItemControls`
    - `RankReorderProviderProps`
    - `RankSortableItemControls`
  - Exports (values):
    - `RankReorderDndContext`
    - `RankReorderProvider`
    - `useRankReorderItem`
    - `useRankSortableItem`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --accent`
    - `ui/tokens/color-palette --background`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shape --radius`
  - Imported by:
    - `primitives/data-view/icons`
    - `primitives/data-view/list`
    - `primitives/data-view/table`
    - `primitives/tree`
- Exemptions:
  - Exempts itself from: `sortable-list/no-raw-dnd-kit` — `web` (sanctioned)

<!-- AUTOGENERATED:END -->
