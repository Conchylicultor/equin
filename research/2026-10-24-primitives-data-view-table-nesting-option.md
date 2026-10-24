# data-view: a per-view `nesting` option + a derived Parent field

## Context

A table over a hierarchical source (`<DataView hierarchy={…}>`) always nests:
the host gates on `hierarchy != null && viewType.nestsHierarchy`
(`web/components/data-view-body.tsx:565`), and `TableView` picks
`NestedTableView` whenever `props.hierarchy` is set
(`plugins/table/web/components/table-view.tsx:52`). There is no way to see the
same records as a plain table: one sort across every row, a fold, aggregates,
group-by over all rows. The user asked for this while on the task detail's
"Sidequests copy" view.

Notion's model, which we follow: sub-items are a property of the database, and
how they render is a **view setting** (View settings → Sub-items: *Nested in
toggle* / *Flattened list* / off). A flattened view keeps the structure readable
through a **Parent item** column. So "Tree" and "Flat" become two view instances
of one source, side by side in the view switcher.

## Design

### 1. `nesting` is a host-injected view-blob key, like `filterScope`

The view config row gains an optional `nesting: "nested" | "flat" | "roots"`:

```jsonc
{ "name": "Sidequests (flat)", "view": { "type": "table", "nesting": "flat" } }
```

- `nested` (default, absent): today's behaviour. **No migration**, and every
  committed config keeps its hash.
- `flat`: every row (parent or child) is one top-level row.
- `roots`: only rows whose parent is not in the set (`getParentId(row) == null`
  or the parent is not loaded), drawn flat. This is the "parents only" view.

It is a host key, not a table `configSchema` option, because the **host** owns
every consequence (the fold, manual order, the Parent field, which rows reach the
view). Keeping the key in the host leaves one reader and one gate.

- `core/internal/types.ts`: `ViewState.nesting?: Nesting` (next to `filterScope`,
  `:839`). `type Nesting = "nested" | "flat" | "roots"` is exported from the core barrel.
- `web/internal/use-data-view-model.ts`: `readNesting(view)` beside
  `readFilterScope` (`:210`), with the same "only known spellings count" rule.
  Set it in `deriveViewState`.
