# Per-view manual order — v2 (data-view primitive only)

**Date:** 2026-07-09
**Status:** design, ready to implement
**Supersedes:** Part A of [`2026-07-09-global-per-view-manual-order-and-pages-sidebar-unification.md`](./2026-07-09-global-per-view-manual-order-and-pages-sidebar-unification.md).
Part B (Pages sidebar unification) stays a **follow-up task** that depends on this one.

## Context

In Notion, each view of a database carries its own manual drag-and-drop row order.
Our `data-view` primitive has no equivalent. The only manual ordering it supports is
`DataViewProps.manualOrder` — a surface-level prop backed by a rank the **consumer**
owns. Exactly one consumer exists (`conversations/…/queue`). So a user who creates a
view instance via the `+` switcher cannot arrange its rows, and two view instances of
the same surface cannot have different orders.

A row order is a property of **the view**, not of the data. The primitive should own
it generically, keyed on the view instance, with zero per-consumer wiring. Today
`manualOrder` also *hides* the Sort pill; the target semantics are Notion's: **manual
order is the default, applying a sort overrides it, clearing the sort restores it.**

**Decisions taken for this iteration** (they differ from the superseded doc):

1. **Always on, and virtualization is preserved.** Every `list`/`table` DataView
   becomes drag-reorderable when no sort is set — no per-view opt-in flag. The
   superseded doc accepted that manual order renders non-virtualized; we do not.
   `list` and `table` learn to window *and* drag, which the `tree` primitive already
   does today.
2. **Part A only.** The Pages sidebar unification is out of scope.

## A0. What exists today

- `ManualOrderConfig<TRow>` (`data-view/core/internal/types.ts:325`) =
  `{ getRank: (row) => Rank | null; onMove: (id, dest) => … }`, where
  `dest = { rank, groupKey?, targetId?, zone? }`. Both the rank-based and the
  neighbour-based (`targetId`/`zone`) coordinates are already carried.
- `useDataViewSections(…, { manualRank })` (`web/internal/use-data-view-sections.ts:240`)
  zeroes `state.sort`, runs search + filter, partitions by `groupBy`, then
  `orderSectionsByRank`. **Unchanged by this plan.**
- `list` / `table` are the only view types declaring `supportsManualOrder: true`.
  Both build `manualOrderItems(sections, manualOrder)` and mount `RankReorderProvider`.
- **Both render non-virtualized whenever `manualOrder` is present** —
  `list-view.tsx:237` bypasses `VirtualRows`; `data-table.tsx:168` gates windowing on
  `!useRowDecoration`. This is the regression the plan must remove, not inherit.
- `rank-reorder` already owns the windowed-drag machinery: `RankReorderDndContext`
  accepts `measuringAlways` (`MeasuringStrategy.Always`, so rows mounting mid-drag
  become valid drop targets) and its `children` may be a render-prop receiving the
  active drag id. `virtual-rows` already accepts `keepMounted` — documented verbatim
  as "an in-progress @dnd-kit drag whose source row would otherwise unmount
  mid-gesture". **`primitives/tree` (`tree-list.tsx:329,374`) already composes exactly
  these two.** That is the precedent to mirror.

---

## A1. The sub-plugin — `data-view/plugins/view-order/`

`custom-columns` is the exact precedent for "the primitive owns per-surface state and
injects it into *every* DataView, with the host importing nothing". Copy its shape.
Per-row data belongs in the DB (custom-columns puts *definitions* in config_v2 and
*per-row values* in a table); a row order is per-row data, so it is a table.

| Layer | File | Content |
|---|---|---|
| server | `server/internal/tables.ts` | `_dataViewRowOrder = pgTable("data_view_row_order", { dataViewId, viewId, rowKey, rank: rankText("rank"), createdAt, updatedAt })`, PK `(dataViewId, viewId, rowKey)`, index `dvro_view_idx` on `(dataViewId, viewId)`. Re-exported from `server/index.ts` (mirrors `_dataViewCustomValues`). |
| core | `core/internal/types.ts` | `RowOrderRow = { rowKey: string; rank: Rank }` + zod schema (`RankSchema`). |
| core | `core/internal/resource.ts` | `rowOrderResource = resourceDescriptor<RowOrderRow[], { dataViewId: string; viewId: string }>("data-view-row-order", …, [])` |
| core | `core/internal/endpoints.ts` | `setRowOrder = defineEndpoint({ route: "POST /api/data-view/row-order", body: { dataViewId, viewId, order: string[] } })` — **one** endpoint |
| core | `core/internal/order-ops.ts` | The two pure functions (below), unit-tested without React or a DB |
| server | `server/internal/resource.ts` | `defineResource({ key, mode: "push", loader: … orderBy asc(rank) })`; the L4 change-feed recomputes it. `Resource.Declare(...)` in `server/index.ts`. |
| server | `server/internal/handle-set-row-order.ts` | `implement(setRowOrder, …)` — one transaction (below) |
| web | `web/internal/use-row-order.ts` | `useResource(rowOrderResource, { dataViewId, viewId })` → `Map<rowKey, Rank>`; `useEndpointMutation(setRowOrder)` |
| web | `web/components/row-order-contribution.tsx` | builds the `ManualOrderConfig`, hands it back via `render` |
| web | `web/index.ts` | `contributions: [DataViewSlots.RowOrder({ id: "view-order", component: RowOrderContribution })]` |

