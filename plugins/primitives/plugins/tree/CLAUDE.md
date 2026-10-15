# tree

## Expand state is written in batches

`TreeModelArgs.setExpanded`, `TreeContextValue.setExpanded` and
`useFlatExpandAll`'s second argument all take a **batch** —
`readonly ExpandChange[]` (`{ id, expanded }`, from this plugin's `core` barrel) —
never a single `(id, next)` pair. Every gesture that changes N nodes issues
**one** call: the toolbar expand-all, a group header's fold, a row's subtree fold, and the reveal-on-select ancestor walk.
A single chevron click passes a 1-element array.

This is load-bearing, not tidiness. The write lands in the data-view primitive's
per-surface expand map, whose setter `JSON.stringify`s the whole map inside its
`setState` updater — so N single-row calls would be N serializations of a map
growing to N keys (quadratic on a tree with hundreds of folders).

The batch has exactly **one** sink: that synchronous, localStorage-backed
`setState`, batched into the same commit as the click and unable to fail. So
the tree model reads `rows[].expanded` straight through — there is no optimistic
overlay, because there is no async write to cover for.

## Expand-all: one index for the rows, one hook for the sets

There are exactly two implementations of "unfold everything", and every surface
uses one of them.

**Per row — an index, built once.** Every row with children renders a
fold/unfold button in its hover cluster (`TreeRowActions`, beside the
`⋯` and the `+`). It is tree chrome, like the chevron: gated only on
`hasChildren`, never opted into per app. The row reads its answer from
`RowControls.subtreeAllExpanded` / `.toggleSubtreeExpanded`, which the tree
model publishes from `useSubtreeExpandIndex(tree)` — ONE post-order walk of the whole
forest per render that answers for every node.

The shape is the point. The predecessor took `(rows, rootId)` and rebuilt a
parent map per call, so one call per row-with-children cost O(n) each — quadratic
across a render, paid on every expand/collapse of the tasks list, the agents list
and the Studio plugin tree. Three consumer plugins had each written their own
copy of it and contributed it as an app-level item action, which is also why the
surfaces that never wrote one — Pages' sidebar, the config nav, the file trees —
silently went without the feature. Both defects are gone at once: the index is
internal (not exported from the barrel), so a fourth copy has nothing to copy
from and nowhere to live.

Two rules the index keeps, and a reimplementation would not:

- **A leaf is vacuously all-expanded.** It has nothing below it to open, so it
  must not drag its parent's answer to false — a folder holding only files reads
  as fully unfolded.
- **The index is keyed on the full `tree`**, never on the searched or windowed
  projection. A windowed tree paints only the rows on screen and the search path
  hands out clones forced to `expanded: true`; either would make the button
  answer about the slice rather than about the subtree it claims to fold.

**Per set — `useFlatExpandAll(rows, setExpanded)`.** The whole-tree toolbar
button (`TreeToolbar`) and a group header's per-section toggle
(`groupFoldAction`) all hold a flat row array rather than a forest, so this one
takes rows and derives the expandable set from the parent links.
`hasExpandable` is what decides whether the button is rendered at all — a set
with no parents is hidden, not shown inert.

Both write only the rows whose value actually differs. The sink re-serializes
its whole expand map per call, so a padded batch is not free.

## `expandOnActivate` is consulted in `select`, not `onSelect`

`TreeModelArgs.expandOnActivate(row)` diverts a row's activation to an expand
toggle — the "click a folder to open it" affordance. It is **stateless**: it
routes the gesture, it does not hold the value (`rows[].expanded` and
`setExpanded` still do), so it cannot drift out of sync with the expand state
the way a consumer-held expand accessor could.

Its placement is load-bearing. The branch lives in `useTreeRow`'s `select` — the
one path a real body click takes — and **not** at the model's `onSelect` seam,
because `onSelect` is also called *programmatically*: by `createAtRoot`, by
`addChild` / `addBelow`, and by the reveal path. Diverting there would leave a
row the user just created, or one the tree just revealed, silently
un-navigated-to.

## Lazy children: the tree asks, the consumer lists

`TreeModelArgs.lazyChildren` (`LazyChildren<T>`, core) is for trees whose
children are fetched per node — a host directory, a remote listing:

- `hasChildren(row)` gives a row a chevron with nothing loaded under it.
  `RowControls.hasChildren` includes it; the per-row subtree fold stays gated on
  LOADED children (unfolding a subtree the tree has never seen is not a gesture
  it can keep).
- `state(row)` is a `TreeChildrenState` — `unloaded` / `loading` / `loaded` /
  `failed {message, retry}`. An open row with no children yet renders ONE
  placeholder child row from it (`TreeChildPlaceholder`): loading, the failure
  with Retry (children or not — a stale listing must not read as current), or
  "Empty" for a loaded row with none. The rule is `childPlaceholder`, applied by
  `flattenVisible`: the placeholder is a line of `flat` of its own, so every
  renderer paints the same rows. Under a search, an
  `unloaded` row shows nothing and "Empty" is suppressed.
- `load(row)` is called by `useLazyLoadRequests` for every OPEN, VISIBLE
  (`expanded` all the way up, on the UNSEARCHED forest) `unloaded` row, at most
  once per `unloaded` spell. Declarative on purpose: a chevron click,
  expand-all, reveal-on-select and an expand map restored on reload all lead to
  the same request — a change callback would miss the reload, where nothing
  changed. A consumer that wants to drop a listing (invalidation) moves it back
  to `unloaded` and is asked again.

## Open is a second gesture

`TreeModelArgs.onOpen(id)` — double-click, or Enter on the focused row — is
separate from the click (`onSelect` / `expandOnActivate`). With it, rows are
focusable, and the second click of a double-click (`event.detail > 1`) does not
select again, so a click-to-toggle folder is not toggled back by the gesture
that opens it. `RowControls.open` is `undefined` when the tree has no open.

`TreeModelArgs.openOnActivate(row)` makes a single click on a matching row the
open (a file browser's folder); `RowControls.clickOpens` carries it to the row.
Like `expandOnActivate` it routes only the body click — arrow keys still select,
Enter still opens. A double-click opens only the row its FIRST click landed on,
so the second click of a gesture that just opened a folder cannot open whatever
row the new listing put under the pointer.

## Reveal: a row must never land somewhere invisible

The tree model (`useTreeModel` + `useTreeRow`) owns three reveal behaviors, so no consumer has to (and so none is
tempted to persist an `expanded` flag server-side just to force a parent open):

- **Reveal-on-select** — when `selectedId` changes, every collapsed ancestor
  expands, in one batched call, guarded idempotent by a `lastRevealedId` ref,
  and the row scrolls into view. `revealSelected={false}` withholds both (the
  host knows the user picked the row somewhere they can already see it — a
  sibling list); the row still highlights.
- **Drag-reparent** — `onDragEnd` expands a collapsed destination parent in the
  same batch as the move. Without this the dragged row simply vanishes: a drag
  does not change `selectedId`, so reveal-on-select never fires.
- **Add-child** — `useTreeRow`'s `addChild` expands the parent node directly after
  a successful create. It cannot rely on reveal-on-select, because `onSelect` is a
  no-op until the newly created row arrives via live-state — a race, not a
  guarantee.

## Row actions come from `primitives/row-actions`

`TreeRowChrome` renders its `actions` through the shared `<RowActions>` cluster
and carries `rowActionsAnchor` on the row. It does **not** hand-roll a reveal:
the old one collapsed the cluster to `w-0` off-hover, which moved the anchor of
any menu open inside it. Consequences to keep in mind:

- The cluster is pinned, so it no longer pushes the label — a long label (and
  `options.trailing` chips) now **dissolves under the cluster's scrim** on hover
  instead of re-truncating.
- Every row tint must co-publish `--scrim` (hover, `selected`, the drop
  target's `isOverChild`), or that scrim paints the untinted background.

## Opt-in looks: indent guides, selected text

- **`TreeModelArgs.guides`** (default false) draws `TreeGuides` on every row and
  placeholder row: ONE decorative `Placed` box per row over its indent padding
  (after the row's `--tree-row-pad-start` lead, `depth × --tree-indent` wide), its background a repeating
  1px line centred in each indent step, in `--tree-guide` (color-palette,
  default `var(--border)`). It lives in the padding, so no label, icon or
  column moves.
- **A selected row's text** wears `text-selected-foreground` (color-palette
  `selectedForeground`, default `currentColor` = unchanged) and publishes
  `--row-meta: var(--selected-meta-foreground)` (default the muted tier) for its
  secondary cells, which read `text-row-meta` (= `--row-meta`, else muted). A
  theme that sets neither token sees no change.
- The placeholder row indents by the `--tree-indent` token like its siblings
  (it used to hard-code 16px, the token's default).
- **The row's geometry is density tokens**, read in one place
  (`web/internal/tree-indent.ts`): `treeRowPadStart` (the lead inset before the
  icon slot, default 4px), `treeRowGap` (between cells, default `xs`) and
  `treePillIndent` — how much of each level's indent moves the row's PILL (its
  hover / selected fill, as margin) rather than only its content (as padding).
  Default `0px`: full-width pills, the look every tree had. Pages sets it to
  the whole indent, so a nested row's fill starts under its parent's icon. The
  content lands at `depth × --tree-indent + --tree-row-pad-start` either way;
  the placeholder row and the guides follow the same split.

## Context access

`useTreeContext()` **throws** outside a `TreeProvider`. Use
`useOptionalTreeContext()` (returns `null`) from anything that may render
outside a tree — notably a `data-view` item-action, which every view renders
(list / table / gallery), not just a nested table. Such an action should
`return null` when the context is absent.

`useOptionalRowControls()` is the same rule one level down: the enclosing row's
`RowControls` (`addBelow`, `addChild`, `select`, `toggleSubtreeExpanded`,
drag/drop state), or `null` outside a tree row. It lets an affordance that needs
the node — "Add page below" — be an ordinary contributed item action instead of
a second menu (the table's `rowMenu` option) beside the action cluster.

The renderer provides it around each row only (`RowControlsProvider`). `useTreeRow`'s
return is `useMemo`'d because it is now a context value.

## The model and its renderer

The plugin owns the model, not the drawing. data-view's nested table
(`data-view/plugins/table`, `NestedTableView`) runs `useTreeModel` and
paints `flat` as `DataTable` rows: `TreeLeading` in the first cell (under
`treeRowIndentStyle`, so the guides land where they land in a `TreeRowChrome`),
`useTreeRow` + `treeRowGestures` + `TreeDropZones` through the table's per-row
decoration hook, `TreeChildPlaceholder` as a full-span line, `useTreeKeyboard`
on the grid. It publishes the model's context through `TreeProvider`, and each row's `RowControls` through `RowControlsProvider` (the table decoration's
`provide`), so `useOptionalRowControls()` answers inside a table row too.

The chrome around a row is shared, not re-drawn per renderer:

- **`treeRowTrailing` / `TreeRowActions`** — the row's hover cluster (the
  consumer's actions, subtree fold, `⋯` menu, add child). A table row renders the component,
  which reads the published controls (`useRowControls`, throwing outside a row).
- **`TreeToolbar`** (start content + expand-all) and **`TreeRootAdd`** (the
  root "Add") — the nested table's toolbar.
- **`groupFoldAction(rows, setExpanded)`** — a group header's fold toggle
  (`null` when the group has nothing to fold, so no empty cluster).

`RowMenuItem` / `RowMenuHelpers` are `core` types, so a view's options type
(the table's, in its `core`) can name a row menu.

## Rows are flat; toggles fold through row-fold

The renderer paints `flat` — the nested table's `DataTable` rows — so nothing
recurses and a node's
children are sibling lines, not a nested box. A toggle folds through
`virtual-rows/row-fold`: the model publishes `openKeys` (the expanded ids over
every row — unsearched, unscoped), the renderer hands it to `useRowFold`
(`DataTable`), and a flip there is what makes a
change of `flat` a fold. A search, a scope change or live data never flips
it. Not `FoldMotion`: its height tween relays out every row below it on
every frame — on a big tree (the tasks list) each frame of the tween paid
that layout — while row-fold moves rows with transform / clip / opacity.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Tree hierarchy utilities (buildTree, isDescendant, resolveDropParent), the tree model (useTreeModel: flattened visible lines, DnD, lazy children, keyboard) and the tree-row pieces a renderer composes (TreeRowChrome, TreeLeading, useTreeRow, TreeRowActions, TreeToolbar) — drawn by data-view's nested table.
- Web:
  - Slots: `Tree.Disclosure`
  - Slot contributors: `Tree.Disclosure` ← `ui.tree-disclosure`
  - Uses: 26 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×6
    - `primitives/collapsible` ×2
    - `primitives/row-actions` ×2
    - `primitives/css/center.Center`
    - `primitives/css/coords.Placed`
    - `primitives/css/fill.Fill`
    - `primitives/css/layer.layerClasses`
    - `primitives/css/pin.Pin`
    - `primitives/css/spacing.Stack`
    - `primitives/css/sticky.Sticky`
    - `primitives/css/text.Text`
    - `primitives/dom/scroll-reveal.useRevealOnActive`
    - `primitives/icon-button.IconButton`
    - `primitives/link-gesture.linkProps`
    - `primitives/loading.Loading`
    - `primitives/rank-reorder.useRankReorderItem`
    - `primitives/search.filterTree`
    - `primitives/slot-render.renderIsolated`
    - `ui/icons.Icon`
  - Exports (types):
    - `FlatExpandAll`
    - `RowControls`
    - `RowMenu`
    - `TreeContextValue`
    - `TreeDisclosureContribution`
    - `TreeDisclosureToggleProps`
    - `TreeDropZonesProps`
    - `TreeItem`
    - `TreeLeadingProps`
    - `TreeModel`
    - `TreeModelArgs`
    - `TreeModelContext`
    - `TreeRowActionsProps`
    - `TreeRowChromeProps`
    - `TreeToolbarProps`
    - `UseFlatExpandAllReturn`
  - Exports (values):
    - `groupFoldAction`
    - `RowControlsProvider`
    - `Tree`
    - `TreeChildPlaceholder`
    - `TreeDisclosureToggle`
    - `TreeDropZones`
    - `TreeLeading`
    - `TreeProvider`
    - `TreeRootAdd`
    - `TreeRowActions`
    - `TreeRowChrome`
    - `treeRowGestures`
    - `treeRowIndentStyle`
    - `treeRowTrailing`
    - `TreeToolbar`
    - `useFlatExpandAll`
    - `useOptionalRowControls`
    - `useOptionalTreeContext`
    - `useRowControls`
    - `useTreeContext`
    - `useTreeKeyboard`
    - `useTreeModel`
    - `useTreeRow`
- Core:
  - Uses:
    - `primitives/rank.computeFlatReorder`
    - `primitives/rank.Rank`
  - Exports (types):
    - `ChildPlaceholder`
    - `DropZone`
    - `ExpandChange`
    - `FlatTreeLine`
    - `KeyboardLine`
    - `LazyChildren`
    - `RowMenuHelpers`
    - `RowMenuItem`
    - `TreeChildrenState`
    - `TreeDisclosureProps`
    - `TreeKeyMove`
    - `TreeNode`
  - Exports (values):
    - `buildTree`
    - `childPlaceholder`
    - `computeDrop`
    - `flatNodeIds`
    - `flattenVisible`
    - `isDescendant`
    - `resolveDropParent`
    - `selectionRoots`
    - `subtreeIds`
    - `treeKeyMove`
- Cross-plugin:
  - Imported by:
    - `apps/pages/page-tree`
    - `page/editor`
    - `primitives/data-view`
    - `primitives/data-view/list`
    - `primitives/data-view/table`
    - `ui/tree-disclosure`
    - `ui/tree-disclosure/column`
    - `ui/tree-disclosure/dimmed-leaf`
    - `ui/tree-disclosure/merged`
- Exemptions:
  - Exempts itself from:
    - `data-view/no-adhoc-row-list` — `.` (sanctioned)
    - `sortable-list/no-raw-dnd-kit` — `web` (sanctioned)

<!-- AUTOGENERATED:END -->
