# Per-view manual order + Pages sidebar unification

**Date:** 2026-07-09
**Status:** design, ready to implement
**Parts:** A (data-view primitive, prerequisite) → B (pages app, depends on A)

## Context

The Pages sidebar renders two *hand-rolled, unrelated* surfaces into the same
`Pages.Sidebar` slot:

- `apps/pages/page-tree` → a `<DataView>` (`pages-sidebar`) with a single authored
  `tree` view instance, wrapped in a `SidebarPaneSection` titled "Pages".
- `apps/pages/starred` → `FavoritesSidebar`, a bespoke `SortableList` over its own
  `page_blocks_ext_starred.rank` column, wrapped in a `SidebarPaneSection` titled
  "Favorites".

The two show *the same rows* (pages) through two different renderers, two different
ordering mechanisms, and two different chrome shells. Favorites is conceptually
nothing but "pages where starred = true", yet it costs a whole parallel UI, a rank
column, a live resource ordered by that rank, and a `POST …/starred/move` endpoint.

**Intended outcome:** one `DataView` in the Pages sidebar, whose **view switcher is
the sidebar chrome**. "Pages" and "Favorites" become two authored view instances of
one surface, and the user can add their own views (`+`) — a filtered list, a
grouped table — with zero code. Favorites is *just* a `list` view filtered on a
`starred` bool field.

The blocker: Favorites has a **custom drag order** today. Making it "just a filter"
would delete that. The right fix is not to preserve `starred.rank` — it is to
notice that a custom row order is a property of **the view**, not of the data. That
is exactly Notion's model, and it is missing from our `data-view` primitive. Once
the view owns the order, `starred` needs no rank at all: it becomes a pure presence
marker, and *every* DataView gains Notion-style per-view drag order for free.

Hence Part A is a prerequisite, not a side quest.

---

## Part A — per-view-instance manual order (data-view primitive)

### A0. What exists today

`DataViewProps.manualOrder?: ManualOrderConfig<TRow>` = `{ getRank: (row) => Rank | null; onMove: (id, dest) => … }`.
It is a **consumer-supplied, DataView-level** prop: one order for the whole surface,
sourced from the consumer's own domain rank. Exactly one consumer exists:
`plugins/conversations/…/queue/web/components/sidebar-queue.tsx` (the priority queue).

Downstream plumbing already works and is **not** changing:
`useDataViewSections(..., {manualRank})` zeroes `state.sort`, runs search+filter, then
`orderSectionsByRank`; `list`/`table` build `manualOrderItems` and mount
`RankReorderProvider`; `computeFlatReorder` mints the new `Rank`. Only `list` and
`table` declare `supportsManualOrder: true`.

### A1. The shape: a global render slot + a sibling sub-plugin

`custom-columns` is the exact precedent for "the primitive owns per-surface state and
injects it into *every* DataView, with the host importing nothing". Copy it verbatim.

**New sub-plugin** `plugins/primitives/plugins/data-view/plugins/view-order/`:

| Layer | File | Content |
|---|---|---|
| server | `server/internal/tables.ts` | `_dataViewRowOrder` = `pgTable("data_view_row_order", { dataViewId, viewId, rowKey, rank: rankText("rank"), createdAt, updatedAt })`, PK `(dataViewId, viewId, rowKey)`, index on `(dataViewId, viewId)` |
| core | `core/internal/resource.ts` | `rowOrderResource = resourceDescriptor<RowOrderRow[], {dataViewId, viewId}>("data-view-row-order", …)` |
| core | `core/internal/endpoints.ts` | `setRowOrder = defineEndpoint({ route: "POST /api/data-view/row-order", body: { dataViewId, viewId, order: string[] } })` — **one** endpoint |
| server | `server/internal/resource.ts` | push-mode `defineResource`, loader scoped by `(dataViewId, viewId)`, `orderBy asc(rank)` (L4 change-feed auto-recomputes) |
| server | `server/internal/handle-set-row-order.ts` | one transaction: `DELETE … WHERE dvid=? AND view_id=? AND row_key <> ALL(order)`, then dense `Rank.nBetween(null, null, order.length)` bulk upsert |
| web | `web/internal/use-row-order.ts` | `useResource(rowOrderResource, {dataViewId, viewId})` → `Map<rowKey, Rank>` + `useEndpointMutation(setRowOrder)` |
| web | `web/components/row-order-contribution.tsx` | builds the `ManualOrderConfig`, hands it back via `render` |
| web | `web/index.ts` | `contributions: [DataViewSlots.RowOrder({ id: "view-order", component: RowOrderContribution })]` |