Plus `package.json` + `CLAUDE.md`.

### The global slot (`data-view/web/slots.ts`)

Alongside `FieldExtension`, a `defineRenderSlot` so its fold order is a committed
reorder override:

```ts
export interface GlobalRowOrderProps {
  storageKey: DataViewId;
  /** The ACTIVE view-instance id — the order's scope. */
  viewId: string;
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

`reorder:configs-authored` will demand `config/primitives/data-view/primitives.data-view.row-order.jsonc`
— copy the generated `.origin.jsonc`, drop `.origin`, keep the `// @hash` line.

The fold itself is `web/internal/row-order.tsx`, a recursive component fold mirroring
`CollectFieldExtensions` (never a `.map` over contributed hooks). Like that fold, it
short-circuits when disabled — `if (!enabled) return <>{children(null)}</>` — so a
DataView that cannot use a row order (a tree view, a `dataSource` surface) never
subscribes to the live resource.

---

## A2. The seeding rule — the crux

A row with no persisted rank yields `getRank → null`, which makes it undraggable and
produces a *mixed* section that `orderSectionsByRank` documents as under-specified
(its comparator returns `0` for any null pair). So the contributor must synthesize a
**total** order. The naive rule is unstable:

> **Counterexample (rejected).** Seed unpersisted rows after `max(persisted)`. Rows
> A,B,C all unpersisted → seeds `sA<sB<sC`. Drag C between A and B → persist only
> `C → r1` with `sA < r1 < sB`. Next render A and B are *still* unpersisted, so they
> re-seed after `max(persisted) = r1` → displayed order becomes **C, A, B**, not the
> **A, C, B** the user dropped. Seeding at the top fails identically. The root cause
> is re-deriving an un-moved row's rank against an anchor the move itself displaced.

**The rule we adopt — every move is a full replace of the view's ordered set:**

1. **Read** `persisted: Map<rowKey, Rank>` from the live resource.
2. **Seed** (display only, never written as-is). Memoized: rows with no persisted rank,
   **in incoming source order**, get `Rank.nBetween(maxPersisted, null, n)` — appended
   after everything persisted.
3. **`getRank(row) = persisted.get(k) ?? seed.get(k)`** — total, never `null`. Sections
   are homogeneous; every row is draggable.
4. **`onMove(id, dest)`** ignores `dest.rank` and uses `dest.targetId` / `dest.zone`:
   remove `id` from the ordered key list, re-insert adjacent to `targetId`, POST the
   whole array. The server regenerates dense ranks and drops every `(dvid, viewId)` row
   whose `rowKey ∉ order`.

**Why it is stable.** Between moves `persisted` is constant, so no un-moved *persisted*
row can shift. The only synthesized ranks belong to rows with no entry at all, and the
append rule keeps their mutual order equal to source order. After any move **every row
in the ordered set is persisted in the same write**, with dense ranks encoding exactly
the displayed post-move sequence — so A and B are persisted alongside C, not re-seeded
against it. Regenerating from `nBetween(null, null, k)` each time also bounds key length.

**Why `targetId`/`zone` and not `dest.rank`.** `RankReorderProvider` computes `dest.rank`
against the **rendered** items, which under an active search is a subset. Re-inserting
next to `targetId` in the **full** ordered key list is the correct global semantics and
needs no rank arithmetic on the client.

**Why the ordered set is the filter-applied, search-excluded rows.** This removes the
"reordering a subset" problem entirely:

- The host hands the contributor `useFlatRows(rows, fields, { ...activeState, sort: [], query: "" }, …)`.
- Rows the view filters out **never receive a rank**. No thousands-of-rows write; a row
  that later enters the filter has no entry and seeds to the end.
