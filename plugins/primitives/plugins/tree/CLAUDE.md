# tree

## Expand state is written in batches

`TreeListProps.setExpanded`, `TreeListContextValue.setExpanded` and
`useFlatExpandAll`'s second argument all take a **batch** —
`readonly ExpandChange[]` (`{ id, expanded }`, from this plugin's `core` barrel) —
never a single `(id, next)` pair. Every gesture that changes N nodes issues
**one** call: the toolbar expand-all, the grouped-path expand-all in
`data-view/tree`, a row's subtree fold, and the reveal-on-select ancestor walk.
A single chevron click passes a 1-element array.

This is load-bearing, not tidiness. The write lands in the data-view primitive's
per-surface expand map, whose setter `JSON.stringify`s the whole map inside its
`setState` updater — so N single-row calls would be N serializations of a map
growing to N keys (quadratic on a tree with hundreds of folders).

The batch has exactly **one** sink: that synchronous, localStorage-backed
`setState`, batched into the same commit as the click and unable to fail. So
`TreeList` reads `rows[].expanded` straight through — there is no optimistic
overlay, because there is no async write to cover for.

## Expand-all: one index for the rows, one hook for the sets

There are exactly two implementations of "unfold everything", and every surface
uses one of them.

**Per row — an index, built once.** Every row with children renders a
fold/unfold button in its hover cluster (`RowChrome`'s `trailing`, beside the
`⋯` and the `+`). It is tree chrome, like the chevron: gated only on
`hasChildren`, never opted into per app. The row reads its answer from
`RowControls.subtreeAllExpanded` / `.toggleSubtreeExpanded`, which `TreeList`
publishes from `useSubtreeExpandIndex(tree)` — ONE post-order walk of the whole
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
button, the grouped tree view's hoisted toolbar, and a group header's
per-section toggle all hold a flat row array rather than a forest, so this one
takes rows and derives the expandable set from the parent links.
`hasExpandable` is what decides whether the button is rendered at all — a set
with no parents is hidden, not shown inert.

Both write only the rows whose value actually differs. The sink re-serializes
its whole expand map per call, so a padded batch is not free.

## `expandOnActivate` is consulted in `select`, not `onSelect`

`TreeListProps.expandOnActivate(row)` diverts a row's activation to an expand
toggle — the "click a folder to open it" affordance. It is **stateless**: it
routes the gesture, it does not hold the value (`rows[].expanded` and
`setExpanded` still do), so it cannot drift out of sync with the expand state
the way a consumer-held expand accessor could.

Its placement is load-bearing. The branch lives in `useTreeRow`'s `select` — the
one path a real body click takes — and **not** at the `TreeList.onSelect` seam,
because `onSelect` is also called *programmatically*: by `createAtRoot`, by
`addChild` / `addBelow`, and by the reveal path. Diverting there would leave a
row the user just created, or one the tree just revealed, silently
un-navigated-to.

## Lazy children: the tree asks, the consumer lists

`TreeListProps.lazyChildren` (`LazyChildren<T>`, core) is for trees whose
children are fetched per node — a host directory, a remote listing:

- `hasChildren(row)` gives a row a chevron with nothing loaded under it.
  `RowControls.hasChildren` includes it; the per-row subtree fold stays gated on
  LOADED children (unfolding a subtree the tree has never seen is not a gesture
  it can keep).
- `state(row)` is a `TreeChildrenState` — `unloaded` / `loading` / `loaded` /
  `failed {message, retry}`. An open row with no children yet renders ONE
  placeholder child row from it (`TreeChildPlaceholder`): loading, the failure
  with Retry (children or not — a stale listing must not read as current), or
  "Empty" for a loaded row with none. The rule is `childPlaceholder`, shared by
  `RowChrome`'s recursion and the windowed flat list (where the placeholder is
  an item of its own), so both paint the same rows. Under a search, an
  `unloaded` row shows nothing and "Empty" is suppressed.
- `load(row)` is called by `useLazyLoadRequests` for every OPEN, VISIBLE
  (`expanded` all the way up, on the UNSEARCHED forest) `unloaded` row, at most
  once per `unloaded` spell. Declarative on purpose: a chevron click,
  expand-all, reveal-on-select and an expand map restored on reload all lead to
  the same request — a change callback would miss the reload, where nothing
  changed. A consumer that wants to drop a listing (invalidation) moves it back
  to `unloaded` and is asked again.

A custom `Row` that does not render through `RowChrome` gets no placeholder in
the non-windowed render; it reads `useTreeListContext().childPlaceholder(node)`.

## Open is a second gesture

`TreeListProps.onOpen(id)` — double-click, or Enter on the focused row — is
separate from the click (`onSelect` / `expandOnActivate`). With it, rows are
focusable, and the second click of a double-click (`event.detail > 1`) does not
select again, so a click-to-toggle folder is not toggled back by the gesture
that opens it. `RowControls.open` is `undefined` when the tree has no open.