Plus `package.json` + `CLAUDE.md`, mirroring
`plugins/primitives/plugins/data-view/plugins/custom-columns/`.

**New global slot** in `plugins/primitives/plugins/data-view/web/slots.ts`, alongside
`FieldExtension` (a `defineRenderSlot`, so its fold order is a committed reorder override):

```ts
export interface GlobalRowOrderProps {
  storageKey: DataViewId;
  viewId: string;                       // the ACTIVE view-instance id — the order's scope
  rowKey: (row: unknown, index: number) => string;
  /** The view's ordered set: filter-applied, search-EXCLUDED, sort-suppressed. */
  rows: readonly unknown[];
  render: (order: ManualOrderConfig<unknown> | null) => ReactNode;
}
export interface GlobalRowOrderContribution {
  id: string;
  component: ComponentType<GlobalRowOrderProps>;
  order?: number;
}
```

The contributor resolves nothing from the host beyond these props (same discipline as
`CustomColumnFieldExtension`), and soft-disables via `render(null)` when
`getDataViewDescriptor(storageKey)` is absent.

### A2. The seeding rule — the crux

A row with no persisted rank yields `getRank → null`, which (a) makes it undraggable
and (b) produces a *mixed* section, which `orderSectionsByRank` explicitly documents
as under-specified (its comparator returns `0` for any null pair). So the contributor
must synthesize a **total** order. The naive rule is unstable:

> **Counterexample (rejected design).** Seed unpersisted rows after `max(persisted)`.
> Rows A,B,C all unpersisted → seeds `sA<sB<sC`. Drag C between A and B → persist only
> `C → r1` where `sA < r1 < sB`. Next render, A and B are *still* unpersisted, so they
> re-seed after `max(persisted) = r1` → displayed order becomes **C, A, B**, not the
> **A, C, B** the user dropped. Seeding at the top (`Rank.between(null, min)`) fails
> identically. The root cause is re-deriving an un-moved row's rank against an anchor
> that the move itself displaced.

**The rule we adopt — every move is a full replace of the view's ordered set:**

1. **Read.** `persisted: Map<rowKey, Rank>` from the live resource.
2. **Seed (display only, never written as-is).** Memoized: take the rows with no
   persisted rank *in incoming source order* and assign
   `Rank.nBetween(maxPersisted, null, n)` — i.e. append after everything persisted.
3. **`getRank(row) = persisted.get(k) ?? seed.get(k)`** — total, never `null`. Sections
   are homogeneous; every row is draggable.
4. **`onMove(id, dest)`.** Rebuild the post-move order over the **whole ordered set**:
   sort by `getRank`, remove `id`, re-insert adjacent to `dest.targetId` per
   `dest.zone`. Call `setRowOrder({dataViewId, viewId, order})`. The server regenerates
   dense ranks and deletes every `(dvid, viewId)` row whose `rowKey ∉ order`.

**Why it is stable.** Between moves `persisted` is constant, so no un-moved *persisted*
row can shift. The only synthesized ranks belong to rows with no entry at all, and the
append rule keeps their mutual order equal to source order. After any move, **every row
in the ordered set is persisted in the same write**, with dense ranks that encode
exactly the displayed post-move sequence — so the counterexample's flip cannot occur:
A and B are persisted alongside C, not re-seeded against it. Regenerating from
`nBetween(null, null, k)` each time also bounds key length (no unbounded subdivision).