- Search only affects *what is rendered*, never the ordered set. A drag under an active
  search still rebuilds the full order (both `id` and `targetId` are members), so the
  moved row lands adjacent to its target globally — and no hidden row is deleted.
  **One write path; no `scopeComplete` flag, no fallback endpoint.**
- Editing the view's filter changes the ordered set; the next drag's replace self-GCs
  the rows that left.

**Cost.** One drag writes `O(|ordered set|)` rows. Acceptable and documented.

### The two pure functions (`core/internal/order-ops.ts`)

```ts
/** Total order over `orderedKeys`: persisted ranks, then appended seeds in source order. */
export function seedRanks(orderedKeys: readonly string[], persisted: ReadonlyMap<string, Rank>): Map<string, Rank>;

/** The post-move key sequence. Returns null when `targetId` is absent (never a silent no-op array). */
export function applyMove(
  orderedKeys: readonly string[], id: string, targetId: string, zone: "before" | "after",
): string[] | null;
```

`rowKey` is called as `rowKey(row, 0)` throughout (`FieldDef.value` gets no index), so a
surface with **index-derived** row keys cannot persist an order — the identical
documented edge case as `custom-columns` (`custom-column-field-extension.tsx:61-63`).
Every DataView in the repo passes an id-derived `rowKey`.

### The server handler

One transaction:

```sql
DELETE FROM data_view_row_order WHERE data_view_id = $1 AND view_id = $2 AND row_key <> ALL($3);
-- ranks = Rank.nBetween(null, null, order.length)
INSERT INTO data_view_row_order (...) VALUES ...
  ON CONFLICT (data_view_id, view_id, row_key) DO UPDATE SET rank = excluded.rank, updated_at = now();
```

Reject a body whose `order` contains duplicates (throw — a duplicate key is a client
bug, not an absorbable value). `order: []` degenerates to the delete alone.

Because `nBetween(null, null, k)` is deterministic, only the rows between the drag's
source and destination actually change rank — the upsert keeps the change-feed's diff
small instead of touching every row.

---

## A3. Host wiring — one rule everywhere (`web/components/data-view.tsx`)

The slot needs `activeViewId`, which `DataViewInner` already resolves at line 172, and
the config must exist before `hasSort` / `renderProps`. No new component is needed: all
hooks stay in `DataViewInner`, and its **`return` is wrapped in the fold**, whose
children-callback (a plain function call, not a component) builds `renderProps`.

Move the `effectiveRows` / `effectiveState` consts above the `if (!activeInstance)`
placeholder return, then:

```tsx
const orderedRows = useFlatRows(
  effectiveRows, fields,
  useMemo(() => ({ ...activeState, sort: [], query: "" }), [activeState]),
  filterController.resolveOperatorSet, searchAccessor,
);

const rowOrderEnabled =
  activeSupportsManualOrder &&   // list / table only
  manualOrder == null &&         // a consumer's domain order wins
  dataSource == null &&          // server-paginated ⇒ the client cannot own the order
  aggregate == null &&           // a representative's rank cannot stand for its members
  !activeState.groupBy;          // a cross-group drop would need a field write

return (
  <CollectRowOrder
    enabled={rowOrderEnabled}
    storageKey={props.storageKey} viewId={activeViewId}
    rowKey={rowKey} rows={orderedRows}
  >
    {(contributed) => { /* renderProps + JSX, using `cfg` below */ }}
  </CollectRowOrder>
);
```

Inside the callback, **no branch on where the order came from**:

```ts
const cfg = manualOrder ?? contributed ?? null;
const manualOrderActive = cfg != null && activeSupportsManualOrder && activeState.sort.length === 0;
const hasSort = sortController.sortableFields.length > 0 && activeSupportsSort;  // no manual subtraction
renderProps.manualOrder = manualOrderActive ? cfg : undefined;
```

Manual order is the default; picking a sort overrides it and suspends drag; clearing the
sort returns to the custom order. Note the sort test lives in `manualOrderActive`, **not**
in `rowOrderEnabled` — so toggling a sort off and on does not tear down the live
subscription, and `useDataViewSections` keeps its existing `manualRank ⇒ sort: []` rule
untouched (the host simply withholds the config while a sort is set).

### Consequences, accepted knowingly

1. The conversations queue sidebar **grows a Sort pill** it does not have today. It is
   not a dead control: with a sort set, the host withholds `manualOrder`, so
   `useDataViewSections` sorts by field and drag is suspended; clearing the sort restores
   the priority order.
