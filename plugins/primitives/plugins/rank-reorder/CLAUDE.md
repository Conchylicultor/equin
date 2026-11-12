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
  onMove, onReseat?, reseatInto?, slideAcrossGroups?, onReseatNew?, groups?,
  measuringAlways? }`. Mounts one `DndContext` (`PointerSensor`
  4px activation, `closestCenter`, no `DragOverlay`) and one `SortableContext`
  over **every** item in display order: groups in the order `items` first lists
  them, rank-sorted within each. `layout` picks the slide: `"vertical"` (default,
  `verticalListSortingStrategy`) or `"grid"` (`rectSortingStrategy`). A drop
  resolves through `resolveSortableDrop` — moving down lands `after` the row it
  is over, moving up `before` — to a `Rank` via `rank`'s `computeFlatReorder`
  within the group; `onMove(id, { rank, group, targetId, zone })` fires only for
  real (non-no-op) moves. Its `children` may be a render-prop receiving the
  active drag id and the cross-group `preview` (`RankDragPreview | null`).
- **`useRankSortableItem(id, rank, group?)`** — per-row `useSortable`. Returns
  `{ ref, listeners, style, isDragging }`; put `ref`, `listeners` and `style`
  on the ONE element that is the row. dnd-kit's `attributes` are deliberately
  not returned: they make the element a focusable `role="button"` sortable,
  promising a keyboard drag the pointer-only provider does not have, and steal
  the row's own tab stop. `style` is `CSS.Translate` + the sortable
  `transition`, plus `position: relative` and the `drag` z-layer while
  dragging (z-layers CLAUDE.md, "`z-drag`"). A `null` rank disables the item (callers that must call the hook
  unconditionally never attach the ref). Data: `{ kind: "row", id, rank,
  group }`.
- **`useRankGroupDropTarget(group, { enabled?, preview? })`** — a group's
  "into this group" target (its header, the band an empty group draws): `{
  ref, isOver, armed }`. Live only under a provider with `onReseat` and while
  `enabled` (default true); a drop on it is `onReseat(id, { group })`, no
  anchor. A group may mount several (header and band): each gets its own
  dnd-kit id. **A group that draws rows is entered through them**: the host
  disables its header (`enabled: false`) while it shows rows, or the header
  would compete with the first row and throw a row dragged across it to the
  group's head. `preview` (under `slideAcrossGroups`) says the group DRAWS a
  row dragged onto the target (an empty group's band — it is laid out there);
  without it (a collapsed group's header) the row stays laid out where it was
  and only the target lights.
- **`useRankNewGroupTarget()`** — the "into a new group" target: `{ ref,
  isOver }`; a drop calls `onReseatNew(id)`. Mount it only while
  `useRankDragState()` says a row drags under a provider with `onReseatNew`.
  Its band is no auto-scroll zone (below).
- **`useRankSortableGroup(key, sortable)`** — a whole group as a sortable block
  (`groups`): `{ ref, bodyRef, listeners, style, isDragging }`. `ref` +
  `listeners` on the header, `bodyRef` on the body (a SIBLING — a wrapper box
  would re-bound a sticky header), `style` on both. The provider measures the
  block as the header's box united with the body's, so the other blocks slide
  by the block's height. `sortable: false` mounts a disabled node.
- **`useRankDragState()`** — `{ activeKind: "row" | "group" | null,
  canReseat, canReseatNew }` of the nearest provider (nothing outside one).
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
  anchor-only (`RankReseatDest`: `{ group, targetId?, zone? }`, no rank —
  minting a rank in a group whose membership the host is about to rewrite is
  not the primitive's call). No anchor = dropped on the group itself (a
  `useRankGroupDropTarget`): the host keeps the row's rank.
- **`reseatInto(group)`** (with `onReseat`) — which groups take a row from
  another (default: all). A refused group's rows and its
  `useRankGroupDropTarget`s (disabled) leave a row drag's collision; its own
  rows still reorder among themselves.
- **`slideAcrossGroups`** (with `onReseat`) — the multi-container pattern. On
  drag-over into another group the provider sets a **preview** `{ id, group,
  targetId?, zone? }` (`nextPreview`: beside the row it is over, on the side of
  the dragged box's centre; at the group's head over a header / empty band;
  back home over its own group or the new-group target), re-orders its
  sortable context with the row in that group (`previewOrder`) and hands the
  preview to the render-prop. The host lays the row out there, so the target
  group's rows slide around it with the normal strategy. The drop reads the
  anchor back from the previewed order plus the slide (`previewDropDest`).
  Without it (icons, table) nothing slides over another group and the side is
  read from geometry at drop time.

Collision is by kind (`data.kind`): a row drag looks first at the new-group
target, then at group drop targets (`pointerWithin` — they sit over or beside
rows), then at the rows (`closestCenter`); a group drag only at the sortable
groups.

**The dragged row follows the pointer over every target.** Without a
`DragOverlay`, dnd-kit's `useSortable` displaces the drag source only while
`over` is an item of its `SortableContext`; over a plain droppable it drops the
transform and the row jumps back to its layout slot. So every target laid over
the rows registers itself in the provider (`RankDragState.addTarget`, from the
two target hooks) and is listed in the sortable items after the rows and group
blocks — the strategy slides nothing over a target, but the row keeps
following. When the preview moves the row's DOM node into another group,
dnd-kit re-measures it and subtracts the layout delta from its transform
(`useRectDelta`), so the row stays under the pointer there too.

**Auto-scroll around the new-group target** (`new-group-auto-scroll.ts`). The
card floats over the scroller's bottom edge — dnd-kit's auto-scroll band (a
fifth of the scroller, stated as `threshold`) — so heading for it used to
scroll the list hundreds of px away. While it is mounted: its band (from its
top down) never scrolls; the rest of the bottom band scrolls only once the
pointer has rested there 300 ms (hover intent: each step down toward the
card restarts the rest, so heading for it — however slowly — never scrolls;
resting, or easing back up, does); the top band is dnd-kit's. The pointer is the window's own
`pointermove` (capture — current before dnd-kit reacts; `onDragMove` lags a
render and folds scroll into its delta); the one linger timer hands dnd-kit a
new `canScroll` (a dependency of its scroll effect) so a resting pointer starts
scrolling without moving.

## Sortable groups (`groups`)

`groups: { keys, onMove }` adds every group's block to the SAME
`SortableContext`, after the rows, so a header drag shares the sensor (4px
activation — a click on the header still reaches it) and the measuring. Never
a second, nested context: `useSortable` reads the nearest one, so the rows
under it would find themselves in no list and nothing would follow the
pointer or slide (jsdom cannot see transforms; the real browser did). The
strategy keeps the kinds apart — each slides only among its own kind, over its
own slice of the rects. Only listed keys move and take a drop (`resolveGroupDrop`: after
the block below, before the block above); an unlisted group stays put.

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
  cannot lift it over later wrappers, so the wrapper itself is lifted (to the
  `drag` layer).

**The dragged item paints over everything it crosses, for the whole drag.**
Both `style`s (a row's, a dragged group block's) put it on the `drag` z-layer
— above sticky headers (`raised`), the toolbar (`nav`) and in-pane floats
(`float`, the new-group card). A z-index orders only inside its stacking
context, so every box that seals the dragged item's stacking (an `isolate`d
section body, a transformed windowed wrapper) must lift ITSELF to `drag` while
it holds the item — the consumer's job, since only it draws those boxes
(`raisedKey`; data-view's `GroupedSections draggedSection`). Missing one, the
row slides under a pinned header it is dragged beneath.

Only rows in the DOM are drop targets, which is exactly right: you can only drop
where you can see. `tree` (`tree-list.tsx`), `data-view/list`, `data-view/icons`
and `data-view/table` all compose these this way (the table's windowed body uses
spacers, not transforms, so its rows need no `raisedKey`).

## Boundaries

Depends only on `rank` (core) + `@dnd-kit` (+ `css/text` for the tree's chip).
It must NOT import `tree` or `data-view` — the dependency graph stays a DAG
(both of those depend on `rank-reorder`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Rank-based drag-reorder primitive. Flat lists and grids: a sortable RankReorderProvider (one SortableContext, the dragged row follows the pointer and its group's rows slide, drops resolved to a Rank via computeFlatReorder, group-by aware; with onReseat + slideAcrossGroups a row dragged into another group is previewed there so its rows slide, group headers / empty bands take anchorless drops, an optional new-group target, and sortable whole-group blocks) and useRankSortableItem per row. The tree: RankReorderDndContext + useRankReorderItem (indicator-line before/after droppables and a drag chip). Depends only on rank + dnd-kit.
- Web:
  - Uses:
    - `primitives/css/text.Text`
    - `primitives/sortable-list.useChromePointerSensor`
  - Exports (types):
    - `RankDragPreview`
    - `RankReorderDndContextProps`
    - `RankReorderItem`
    - `RankReorderItemControls`
    - `RankReorderProviderProps`
    - `RankReseatDest`
    - `RankSortableGroupControls`
    - `RankSortableGroups`
    - `RankSortableItemControls`
  - Exports (values):
    - `RankReorderDndContext`
    - `RankReorderProvider`
    - `useRankDragState`
    - `useRankGroupDropTarget`
    - `useRankNewGroupTarget`
    - `useRankReorderItem`
    - `useRankSortableGroup`
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
    - `primitives/data-view`
    - `primitives/data-view/icons`
    - `primitives/data-view/list`
    - `primitives/data-view/table`
    - `primitives/tree`
    - `tag-tree/picker`
- Exemptions:
  - Exempts itself from: `sortable-list/no-raw-dnd-kit` — `web` (sanctioned)

<!-- AUTOGENERATED:END -->
