# view-order

Per-view-instance manual row order for **every** DataView — the Notion model:
manual order is the default, applying a sort overrides it, clearing the sort
restores it. No per-consumer wiring, no opt-in flag.

**A row order is a property of the view instance, not of the data.** The key is
`(dataViewId, viewId, rowKey)`: two view instances of the same surface hold two
different orders, and a `+`-created view can be arranged independently. Because
`viewId` is part of that key, every identity-bearing view config **must author an
explicit `id`** on each view row (enforced by the `config-stable-list-ids` check) —
a content-derived `auto-<hash>` id would shift on rename/filter-edit and orphan the
`data_view_row_order` rows keyed on the old id. That is why this lives in the
primitive rather than in each consumer's own rank column (the `DataViewProps.manualOrder`
seam, which a consumer owning a domain rank still uses and which still outranks
this contributor).

**Dependency direction: this child imports the parent (`view-order → data-view`),
never the reverse.** It contributes itself into the global
`DataViewSlots.RowOrder` slot; the host names no contributor. Structurally the
twin of `custom-columns` — a data-view child owning a generic DB table + a live
value + one endpoint, injected back through a global slot.

## Model

- `data_view_row_order(data_view_id, view_id, row_key) → rank` (PK on the triple,
  index `dvro_view_idx` on the pair). `rank` is `rank_text` (C collation), the
  repo's fractional-index column type.
- `rowOrder` — a live value (`liveValue` with `params: ["dataViewId", "viewId"]`,
  served `serveValue(…, { source: "db", unbounded })`), emitting
  `{ rowKey, rank }[]` rank-ascending. A value, not a collection: the composite
  key has no single id to read a row by. The loader reads the table, so the
  **change feed** recomputes it on every write; no notify. It ships only what
  was ever written — a view whose top three rows were arranged carries three
  rows, not the whole view. `useRowOrder` is a `pending | settled` union (see
  Row keys for why the contribution abstains while pending).
- `POST /api/data-view/row-order` — the single endpoint. Body carries the drag's
  **bounded write set** (`writes: { rowKey, rank }[]`, rank-ascending), never the
  whole ordered key set. The server validates and upserts it; nothing is deleted.

## The seeding rule (the crux)

A row with no persisted rank yields `getRank → null`, which makes it undraggable
and produces a *mixed* section that `orderSectionsByRank` leaves under-specified
(its comparator returns `0` for any null pair). So `seedRanks` synthesizes a
**total** order: persisted ranks verbatim, then every unpersisted key appended
after `max(persisted)` **in source order**. Display-only — a seed is never written
as-is.

### Why a write is bounded, not a full replace

The naive incremental rule — persist **only** the moved row, re-seed the rest each
render — is **unstable**: an un-moved row's rank gets re-derived against an anchor
the move itself displaced, so rows A,B,C (none persisted) with C dropped between A
and B redisplay as **C,A,B**. (Seeding at the top fails symmetrically.)

The stability this needs is guaranteed by a single **standing invariant** that
`seedRanks` already maintains and every write must preserve:

> **Persisted rows always display before seeded rows.** The seeds are a suffix,
> in source order, appended after `max(persisted)`.

A write is stable as long as it leaves that invariant true — a *strictly smaller*
obligation than persisting the whole view. The rule (`computeMoveWrites`): let the
drag move row `X` before/after row `Y`, and let `next` be the post-move **display**
sequence.

> **Persist `X`, plus every seed that lies before `X` in `next`, in `next`'s
> order.** Everything after `X` stays seeded. Nothing is deleted.
> Writes = `1 + (seeds now ahead of X)`.

On the A,B,C case the write is `{ A, C }` — A materialized as C's anchor, then C
ranked after it; the next render re-seeds B after `max(persisted)` and the display
holds at `A,C,B`. The cost:

- a drag anywhere inside the already-arranged prefix → **1 row**;
- a drag to the top of a never-arranged 3666-row view → **1 row**;
- `O(|view|)` only for a drop *deep into the never-arranged tail* — where the user
  has, by definition, just declared an order for everything above the drop.

`onMove` passes `orderedKeys` in **source** order; `computeMoveWrites` derives the
display order itself and splices `X` there.

**The one subtle case.** The materialized set is chosen by **position in `next`**,
*not* by a source-order prefix of the same count. A seed dragged *downward* must
materialize the seeds that ended up ahead of it — reaching a source index *past*
`X`'s own; "the first `m` seeds in source order" would silently no-op that drag.
Pinned by `order-ops.test.ts` (downward-seed case + the A,B,C flip).