- Document it with the other authored keys in data-view `CLAUDE.md` ("The view
  config row", ~`:113`).

### 2. One derived decision in the host: `activeNests`

In `data-view-body.tsx` (`:565`):

```ts
const activeNests =
  hierarchy != null &&
  activeInstance.viewType.nestsHierarchy === true &&
  (activeState.nesting ?? "nested") === "nested";
```

Everything already keyed on `activeNests` flips correctly: `activeSupportsFold`,
`activeSupportsManualOrder` (so the RowOrder contributor mounts and `view-order`
gives the flat view its own per-view rank order, independent of sibling ranks),
`rootsScoped` and `hideWhenEmpty`.

**The view receives `hierarchy` only while it nests**, so the table's own switch
cannot disagree with the host:

```ts
hierarchy: activeNests ? hierarchy : undefined,   // renderProps, :1235
```

`TableView` stays unchanged. A flat table is simply a table without a hierarchy.
The view types that never nest (list, gallery, icons) already ignore
`hierarchy`. Check each one's use of `hasChildren` (`:432-444`). It should stay
derived from the real hierarchy, because a "has sub-items" glyph is still true
in a flat view.

Consequences, which are the same as for any flat table:

- Sort is one global order; search and filter run over every row (no
  ancestor-chain preservation); `filterScope` is ignored, as it already is on a
  flat table.
- No reparent drag, add-child, fold-subtree, expand-all or aliases.
  `getAliasParents` edges are not drawn, so a row appears once.
- `hierarchy.onCreate` is not offered. The flat create affordance applies if
  the surface has one.
- `hierarchy`/`paging` exclusivity (`types.ts:1553-1607`) and a live `source`
  refusing `hierarchy` (`:1844`) are **not** relaxed in this change.

### 3. `roots`: a row filter ahead of the flat pipeline

When `nesting === "roots"` and a hierarchy is present, the host narrows `rows`
to those whose parent id is absent from the row-key set, before rows reach the
fields fold and the view. One `useMemo` in the body, next to the `hasChildren`
derivation, reuses the same `rowKey` and `getParentId`.

### 4. The derived Parent field

When the source has a hierarchy and the active view does **not** nest
(`hierarchy != null && !activeNests`, `nesting !== "roots"`), the host appends one
field to the schema:

- `id: "parent"`, reserved. Assert at schema build that no consumer field
  claims it, and throw if one does (loud, not shadowed).
- `type: "text"`, `label: "Parent"`.
- `value(row)` is the label of the parent row, computed by
  `pickPrimaryField(baseFields)` over the base fields. Compute it **before**
  appending, so Parent never picks itself. Roots return `null`, which groups
  under "None".
- `sortable`, `filterable`, `groupable: true`. Group-by Parent gives one level
  of structure back without the tree.
- `visible: true`. A saved `properties` array that predates it keeps it hidden,
  and the user enables it in Properties. That matches the existing visibility
  semantics (`types.ts:743-750`).

Insert it in `CollectBodyFields` (`data-view-body.tsx` ~`:234-335`), right after
the base `listSchema(...)`, so the field-extension fold, Properties, sort,
filter, group and search all see it with no other change. `CollectBodyFields`
needs `hierarchy` and `activeNests` added to its props `Pick`.

Build the id → row map once per `rows` identity, in a `useMemo`. The lookup is
O(1) per row.

**Known v1 limitation:** text grouping is by label, so two parents with the
same title share a group. If that matters, a later step gives the field an
id-keyed grouping: `value` = parent id, with the cell and grouping label
resolving to the title. Not in v1.

### 5. The control: View settings → Sub-items

`ViewSettingsPopover` (`plugins/view-core/web/components/view-settings-popover.tsx`)
gets a **host section** above the type's `configSchema` fields. It is shown only
when the surface has a hierarchy and the view type declares `nestsHierarchy`:

- A segmented control with **Nested / Flat / Parents only**, writing
  `updateView(id, { nesting }, { merge: true })`. Writing `"nested"` deletes the
  key, so a reverted view serialises exactly as before.
- It shows `filterScope` ("Filter matches: any row / top-level rows") **only
  while nested**, because flat ignores it. This finally gives that authored-only
  key a control.

view-core is type-agnostic and does not know about hierarchy. The data-view
host therefore passes the section in as a slot or child. view-core gains an
optional `hostSettings?: ReactNode` on the popover. Its three mount points
(`editable-view-switcher.tsx:101`, `collapsed-view-switcher.tsx:197`,
`view-section.tsx:267`) thread it from the data-view model, so the gate stays in
data-view, not in view-core. Check during implementation whether an existing
seam already carries host chrome into the popover, and reuse it if so.

### 6. View defaults for the task surfaces (optional follow-up)

Once shipped, the user can add a "Flat" view on the tasks surfaces by duplicating
a view and choosing *Flat*. This change ships no committed config edits.

## Files

- `plugins/primitives/plugins/data-view/core/internal/types.ts`: `Nesting`, `ViewState.nesting`.
- `plugins/primitives/plugins/data-view/web/internal/use-data-view-model.ts`: `readNesting`.
- `plugins/primitives/plugins/data-view/web/components/data-view-body.tsx`: the `activeNests` gate, `hierarchy` passed only while nesting, the `roots` row filter, and the Parent field in `CollectBodyFields`.
- `plugins/primitives/plugins/data-view/web/internal/parent-field.ts` (new): `parentField(baseFields, rows, rowKey, getParentId)`.
- `plugins/primitives/plugins/data-view/plugins/view-core/web/components/view-settings-popover.tsx` and its three mount points: `hostSettings`.
- A data-view web component for the Sub-items section, using the existing `SegmentedControl` from `primitives/view-switcher` or ui-kit.
- Docs: data-view `CLAUDE.md` ("The view config row", "Hierarchy") and table `CLAUDE.md` ("Nesting": "nests only while the view's `nesting` is nested").

## Verification

- Unit (`./equin test plugins/primitives/plugins/data-view`):
  - `readNesting` spellings.
  - The Parent field's value, a root's `null`, and the reserved-id throw.
  - `roots` filtering, including a child whose parent is not loaded.
- jsdom, modelled on `plugins/table/web/__tests__/nested-sort-search.test.tsx`:
  - The same hierarchical source with `nesting: "flat"` renders every row unindented in `role="grid"`, not `treegrid`.
  - A header sort orders across parents.
  - A fold appears.
  - Group-by Parent partitions the rows.
  - `"roots"` shows only the top-level rows.
  - Switching back to `"nested"` restores the tree with expand state intact.
- `./equin build`, then with `browser_*` on the task list: duplicate a view, set
  Sub-items → Flat, confirm the Parent column, sort and group-by Parent, and
  check that the original tree view is unchanged. Take a screenshot with
  `screenshot.ts --path /agents/tasks`.