**Why the ordered set is the *filter-applied, search-excluded* rows.** This is the
subtlety that removes the entire "reordering a subset" problem:

- The host already owns the filter pipeline. It hands the contributor
  `useFlatRows(rows, fields, {...activeState, sort: [], query: ""}, …)`.
- For Favorites that set is exactly the starred pages. **Unstarred pages never receive a
  rank at all** — no thousands-of-rows write, no "starring a page later finds it already
  ranked mid-list" surprise. A newly starred page has no entry → seeds to the end.
- Search only affects *what is rendered*, never the ordered set. A drag under an active
  search still rebuilds the full order (both `id` and `dest.targetId` are members), so
  the moved row lands adjacent to its target in the global order — correct, and no
  hidden row is ever deleted. **One write path; no `scopeComplete` flag, no fallback
  endpoint.**
- Editing the view's filter changes the ordered set; the next drag's replace self-GCs
  the rows that left. This is strictly better than `custom-columns`, which never cleans.

**Cost.** One drag writes `O(|ordered set|)` rows. Manual order is already documented as
targeting bounded lists (it disables virtualization). Acceptable; document it.

### A3. Host wiring — `web/components/data-view.tsx`

The slot needs `activeViewId`, which is only known after the model resolves, but the
config must exist before `hasSort` / `renderProps`. So split `DataViewInner` into a
model-resolving outer + a `DataViewBody`, with the fold between (a recursive component
fold mirroring `CollectFieldExtensions`, in a new `web/internal/row-order.tsx`):

```tsx
// outer, after activeViewId / activeState are known
const orderedRows = useFlatRows(
  effectiveRows, fields, { ...activeState, sort: [], query: "" }, resolveOps, searchAccessor,
);
const enabled =
  !!activeInstance?.viewType.supportsManualOrder &&   // list / table only
  props.manualOrder == null &&                        // a consumer's domain order wins
  props.dataSource == null;                           // server-paginated ⇒ client cannot own order

<CollectRowOrder
  descriptor={DataViewSlots.RowOrder}
  enabled={enabled}
  storageKey={props.storageKey} viewId={activeViewId}
  rowKey={rowKey} rows={orderedRows}
>
  {(contributed) => <DataViewBody {...props} contributedRowOrder={contributed} />}
</CollectRowOrder>
```

In `DataViewBody`, **one rule everywhere (Notion)** — no branch on where the order came
from:

```ts
const cfg = props.manualOrder ?? contributedRowOrder ?? null;
const manualOrderActive =
  cfg != null && activeSupportsManualOrder && activeState.sort.length === 0;
const hasSort = sortController.sortableFields.length > 0 && activeSupportsSort;
renderProps.manualOrder = manualOrderActive ? cfg : undefined;
```

Manual order is the default; picking a sort overrides it and suspends drag; clearing the
sort returns to the custom order.

**Two consequences to accept knowingly (call out at review):**

1. The conversations queue sidebar (`sidebar-queue.tsx`) **grows a Sort pill** it does
   not have today, because `hasSort` no longer subtracts `manualOrderActive`. Sorting it
   temporarily displaces the priority order until the sort is cleared. Reversible, and
   consistent with every other surface.
2. **Every `list`/`table` DataView without a `dataSource` becomes drag-reorderable**
   when no sort is set. That *is* the Notion model, and nothing is persisted until an
   actual drag. If a surface proves noisy, the escape hatch is a per-view-instance
   opt-out in its config row rather than a new prop.

### A4. Leak / retention