#### Why the rank arithmetic can neither throw nor collide

Materialized seeds rank `> max(persisted)`; `X` is ranked **last**, once its
predecessors exist. `pred` (the key before `X` in `next`) is always persisted by
construction, so it is a real rank. `succ` (the key after `X`) is read from
`persisted` — **not** the just-minted set — so a *seed* following `X` reads as
`null`: `X` becomes the new `max(persisted)` and the untouched seeds re-seed after
it, keeping the invariant. Hence `pred < succ` always holds, `Rank.between` never
sees an inverted or equal pair (cannot throw), and dense-fractional ranks cannot
collide with a sibling.

Ranks are minted **client-side** (`Rank.between` / `Rank.nBetween` in
`computeMoveWrites`), because the server cannot reproduce seeds — it does not know
the view's source order. Precedent: `computeFlatReorder` (`primitives/rank/core`)
mints client-side for the tree. Repeated `Rank.between` in the same gap grows key
length; same posture as the tree and pages ranks — no compaction job.

#### Semantics this changes

Only the **arranged prefix** freezes. Rows below it keep following the view's
natural source order, and a **new row sorts into that tail naturally** rather than
being appended last — arranging the top of a list no longer commits you to an
order for 3600 rows you never looked at.

#### `applyMove` operates on display order

`applyMove` splices `X` in the **display** order, not the source order — the order
the user actually drags in. The two coincide *only* while `persisted` is empty, so
splicing source order silently discards the previous drag's arrangement from the
second drag on. `computeMoveWrites` derives the display order internally (sorting
`orderedKeys` by `seedRanks`), so the caller keeps handing it source order; pinned
by the second-drag regression test in `order-ops.test.ts`.

### Inserting rows from elsewhere (`onInsert`)

A native `rowDrop` under `placement: "between"` lands in a gap of the view
(`RowDropContext.order.insert`), carrying keys that may name rows the consumer
has not created yet (a folder just pinned to the Places sidebar).
`computeInsertWrites` is `computeMoveWrites` generalized: the absent keys are
appended to the ordered set, the keys are spliced next to the target as ONE run
in the given order, and the write is the run plus every seed now ahead of it —
the same invariant, so the row renders in its gap wherever its source order
puts it once it appears. An absent key is never a no-op: it always takes a rank,
since where it would seed is unknown. `computeMoveWrites` is the one-present-key
case and delegates to it.

### Why neighbour coordinates, not `dest.rank`

`ManualOrderConfig.onMove` carries both. `RankReorderProvider` computes
`dest.rank` against the **rendered** items, which under an active search are a
*subset* of the ordered set — a rank between two visible neighbours can land on
the wrong side of a hidden row. Re-inserting next to `dest.targetId` in the full
ordered key list is the correct global semantics and needs no client-side rank
arithmetic.

### Why the ordered set is filter-applied and search-excluded

The host hands this contributor `useFlatRows(rows, fields, { …state, sort: [],
query: "" })`. That removes the "reordering a subset" problem entirely:

- Rows the view **filters out** never receive a rank, so they never enter the
  computed display order and never appear in a write set.
- **Search** only affects what is *rendered*, never the ordered set. A drag under
  an active search still resolves against the full ordered set (both `id` and
  `targetId` are members, and `computeMoveWrites` derives the display order from
  it), so the moved row lands adjacent to its target *globally* and no hidden row
  is dropped. One write path — no `scopeComplete` flag, no fallback endpoint.
- Editing the view's filter changes the ordered set, but a bounded write never
  deletes: a row that leaves the view keeps its persisted rank and re-appears at
  its old slot if it returns (see Retention).

**Cost.** A drag writes `1 + (seeds now ahead of X)` rows — `O(gesture)`, not
`O(view)` — and the live resource carries only what was ever written. (The
predecessor full-replace rule turned one drag on `tasks-list`'s "Recent" view into
a **3666-row** write shipped to every client with the view open.) The one case
that still degrades to `O(|view|)` is a drop *deep into the never-arranged tail*;
the `computeMoveWrites` cost gates pin the boundaries (row 900 → top = 1 write;
row 0 → before row 900 = 900 writes).

## Row keys

`rowKey(row, 0)` is called with a **constant index**, because `FieldDef.value` gets
no index. A surface whose row keys are index-derived therefore cannot persist an
order (its keys would shift under the very reorder they encode) — the identical
edge case as `custom-columns`; every DataView in the repo passes an id-derived
`rowKey`.