`TreeListProps.openOnActivate(row)` makes a single click on a matching row the
open (a file browser's folder); `RowControls.clickOpens` carries it to the row.
Like `expandOnActivate` it routes only the body click — arrow keys still select,
Enter still opens. A double-click opens only the row its FIRST click landed on,
so the second click of a gesture that just opened a folder cannot open whatever
row the new listing put under the pointer.

## Reveal: a row must never land somewhere invisible

`TreeList` owns three reveal behaviors, so no consumer has to (and so none is
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
- Every row tint must co-publish `--scrim` (hover, `selected`, `RowChrome`'s
  `isOverChild`), or that scrim paints the untinted background.

## Opt-in looks: indent guides, selected text

- **`TreeListProps.guides`** (default false) draws `TreeGuides` on every row and
  placeholder row: ONE decorative `Placed` box per row over its indent padding
  (after the row's `--tree-row-pad-start` lead, `depth × --tree-indent` wide), its background a repeating
  1px line centred in each indent step, in `--tree-guide` (color-palette,
  default `var(--border)`). It lives in the padding, so no label, icon or
  aligned column moves.
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

`useTreeListContext()` **throws** outside a `TreeList`. Use
`useOptionalTreeListContext()` (returns `null`) from anything that may render
outside a tree — notably a `data-view` item-action, which every view renders
(list / table / gallery / tree), not just the tree. Such an action should
`return null` when the context is absent.

`useOptionalRowControls()` is the same rule one level down: the enclosing row's
`RowControls` (`addBelow`, `addChild`, `select`, `toggleSubtreeExpanded`,
drag/drop state), or `null` outside a tree row. It lets an affordance that needs
the node — "Add page below" — be an ordinary contributed item action instead of
a second menu (`TreeViewOptions.rowMenu`) beside the action cluster.

`RowChrome` provides it around that row's own chrome only, **not** around the
child recursion, so a descendant can't read its parent's controls. `useTreeRow`'s
return is `useMemo`'d because it is now a context value.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Tree hierarchy utilities (buildTree, isDescendant, resolveDropParent) and a generic TreeList with composable row primitives (RowChrome, RenameInput, useTreeRow) for list plugins.
- Web:
  - Slots: `Tree.Disclosure`
  - Slot contributors: `Tree.Disclosure` ← `ui.tree-disclosure`
  - Uses: 33 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×6
    - `primitives/multi-select` ×3
    - `primitives/collapsible` ×2
    - `primitives/rank-reorder` ×2
    - `primitives/row-actions` ×2
    - `primitives/search` ×2
    - `primitives/css/center.Center`
    - `primitives/css/coords.Placed`
    - `primitives/css/fill.Fill`
    - `primitives/css/layer.layerClasses`
    - `primitives/css/pin.Pin`
    - `primitives/css/spacing.Stack`
    - `primitives/css/sticky.Sticky`
    - `primitives/css/text.Text`
    - `primitives/dom/auto-scroll.KeepScrollAcross`
    - `primitives/dom/scroll-reveal.useRevealOnActive`
    - `primitives/icon-button.IconButton`
    - `primitives/link-gesture.linkProps`
    - `primitives/loading.Loading`
    - `primitives/slot-render.renderIsolated`
    - `primitives/virtual-rows.VirtualRows`
    - `ui/icons.Icon`
  - Exports (types):
    - `FlatExpandAll`
    - `RenameInputProps`
    - `RowChromeMenuHelpers`
    - `RowChromeProps`
    - `RowControls`
    - `RowMenuItem`
    - `TreeDisclosureContribution`
    - `TreeDisclosureToggleProps`
    - `TreeDropZonesProps`
    - `TreeItem`
    - `TreeLeadingProps`
    - `TreeListContextValue`
    - `TreeListProps`
    - `TreeModel`
    - `TreeModelArgs`
    - `TreeModelContext`
    - `TreeRowChromeProps`
    - `UseFlatExpandAllReturn`
  - Exports (values):
    - `flatExpandAll`
    - `RenameInput`
    - `RowChrome`
    - `Tree`
    - `TreeChildPlaceholder`
    - `TreeDisclosureToggle`
    - `TreeDropZones`
    - `TreeLeading`
    - `TreeList`
    - `TreeListProvider`
    - `TreeRowChrome`
    - `treeRowGestures`
    - `treeRowIndentStyle`
    - `useFlatExpandAll`
    - `useOptionalRowControls`
    - `useOptionalTreeListContext`
    - `useTreeKeyboard`
    - `useTreeListContext`
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
    - `primitives/data-view/list`
    - `primitives/data-view/tree`
    - `ui/tree-disclosure`
    - `ui/tree-disclosure/column`
    - `ui/tree-disclosure/dimmed-leaf`
    - `ui/tree-disclosure/merged`
- Exemptions:
  - Exempts itself from:
    - `data-view/no-adhoc-row-list` — `.` (sanctioned)
    - `sortable-list/no-raw-dnd-kit` — `web` (sanctioned)

<!-- AUTOGENERATED:END -->
