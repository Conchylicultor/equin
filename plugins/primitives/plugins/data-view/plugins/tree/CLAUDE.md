# tree

The **tree** view child of the `data-view` primitive. Contributes one
`DataViewSlots.View("tree")` entry (`hierarchical: true`, `supportsSort: true`):
a nested, draggable, inline-renameable tree rendered through the shared
`FieldDef` schema. It **defaults to manual (rank) order** — the DnD-reorderable
order the tree ships — and honors `ViewState.sort` when a field sort is picked
(see "Sort" below). It also honors **filter**, subtree-preserving, and
**group-by** (see "Group-by" below), and a root-scoped filter
(`filterScope: "roots"`, see "Filter").

## What it is

A thin **adapter**, not a reimplementation. It runs data-view's shared
hierarchy pipeline (`useHierarchyTree` — the same one the table runs when its
source is hierarchical; see data-view's CLAUDE.md, "Hierarchy") and renders the
result through the `tree` primitive's `TreeList`, reusing `buildTree`,
subtree-preserving `filterTree` search, the anchor-only DnD
`resolveDropParent`, and the `RowChrome` / `RenameInput` row primitives. The
`tree` primitive stays the lower-level building block.

The projection, filter, sort, group-by and alias semantics below are the
pipeline's, so they hold for the nested table too; what is this view's own is
the row (`DefaultRow` over `RowChrome`: the label, the chips or aligned
columns, `options.trailing` / `rowAccent` / `rowMenu`), the hoisted toolbar and
one `TreeList` per group section.

## How it works

- **Projection** — each raw `TRow` becomes a `TreeItem`-shaped row
  (`{ id, parentId, rank, expanded, alias, __row }`) via the `HierarchyConfig`
  accessors. A map back to the original row lets `TreeList` callbacks recover the
  concrete `TRow`. It lives in data-view's `web/internal/hierarchy/project-rows.ts` as a **pure**
  function (the view just memoizes it), so its rank arithmetic — notably the
  alias minting below — is directly testable without mounting the view.
- **Row label** — the primary field (`FieldDef.primary` → first `text` → first,
  run via `pickPrimaryField` over the view's **visible** field subset) rendered on
  the same read precedence the shared `FieldCell` documents and every other view
  applies: consumer **`field.cell` override → contributed `data-view.cell` slot →
  `String(value)`**. So a field-type plugin's cell renders identically as a table
  column and a tree row, *and* a consumer whose rows are a heterogeneous union can
  render one kind's label as a whole component (e.g. a conversation row) via
  `field.cell`. When the primary field declares `onEdit`/`onEditValues` the label
  becomes an `EditableTreeLabel` (select-then-edit over the shared
  `useResolveCellEditor` capability, the same per-type editors the table uses)
  wrapping that same read node; otherwise it stays a read-only cell.
- **Secondary fields** — the body is no longer label-only. The row renders the
  primary field as the label **plus** the remaining visible fields (the view's
  `visibleFields` minus the primary; **default = all non-primary fields**) as
  trailing chips, each rendered through the shared `FieldCell` (the same per-type
  cell resolution the label and every other view use), sitting before any
  `options.trailing`. The chips are **no longer read-only**: a secondary field
  declaring `onEdit`/`onEditValues` (e.g. a custom column) is **click-to-edit**
  in place via `FieldCell` → `EditableCell` — the same per-type inline editors as
  the table/list, and `EditableCell`'s `stopPropagation` keeps a chip click from
  triggering row selection/navigation. Fields without a write-back stay
  read-only. Author a narrow `visibleFields` (e.g. `["label"]`) to keep the tree
  body to just the label and leave the other fields filter-only — see the
  data-view CLAUDE.md "Per-view visible fields (Properties)" / "Filtering"
  sections.
- **Search** — the host's `searchAccessor` (when supplied) drives the tree's
  subtree-preserving `filterTree`; otherwise it falls back to the primary-field
  label. Threaded through the controlled `toolbar.search.query` + `hideInput` of
  `TreeList` (ancestors retained). Pass a `searchAccessor` that folds in ancestor
  names / secondary fields to match on more than the label.
- **Filter** — the view's `state.filter` is applied through the same
  `useRowFilter` lowering (into the filter language) the flat views use, so filter semantics are identical
  across every view. WHAT it tests is the view's `filterScope` (an authored
  config-row key, through data-view's shared `scopeFilterRows` — the same
  function the host's `hideWhenEmpty` check reads):
  - **`rows`** (default) — subtree-preserving (mirrors search): a node survives
    if it matches or has a matching descendant — matches plus the ancestor chain
    of each match — so filtered rows keep their hierarchical context instead of
    being orphaned to the root.
  - **`roots`** — only the ROOTS (orphan rule, as `buildTree`) are tested, and a
    kept root keeps its WHOLE subtree whatever its descendants hold; no ancestor
    is ever pulled in. The partition a `groupBy` makes of the roots, as a filter:
    the Pages sidebar's Private / Scratch sections are two views over one tree,
    `origin is user` / `origin is agent`, and a subtree is never split between
    them. DnD stays on, for the same reason it does under group-by (see below):
    the drop is an anchor the server resolves against the full sibling set, and
    a root-scoped subtree is never split.

  Evaluation lives in this adapter (not the generic `tree` primitive) because it
  needs the `FieldDef` schema + per-type operator sets, which are a data-view
  concern.
- **Sort** — **defaults to manual (rank) order**: an empty `ViewState.sort`
  resolves to a `null` comparator (`makeSortComparator`), so the projected rows
  keep their incoming rank order — the order DnD reorders. Picking a field sort
  reorders each **sibling group** by that field: because `buildTree` preserves
  each parent's incoming child order, a single **stable global sort** of the flat
  projected list (by the same multi-level comparator the flat views use) lands
  every sibling group in comparator order, with rank as the final tie-break — so
  hierarchy is preserved. While a field sort is active the rank order is
  overridden, so **DnD reorder is suspended** (`onMove` is dropped, matching
  Notion — clear the sort back to Manual to drag); `onCreate` stays enabled.
- **Group-by** — when the view sets `state.groupBy` to a groupable field, the
  **roots** partition into flat sections via the shared `partitionIntoSections`
  (enum-option section order + the "None" bucket for free), rendered through the
  shared `<GroupedSections>` chrome (pinned/stacking collapsible headers) with
  one `TreeList` per section. Every descendant follows its **root ancestor's**
  section regardless of its own field value (climbing `parentId` under the same
  orphan rule as `buildTree`); the header count is the section's root count. The
  per-list chrome renders exactly ONCE for the whole view: expand-all /
  `toolbarStart` are hoisted above the sections and the root Add footer below
  them, while the (hidden-input) search stays threaded into each per-section
  list. **DnD reorder keeps working while grouped** (unlike under sort): the
  drop contract carries no rank, only an anchor the server resolves against the
  complete sibling set, so a section seeing just its own roots cannot mint a
  colliding key. Two facts make that correct rather than merely harmless — a
  cross-section drag is unrepresentable (each `TreeList` mounts its own
  `RankReorderDndContext`), and `bucketRowsByRootSection` keeps every
  descendant in its ROOT's section, so a subtree is never split and the
  per-section `isDescendant` guard still sees the whole chain. An unset /
  unresolvable / value-less group field renders the exact
  ungrouped path. The pure pieces (orphan-rule roots, field adaptation onto the
  projected wrapper, children-follow-their-root bucketing) live in
  data-view's `web/internal/hierarchy/group-rows.ts`, bun-tested alongside `project-rows`.
- **Expand-all, three scopes.** The hoisted whole-view button and `TreeList`'s
  own toolbar button are the same `useFlatExpandAll(rows, setExpanded)`; the
  grouped path only hoists it because each per-section list suppresses its own
  toolbar. Each group header additionally carries a fold-this-group toggle via
  `GroupedSections.headerActions` (that seam is documented in the data-view
  CLAUDE.md) — well-defined because `bucketRowsByRootSection` files every
  descendant under its ROOT's section, so a group never holds half a subtree.
  Three choices to leave alone:
  - **Not gated on `options.expandAll`.** That option names the whole-view
    *toolbar* button, and the surfaces that omit it to stay minimal — a narrow
    sidebar tree like the Pages sidebar's — are exactly the ones this exists for. Same
    reasoning that left the tree primitive's per-row fold ungated.
  - Built from the **pure** `flatExpandAll`, not the hook, so a section with
    nothing expandable answers `null`. A hook would need a child component, and
    a child rendering nothing still hands `GroupedSections` an element to wrap —
    an empty cluster that spends the header's gap and pulls that section's count
    off the edge its neighbours line up on.
  - An `IconButton`, not `ExpandAllButton`, matching the per-row fold:
    `RowActions` declares the `xs` control density its children size from, while
    `ExpandAllButton`'s compact variant is hand-sized for a toolbar.
- **Expand state** — read **only** from the data-view primitive's own
  per-`(surface, view-instance, row)` expand map (localStorage, so it survives
  reload and differs per view instance), falling back to
  `options.defaultExpanded`, then collapsed. `hierarchy` carries no expand
  accessor, so a source cannot route this through its own store; every write —
  a chevron, expand-all, the reveal-on-select ancestor walk — goes back as one
  batch through `DataViewRenderProps.setExpanded`, which the host always
  supplies (it is a required prop, not an optional one).
- **Read-only sources** — when `onMove` / `onCreate` are omitted (and the primary
  field declares no `onEdit`) the
  view passes no handler to `TreeList`, so the row's drag source, every Add
  affordance, and inline rename genuinely disappear (no inert placeholders).
- **Alias (reference) nodes** — `hierarchy.getAliasParents` declares extra
  (parent → row) reference edges: the row *also* renders as a leaf under each
  returned parent (skipping parents that aren't rendered rows, the row itself,
  or its real parent). Alias node ids are a projection-internal encoding
  (`<rowKey>\u0000alias\u0000<parentKey>`), so `rowKey` never needs to know;
  `onRowActivate` receives the real row. Aliases are navigation-only: read-only
  label, no row menu / item actions, a trailing link glyph, and `expanded:
  false` (a leaf — the referenced row's own subtree stays at its canonical
  place). Mutations are alias-translated before reaching the consumer: an alias
  can't be dragged (drop no-ops), a `child` drop / add-child on an alias
  resolves to the REAL row, and a drop *beside* an alias degrades to an append
  under the destination parent (an alias has no real sibling position).
- **Alias ranks are minted, not borrowed.** Each alias-parent's aliases get a
  contiguous run of fresh ranks *after* that parent's last real child
  (`Rank.nBetween(maxRealRank, null, k)`), so rank order agrees with display
  order (aliases render last) and no two nodes under one parent share a rank.
  They must not carry the referenced row's own rank: a rank is only meaningful
  within its own sibling group, so importing one from a foreign group collides —
  with per-group ranks (`a0, a1, …`) an alias of any parent's first child lands
  on `a0`, exactly where the host parent's own first child sits, and rank order
  then contradicts paint order. (It used to be worse: the drop path rank-SORTED
  the children, so the duplicate made `Rank.between(a0, a0)` throw and silently
  swallowed drags on the REAL rows beside the alias. The drop path is
  anchor-only now, so what minting protects is the display invariant.)
- Alias ranks are projection-local — an alias occupies rank space that does not
  exist in storage — which is one more reason nothing client-side may mint a
  key from them. The `HierarchyConfig.onMove` contract carries no rank, so this
  is enforced by the type rather than by consumer discipline.

## Options

`options` (= `viewOptions.tree`) is a `TreeViewOptions<TRow>`:

- `rowAccent?(row)` — a first-class full-row accent/background layer (e.g. a
  translucent membership wash). Rendered by the tree primitive's `RowChrome` into
  a primitive-owned `absolute inset-0` layer painted *over* the row, so a
  translucent overlay composes with the hover/selected backgrounds. Use this
  instead of faking a full-row background inside `trailing`.
- `leadingIcon?(row)` — icon rendered before the label, after the schema's
  leading field (`FieldDef.leading`), if any — that field is out of the label
  pick and the secondary chips. See the data-view CLAUDE.md ("Leading field").
- `trailing?(row)` — persistent content rendered after the label (status badge,
  count, …). Always visible — distinct from `itemActions`, which are hover-revealed.
- `rowMenu?(helpers, row)` — items for the row's hover-revealed "⋯" more-menu
  → `RowChrome.menu`. (The whole row is the drag source, Notion-style — there is
  no separate grip handle; this menu lives in the trailing actions cluster.)
- `dragOverlay?(row)` — content shown in the floating drag chip.
- `addLabel?` — root "Add" button label (`null` hides; default null when no `onCreate`).
- `defaultExpanded?` — expansion for nodes the user has never toggled, i.e. with
  no entry in the view's expand map. `true` opens the whole tree on first paint
  (for small derived trees whose point is to show the entire set) while staying
  collapsible, since a user toggle writes a map entry that wins. Default `false`.
- `expandOnActivate?(row)` — rows whose activation (a body click) toggles
  expansion **instead of** firing `onRowActivate` — the "click a folder to open
  it" affordance (`(r) => !r.registration` on the config nav's group headers). It is
  **stateless**: it routes the gesture only, the value still lives in the view's
  expand map, so unlike a consumer-held expand accessor it cannot be half-wired.
  Alias rows never toggle — an alias is a reference leaf whose subtree lives at
  its canonical place.

- `columns?: "chips" | "aligned"` — `"chips"` (default) is the trailing-chip
  body above. `"aligned"` renders the visible secondary fields as fixed-width
  cells at the END of every row (after `trailing`), so every depth lines up on
  one right edge, under a sticky header row (`AlignedHeader`, pinned at the
  DataView's `--dv-header-offset`) of the field titles. Widths come from
  `FieldDef.width` when it is a definite length (a grid track like `auto` /
  `1fr` / `minmax(…)` means nothing to a flex row and falls back to 6rem; any
  other definite length must be px or rem, or it throws);
  `FieldDef.align` defaults to `"end"`. **Columns give way to the label**:
  `useAlignedFit` measures the header's label cell and drops columns (in
  `FieldDef.dropOrder`, lower first; unnumbered last, rightmost first —
  `fitAlignedColumns`, from `data-table`'s `core`, which the grid table's fit
  runs too) until
  the label keeps 160px — measured on the tree, so a narrow pane in a wide
  window behaves like a narrow window (never a viewport media query). A title whose field is in
  `sortHeader.sortable` is a button calling the view's `setSort` (the table
  headers' path), with the active direction's arrow. The header mirrors
  `TreeRowChrome`'s depth-0 geometry (indent + chevron slot) rather than
  measuring rows; a row with a multi-select checkbox or a wider leading slot
  shifts its label, not its cells.

- `guides?: boolean` — indent guides (the tree primitive's
  `TreeListProps.guides`): a hairline per ancestor level in `--tree-guide`. They
  sit in the indent padding, so the aligned header geometry is unchanged.

The aligned cells read `text-row-meta` (muted, or the selected row's
`selectedMetaForeground`), and the selected row's name `selectedForeground` —
see the tree primitive's CLAUDE.md "Opt-in looks".

Two more inputs come from outside `options`:

- **Lazy children** — `HierarchyConfig.lazyChildren` is the tree primitive's
  `LazyChildren` over `TRow`, adapted onto the projection (an alias node is
  never lazy). See the tree primitive's CLAUDE.md "Lazy children".
- **Open** — `DataViewProps.onRowOpen(row)` (→ `DataViewRenderProps.onRowOpen`)
  becomes `TreeList.onOpen`; an alias opens the row it references.

Every row also renders a Notion-style hover-revealed "+" in its trailing actions
cluster (add-child), shown whenever the source supplies `hierarchy.onCreate`.
This replaces the old persistent "Add" line under expanded nodes — keeping the
tree compact. Pass `addLabel: null` to drop the root footer too and surface root
creation from your own chrome (e.g. a section-header "+").

## Row tone

`DataViewRenderProps.rowTone` folds into the row's `labelClass` through the
shared `rowToneClass`, **ahead of** `options.labelClassName` — so a consumer's
own per-row class still wins. `labelClassName` / `rowAccent` remain the escape
hatch; `rowTone` is the semantic form to reach for first. See the data-view
CLAUDE.md ("Row tone").

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Tree view child for the data-view primitive: adapts the shared field schema + hierarchy config onto the tree primitive (buildTree, TreeList, RowChrome, RenameInput).
- Web:
  - Contributes: `DataViewSlots.View` "Tree" → `TreeView`
  - Uses: 44 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×22
    - `primitives/tree` ×9
    - `primitives/css/ui-kit` ×2
    - `primitives/collapsible.ExpandAllButton`
    - `primitives/css/center.Center`
    - `primitives/css/fill.Fill`
    - `primitives/css/inline.Inline`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/sticky.Sticky`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useLatestRef`
    - `ui/icons.Icon`
  - Exports (types): `TreeViewOptions`

<!-- AUTOGENERATED:END -->