While the `rowOrder` value is `pending` the contributor renders `render(null)` —
the pending arm of `useRowOrder` has no `persisted` map at all, because an empty
one would be indistinguishable from "never reordered", and seeding from it would
show pure source order and let a drag persist that as if it were the user's
arrangement.

## Retention

`data_view_row_order` is keyed by an opaque `rowKey` string, not an FK, so a DB
cascade is impossible: a deleted row leaves a stale order entry. There is
**deliberately no sweep** — neither `defineRetention` nor `markFirehose` — for the
same reason `data_view_custom_values` has none: the table is bounded by rows a
user actually dragged, not by a firehose. And no self-GC: a bounded write only
ever upserts, so a key that has left the view is simply left in place.

This is **display-safe**: `seedRanks` keys on membership in the ordered set, so a
stale entry is invisible to the display — its only trace is holding
`max(persisted)` slightly high, lengthening subsequent seed keys by a character or
two. It is also what makes the "a filtered-out row re-appears at its **old
persisted slot**" guarantee true.

The *only* durable reclaim path is the already-filed **generic data-view row GC**,
which this primitive cannot build alone (it cannot enumerate live `rowKey`s across
arbitrary consumers — that needs a way for a consumer to publish its live key
set). Identical posture to `data_view_custom_values`.

## Tests

- `core/internal/order-ops.test.ts` (bun:test, pure) — `seedRanks`, `applyMove`,
  `computeMoveWrites`, `computeInsertWrites` (absent keys, runs, and its own
  round-trip property test with new rows at random source positions): the A,B,C stability counterexample, the downward-seed case,
  the second-drag regression, the cost gates, and the **LCG round-trip property
  test** — the real stability gate: folding a random drag's `writes` into
  `persisted` and re-seeding reproduces the post-move display exactly, invariant
  intact.
  `bun test plugins/primitives/plugins/data-view/plugins/view-order/core`
- `server/internal/handle-set-row-order.test.ts` (bun:test, real DB via
  `db-test-fixture` + the real migration chain) — the bounded upsert: a key absent
  from a later write **survives** (nothing is deleted), rank-in-place update,
  C-collation ordering, duplicate-key 400, non-strictly-ascending / equal-rank
  400, per-`viewId` scoping. Requires the running embedded cluster and the applied
  migration (`./singularity build` first).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Per-view-instance manual row order for any DataView: subscribes to the persisted (dataViewId, viewId) ranks, synthesizes a total order, and contributes the resulting ManualOrderConfig back through data-view's global RowOrder slot. Persists a per-view-instance manual row order keyed by (dataViewId, viewId, rowKey): a generic DB table, a push live resource, and a validating upsert endpoint that writes only the drag's bounded set (the moved row plus the seeds now ahead of it) rank-ascending — O(gesture), never a full replace, nothing deleted.
- Web:
  - Contributes: `DataViewSlots.RowOrder` "view-order" → `RowOrderContribution`
  - Uses:
    - `infra/endpoints.useEndpointMutation`
    - `network/live.useLive`
    - `primitives/data-view.DataViewSlots`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/live-state.foldResource`
    - `primitives/live-state.mapResource`
    - `primitives/live-state.ResourceResult`
  - Exports (types): `RowOrderState`
  - Exports (values):
    - `useRowOrder`
    - `useSetRowOrder`
- Server:
  - Contributes: `resource.declare` "data-view-row-order"
  - Uses:
    - `database.db`
    - `database/derived-updated-at.deriveUpdatedAt`
    - `infra/endpoints.implement`
    - `network/live.serveValue`
    - `primitives/rank.rankText`
  - DB schema: `plugins/primitives/plugins/data-view/plugins/view-order/server/internal/tables.ts`
  - Exports (values):
    - `_dataViewRowOrder`
    - `applyRowOrder`
  - Resources: `data-view-row-order` (push, unbounded: one view instance's manual order — the rows a user dragged plus the seeds ahead of them; the key is the composite (dataViewId, viewId, rowKey), so no single-id :rows read fits)
  - Routes: `POST /api/data-view/row-order`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
    - `primitives/rank.Rank`
    - `primitives/rank.RankSchema`
  - Exports (types):
    - `RowOrderRow`
    - `RowOrderWrite`
    - `SetRowOrderBody`
  - Exports (values):
    - `applyMove`
    - `computeInsertWrites`
    - `computeMoveWrites`
    - `rowOrder`
    - `RowOrderRowSchema`
    - `seedRanks`
    - `setRowOrder`
    - `SetRowOrderBodySchema`

<!-- AUTOGENERATED:END -->