`_dataViewRowOrder` is keyed by opaque strings (`rowKey`), not FKs, so a DB cascade is
impossible — a deleted page leaves a stale order row. `custom-columns` has the identical
leak on `_dataViewCustomValues` and declares neither `defineRetention` nor `markFirehose`.
Mirror it: **no sweep** (and ours self-GCs on the next reorder). Neither table is a
firehose (bounded by rows a user has actually touched). The durable fix is a generic
"data-view row GC", which the primitive cannot build alone (it cannot enumerate live
`rowKey`s across arbitrary consumers) → file as a separate task, not a blocker.

### A5. Tests

`bun:test`, co-located: the pure seed/replace logic (replay the A2 counterexample and
assert `A, C, B`), and `handle-set-row-order`'s delete-not-in-order behavior against the
`db-test-fixture`.

---

## Part B — Pages sidebar unification (after A lands)

### B1. `page-tree` — mint the field-extension factory

`plugins/apps/plugins/pages/plugins/page-tree/web/slots.ts`:

```ts
export const PageTree = {
  RowActions: defineItemActions<Block>("pages.tree.row-actions"),
  Fields: defineFieldExtensions<Block>("pages.tree.fields"),   // NEW
};
```

`web/index.ts` already re-exports `PageTree` — no barrel change.

### B2. `page-tree/web/components/pages-sidebar.tsx`

- Drop the `<SidebarPaneSection title="Pages" labelExtra={PagesHeaderAdd}>` wrapper. The
  DataView's view switcher becomes the sidebar chrome.
- `views={["tree", "list"]}` (was `["tree"]`).
- Add `fieldExtensions={PageTree.Fields}`.
- Move root-page creation from the deleted `PagesHeaderAdd` to `DataViewProps.creators`:
  `creators={[{ id: "new-page", label: "New page", icon: <MdAdd/>, onSelect: createRootPage }]}`.
  The host renders a single creator as a labelled toolbar `Button`. Per-row sub-page
  creation (`viewOptions.tree.rowMenu` + `hierarchy.onCreate`) and `addLabel: null` stay.
- Author `visibleFields: ["title"]` on both instances (B4) so the contributed `starred`
  bool never renders as a checkbox chip on every row — it stays a pure filter dimension.
- Keep `<Scroll fill>` unless the sidebar host already provides a `PaneScroll` (verify at
  implementation time — the DataView never owns a scroll).

### B3. `starred` — contribute a field, delete the rank

| File | Change |
|---|---|
| `web/components/starred-field.tsx` | **new** — `FieldExtensionProps<Block>` component; reads `starredPagesResource` into a `Set`, yields `[{ id: "starred", label: "Starred", type: "bool", value: b => set.has(b.id), filterable: false, groupable: false }]` |
| `web/index.ts` | replace `Pages.Sidebar({id:"favorites", …})` with `PageTree.Fields({ id: "starred", component: StarredField })`; keep the two star toggles |
| `web/components/favorites-sidebar.tsx` | **delete** |
| `shared/resources.ts` | `StarredPageRowSchema` → `{ parentId }` (drop `rank`) |
| `shared/endpoints.ts` | delete `movePageStarred` |
| `server/internal/tables.ts` | `defineExtension(_blocks, "starred", {})` — presence-only |
| `server/internal/mutations.ts` | `setPageStarred` → plain upsert/delete; drop `movePageStarred` + the `nextRankIn` import |
| `server/internal/routes.ts` | delete `handleMovePageStarred` |
| `server/internal/resource.ts` | drop `rank` from `select`/`orderBy`; the `recompute: {kind:"full"}` justification (a mutable order-by column) no longer holds — revert to the default keyed resource |
| `server/index.ts` | drop the move route + export |

### B4. `config/apps/pages/page-tree/pages-sidebar.jsonc`

The resolver (`normalizeRows`) derives each instance id from `slug(name)`. The `bool`
operator set is `is` / `is-not` with a literal boolean operand.