2. **Every `list`/`table` DataView without a `dataSource` becomes drag-reorderable** when
   no sort is set. That *is* the Notion model, and nothing is persisted until an actual
   drag. Several affected surfaces (`debug.slow-ops.*`, `debug.profiling.runtime`) author
   a default sort in their committed config, so they stay sorted until a user clears it.

---

## A4. Drag **and** windowing (the part the superseded doc gave up on)

`rank-reorder`'s shell already re-measures droppables every frame under
`measuringAlways`, and `virtual-rows` already pins the drag source via `keepMounted`.
Only rows in the DOM can be drop targets — which is exactly right, since you can only
drop where you can see. dnd-kit's autoscroll brings off-screen targets in, and
`MeasuringStrategy.Always` registers them as they mount.

**`rank-reorder`** — `RankReorderProvider.children` gains the render-prop form
`ReactNode | ((activeId: string | null) => ReactNode)`, passed straight through to
`RankReorderDndContext` (which already supports it). One-line change; its CLAUDE.md's
"Scope" paragraph ("windowing across huge lists while dragging is out of scope … the
data-view manual-order renders non-virtualized per section") is now wrong and must be
rewritten.

**`list`** — delete the `if (manualOrder)` bypass in `renderEntries`. Keep the single
`VIRTUALIZE_THRESHOLD` decision, and wrap each row in `ManualOrderRow` in **both**
branches (`renderRow` is already the shared row markup). `VirtualRows` positions each
row absolutely at its measured offset, so a pinned off-screen drag source is invisible
and harmless. Pass `keepMounted={activeId ? [activeId] : undefined}` from the
provider's render-prop, and `measuringAlways` when any section is windowed.

**`data-table`** — three changes:

- `DataTableProps.keepMountedRowKeys?: readonly string[]`, threaded into
  `VirtualTableBody` → `useVirtualRows({ keepMounted })`.
- Drop the `!useRowDecoration &&` gate on windowing (`data-table.tsx:168`).
- `DataTableRow` currently comments "decoration (drag source) and measure (windowing)
  are mutually exclusive … so a single ref suffices" (`data-table.tsx:222-224`) and
  writes `ref={decorationRef ?? measure?.ref}`. They are no longer exclusive: compose
  the two into one callback ref (a small local `composeRefs` — the repo has no
  `mergeRefs` helper today; if a second caller appears, lift it to a primitive).

**The one genuinely new bit.** `VirtualTableBody` is **not** absolutely positioned — it
renders the windowed slice in normal grid flow between a `paddingTop` and a
`paddingBottom` spacer, so the subgrid column tracks survive. A pinned row is a
*non-contiguous* index in `virtualItems`, and would render in flow at the wrong place.
Generalize the two spacers to **one spacer per gap**: walk `virtualItems`, and wherever
`vi.index !== prev.index + 1` emit a `col-span-full` spacer of height `vi.start - prev.end`
(`scrollMargin` cancels within a gap). Leading / trailing spacers are the existing
formulas. This is a strict generalization — with no pinned rows the range is contiguous
and the output is byte-identical to today.

**`table`** — mount `RankReorderProvider` with the render-prop, forwarding
`keepMountedRowKeys={activeId ? [activeId] : undefined}` and `measuringAlways` to the
`DataTable`. Grouped mode stays non-virtualized (it already is, independent of drag).

**Risk.** The pinned-row-in-grid-flow behaviour is the only thing here without an exact
precedent (the tree pins inside an absolutely-positioned `VirtualRows`). Verify by
dragging a row in `sonata.library`'s table view past the window edge; if the gap-spacer
layout misbehaves, the fallback is to render the pinned drag source inside the leading
spacer with `visibility: hidden` rather than at its true offset — dnd-kit only needs the
node mounted, not correctly placed, once the drag is in flight.

---

## A5. Leak / retention

`_dataViewRowOrder` is keyed by opaque `rowKey` strings, not FKs, so a DB cascade is
impossible — a deleted row leaves a stale order entry. `custom-columns` has the identical
leak on `_dataViewCustomValues` and declares neither `defineRetention` nor `markFirehose`.
Mirror it: **no sweep** (and ours self-GCs on the next reorder). Neither table is a
firehose — both are bounded by rows a user actually touched. The durable fix is a generic
"data-view row GC", which the primitive cannot build alone (it cannot enumerate live
`rowKey`s across arbitrary consumers) → **file as a separate task, not a blocker.**

---

## Critical files

- `plugins/primitives/plugins/data-view/plugins/view-order/**` — new sub-plugin
- `plugins/primitives/plugins/data-view/plugins/custom-columns/**` — the template to copy
- `plugins/primitives/plugins/data-view/web/slots.ts` — new `RowOrder` slot
- `plugins/primitives/plugins/data-view/web/internal/row-order.tsx` — new fold (mirror `field-extensions.tsx`)
- `plugins/primitives/plugins/data-view/web/components/data-view.tsx` — fold + one-rule semantics
- `plugins/primitives/plugins/data-view/plugins/list/web/components/list-view.tsx` — drag + windowing
- `plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx` — drag + windowing
- `plugins/primitives/plugins/data-table/web/internal/data-table.tsx` — `keepMountedRowKeys`, composed ref, gap spacers
- `plugins/primitives/plugins/data-table/web/internal/types.ts` — the new prop
- `plugins/primitives/plugins/rank-reorder/web/internal/rank-reorder-provider.tsx` — render-prop children
- `plugins/primitives/plugins/tree/web/internal/tree-list.tsx` — read-only reference (`:329`, `:374`)
- `config/primitives/data-view/primitives.data-view.row-order.jsonc` — new reorder override
- Docs to update: `data-view/CLAUDE.md` ("Manual order" section), `rank-reorder/CLAUDE.md` ("Scope"), `data-table/CLAUDE.md`, `data-view/plugins/list/CLAUDE.md`

Reused, not rebuilt: `Rank.nBetween` / `Rank.compare` (`primitives/rank/core`),
`computeFlatReorder` + `RankReorderProvider` + `useRankReorderItem`
(`primitives/rank-reorder/web`), `VirtualRows` / `useVirtualRows` + `keepMounted`
(`primitives/virtual-rows/web`), `useFlatRows` / `useDataViewSections` /
`orderSectionsByRank` (`data-view/web/internal`), `resourceDescriptor` + `defineResource`
push mode, `defineEndpoint` + `implement` + `useEndpointMutation`.

## Verification

1. `bun test plugins/primitives/plugins/data-view/plugins/view-order` — `seedRanks` /
   `applyMove` unit tests, **including a replay of the A2 counterexample asserting
   `A, C, B`**; plus `handle-set-row-order` against `db-test-fixture` (delete-not-in-order,
   dense re-rank, duplicate-key rejection).
2. `./equin build`; confirm the generated migration creates `data_view_row_order`.
3. `bun run test:dom plugins/primitives/plugins/data-view` — existing DOM suites still pass.
4. Open `http://att-1783601294-zvpp.localhost:9000/agents`: drag a row in the queue
   sidebar → still reorders via the consumer's `manualOrder`; the Sort pill is now
   present; setting a sort suspends drag and sorts; clearing it restores priority order.
5. Open a plain list surface (`/workflows` definitions sidebar): drag a row, reload → the
   order persists. `query_db`: `SELECT * FROM data_view_row_order` shows dense ranks for
   exactly that `(data_view_id, view_id)`'s ordered set and nothing else.
6. Add a second `list` view instance via `+`, drag its rows differently, switch back and
   forth → the two instances hold **different** orders.
7. **Windowing regression gate.** Open `sonata.library`'s table view (>100 rows) and the
   tasks list: rows are windowed (inspect the DOM — only the visible slice is present),
   *and* a drag past the window edge autoscrolls, drops onto a freshly mounted row, and
   persists. This is the check that A4 actually held.
8. Type a search query, drag a visible row onto another → the hidden rows keep their
   relative positions and none are deleted (`SELECT count(*)` before/after is unchanged).
9. `./equin check` — `migrations-in-sync`, `reorder:configs-authored`,
   `data-view:configs-authored`, `plugins-doc-in-sync`, `plugin-boundaries`, `type-check`.

## Follow-ups (file as tasks, do not do here)

- **Part B** — Pages sidebar unification (Favorites as a filtered `list` view instance;
  drop `page_blocks_ext_starred.rank`). Depends on this.
- **Generic data-view row GC** — reclaim `data_view_row_order` / `data_view_custom_values`
  rows whose `rowKey` no longer exists. Needs a way for a consumer to publish its live key
  set to the primitive.
- **Server-delegated row order** — `dataSource` surfaces are excluded today. A
  `DataViewServer.QueryAugmentor` joining `data_view_row_order` could lift that.