```jsonc
// @hash 6ec84829688d
{
  "views": [
    { "name": "Pages", "view": { "type": "tree", "visibleFields": ["title"] } },
    { "name": "Favorites", "view": {
        "type": "list",
        "visibleFields": ["title"],
        "filter": { "kind": "group", "id": "fav", "conjunction": "and",
          "children": [{ "kind": "rule", "id": "fav-starred",
                         "fieldId": "starred", "operatorId": "is", "value": true }] } } }
  ]
}
```

**Favorites must be a `list`, not a filtered `tree`:** the tree view's filter is
subtree-preserving (a node survives if it *or a descendant* matches), so a filtered tree
would render the unstarred *ancestors* of every starred page.

### B5. Migration

`./equin build` regenerates migrations from `tables.ts`: `CREATE TABLE
data_view_row_order` (Part A) and `ALTER TABLE page_blocks_ext_starred DROP COLUMN rank`
(Part B). Never invoke `drizzle-kit` directly.

**No data migration.** Main's DB holds exactly **one** starred page
(`SELECT count(*) FROM page_blocks_ext_starred` → 1), so preserving the old favorites
order is not worth a hand-written SQL step. Existing favorites simply seed into source
order on first render.

### B6. Known, accepted behaviors

- If the `starred` plugin is ever disabled, the `starred` field disappears and
  `evaluateNode` fail-softs on an unresolvable rule (returns `true`), so the Favorites
  view would list *all* pages flat. The view instance is authored in *page-tree's* config
  and cannot be conditionally dropped. Acceptable.
- The "New page" creator button is visible on the Favorites view too, and creates an
  unstarred page that does not appear there. Notion-consistent.

---

## Verification

**Part A**
1. `bun test plugins/primitives/plugins/data-view/plugins/view-order` — seed/replace unit
   tests, incl. the A2 counterexample.
2. `./equin build`, then check the generated migration creates `data_view_row_order`.
3. Open any `list` DataView (e.g. `http://<worktree>.localhost:9000/agents` queue
   sidebar), drag a row, reload → order persists. Pick a sort → drag disabled, sort wins.
   Clear the sort → the custom order returns.
4. `query_db`: `SELECT * FROM data_view_row_order` shows dense ranks for exactly the
   dragged view's ordered set.
5. Confirm the conversations queue sidebar still orders by priority with no sort set.

**Part B**
1. `./equin build`; open `http://<worktree>.localhost:9000/pages`.
2. The sidebar shows one surface with a `Pages | Favorites | +` switcher and no section
   headers. The Search button (from `content-search`) is unchanged.
3. Star a page from its row action → it appears in the Favorites view; unstar → it leaves.
4. Drag two favorites; reload → order persists.
   `query_db`: `SELECT * FROM data_view_row_order WHERE view_id='favorites'` → only
   starred pages have rows.
5. `+` → add a custom `list` view, filter it, confirm it persists to
   `config/apps/pages/page-tree/pages-sidebar.jsonc`.
6. Scripted check with `bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/pages
   --click "Favorites" --out /tmp/fav` for a before/after of the switcher.
7. `./equin check` — `data-view:configs-authored`, `migrations-in-sync`,
   `plugins-doc-in-sync`, `plugin-boundaries`.

## Critical files

- `plugins/primitives/plugins/data-view/web/slots.ts` — new `RowOrder` slot
- `plugins/primitives/plugins/data-view/web/components/data-view.tsx` — split + fold + one-rule semantics
- `plugins/primitives/plugins/data-view/web/internal/row-order.tsx` — new fold (mirror `field-extensions.tsx`)
- `plugins/primitives/plugins/data-view/plugins/view-order/**` — new sub-plugin
- `plugins/primitives/plugins/data-view/plugins/custom-columns/**` — the template to copy
- `plugins/apps/plugins/pages/plugins/page-tree/web/{slots.ts,components/pages-sidebar.tsx}`
- `plugins/apps/plugins/pages/plugins/starred/**`
- `config/apps/pages/page-tree/pages-sidebar.jsonc`
