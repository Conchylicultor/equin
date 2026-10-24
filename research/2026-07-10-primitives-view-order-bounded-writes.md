# view-order — bounded writes: a drag costs O(gesture), not O(view)

**Date:** 2026-07-10
**Status:** design, ready to implement
**Supersedes:** the "Why every write is a full replace" rule in
[`2026-07-09-global-per-view-manual-order-v2.md`](./2026-07-09-global-per-view-manual-order-v2.md) §A2.
Everything else in that doc (the slot, the fold, the gate, drag-while-windowed) stands.

## Context

`view-order` makes manual row order the default for every `list`/`table` DataView.
Two costs scale with the size of the *view* rather than the size of the *gesture*:

1. **Every drag persists the view's entire ordered set.** Measured on `tasks-list`'s
   unfiltered "Recent" view (3683 tasks): one drag wrote **3666 rows** to
   `data_view_row_order`.
2. **Opening the view ships the entire order.** `rowOrderResource` is keyed only by
   `(dataViewId, viewId)` and is unwindowed, so every client with the view open
   downloads all 3666 `{rowKey, rank}` pairs, and the L4 change-feed re-runs that
   loader on every drag.

The full replace was adopted because `getRank` must be **total**: rows never dragged
have no persisted rank, so `seedRanks` synthesizes one, and a seed is only comparable
with persisted ranks *within a single render*. Persisting only the moved row lets the
un-moved rows re-seed next render against an anchor the move displaced — the
`A,C,B -> C,A,B` flip pinned in `core/internal/order-ops.test.ts`.

That reasoning is sound but the conclusion was too strong. The stability requirement is
satisfied by a strictly smaller write, and shrinking the write shrinks the live payload
for free (only what was written is ever read back).

### A latent correctness bug this also fixes

`RowOrderContribution.onMove` calls `applyMove(orderedKeys, …)`, where `orderedKeys` is
the **source** order of the ordered set. The user drags in **display** order. The two
coincide only while `persisted` is empty — so the *second* drag on any view POSTs
"source order with one row moved", discarding the arrangement the first drag made.

`order-ops.test.ts:110` never catches it: its stability case starts from an empty
`persisted` map, where source order *is* display order. The rewrite below removes the
bug by construction — the move is computed over the display order it was performed on.

## The rule

`seedRanks` already guarantees a standing invariant, and every case below preserves it:

> **Persisted rows always display before seeded rows.** The seeds are a suffix, in
> source order, appended after `max(persisted)`.

Let the drag move row `X` immediately before/after row `Y`. Let `next` be the post-move
display sequence.

> **Persist `X`, plus every seed that lies before `X` in `next`, in `next`'s order.**
> Everything after `X` stays seeded. Nothing is deleted.
>
> Writes = 1 + (number of seeds now ahead of `X`).

- A drag anywhere inside the already-arranged prefix: **1 row**.
- A drag to the top of a never-arranged 3666-row view: **1 row**.
- It degrades to today's `O(|view|)` only for a drop *deep into the never-arranged
  tail* — where the user has, by definition, just declared an order for everything
  above the drop.

The set must be chosen by position in `next`, **not** by a source-order prefix of the
same count. A seed dragged *downward* (`s_a` before `s_b`, `a < b`) must materialize
`s_1..s_{b-1} \ {s_a}` — which reaches a source index *past* `X`'s own. Choosing "the
first `m` seeds in source order, skipping `X`" silently no-ops that drag. This is the
one non-obvious case; it gets a test.

### Rank arithmetic (why it can neither throw nor collide)

Materialized seeds are ranked `> max(persisted)`, so they always sort after every
pre-existing persisted row. `X` is ranked **last**, after its materialized predecessors
exist:

- `pred` = the key immediately before `X` in `next` (always persisted by construction —
  everything before `X` either already was, or was just materialized), else `null`.
- `succ` = the key immediately after `X` in `next` **if it is persisted**, else `null`
  (a seed follows → `X` goes at the end of the persisted space, and the remaining seeds
  re-seed after it).

So `pred < succ` always holds and `Rank.between` never sees an inverted or equal pair.
When `succ` is `null`, `X` becomes the new `max(persisted)` and the untouched seeds
re-seed after it — the invariant survives.

Repeated `Rank.between` in the same gap grows key length (the dense re-rank used to
reset it every write). That is the same posture the tree and pages ranks already live
with; no compaction job.

### Semantics this changes, deliberately

Today the first drag freezes the *entire* current source order into the DB forever, and
new rows append at the very end. Under the bounded rule only the **arranged prefix** is
frozen; rows below it keep following the view's natural source order, and a new row
sorts into that tail naturally rather than being appended last. Arranging the top of a
list no longer commits you to an order for 3600 rows you never looked at.

### Self-GC, dropped

The full replace deleted every persisted key absent from the posted order. A bounded
write cannot, so **nothing is deleted**.

This is display-safe: `seedRanks` keys on membership in the ordered set, so a stale
entry is invisible — it can only hold `max(persisted)` high, slightly lengthening
subsequent seed keys. The table stays bounded by rows a user actually dragged, the
identical posture as `data_view_custom_values` (which also has no sweep). Reclaiming
truly-dead keys remains the already-filed **generic data-view row GC** follow-up.

One behavior falls out: a row filtered out and later returning re-appears at its old
persisted slot instead of at the tail. That is what `seedRanks`' own doc-comment already
claims happens ("a row the view currently filters out still holds a rank, and a seed
must sort after it") — today the next drag's replace silently contradicts it. The
bounded rule makes the comment true.

## Implementation

### `core/internal/order-ops.ts`

Keep `seedRanks` verbatim — it is still the display projection. Keep `applyMove` as the
pure sequence splice, but it is now applied to the **display** order, not the source
order. Add the one new export:

```ts
export interface RowOrderWrite { rowKey: string; rank: Rank }

/**
 * The bounded write set for one drag. `null` = broken caller invariant (`id` or
 * `targetId` outside the ordered set) — never an empty array a caller could POST.
 * `[]` = a legitimate no-op (dropped onto itself / already adjacent): skip the POST.
 */
export function computeMoveWrites(args: {
  orderedKeys: readonly string[];          // the ordered set, in SOURCE order
  persisted: ReadonlyMap<string, Rank>;
  id: string;
  targetId: string;
  zone: "before" | "after";
}): RowOrderWrite[] | null;
```

Body:

1. `ranks = seedRanks(orderedKeys, persisted)` (total).
2. `display = [...orderedKeys].sort(by ranks)` — ranks are total and distinct.
3. `next = applyMove(display, id, targetId, zone)`; `null` → return `null`;
   `next` deep-equals `display` → return `[]`.
4. `xIdx = next.indexOf(id)`; `toMaterialize = next.slice(0, xIdx).filter(k => !persisted.has(k))`.
5. `maxP` = max over **all** of `persisted.values()` (including keys outside the ordered
   set — same rule `seedRanks` uses). `Rank.nBetween(maxP, null, toMaterialize.length)`
   assigns their ranks in order.
6. `pred` = rank of `next[xIdx - 1]` (from `persisted` ∪ the just-minted ranks), else `null`.
   `succ` = rank of `next[xIdx + 1]` **iff** `persisted.has(next[xIdx + 1])`, else `null`.
   `rank(X) = Rank.between(pred, succ)`.
7. Return `[...toMaterialize with their ranks, { rowKey: id, rank: rank(X) }]`.

Ranks are minted **client-side** — the server cannot reproduce seeds (it does not know
the view's source order). Precedent: `computeFlatReorder` (`primitives/rank/core`) already
mints client-side for the tree.

### `core/internal/endpoints.ts`

```ts
export const SetRowOrderBodySchema = z.object({
  dataViewId: z.string(),
  viewId: z.string(),
  /** The bounded write set: the moved row plus any seeds materialized ahead of it,
   *  rank-ascending. Never a full replace; nothing is deleted. */
  writes: z.array(RowOrderRowSchema).min(1),
});
```

Route (`POST /api/data-view/row-order`) unchanged.

### `server/internal/handle-set-row-order.ts`

Collapses to one statement — no transaction, no `DELETE`, no `nBetween`:

- Reject duplicate `rowKey`s (400) and a non-strictly-ascending `rank` sequence (400).
  Both are client bugs, not absorbable values — `HttpError`, as today.
- `insert(...).values(writes).onConflictDoUpdate({ target: PK, set: { rank, updatedAt },
  setWhere: sql\`rank IS DISTINCT FROM excluded.rank\` })` — keep the `setWhere`, so a
  re-POST of an unchanged rank pushes no change-feed diff.

**Optional guardrail (recommended, separable):** add a unique index on
`(data_view_id, view_id, rank)`. Client-minted ranks make a lost-update collision
between two concurrent tabs *possible* where the dense re-rank made it impossible; the
index turns that into a loud 409 instead of a silently arbitrary tie. Requires a
migration (`./equin build` regenerates it). Drop this step if the migration
proves noisy — it is a safety net, not a correctness requirement.

### `web/components/row-order-contribution.tsx`

`getRank` / `seedRanks` / the `pending` guard are untouched. Only `onMove` changes:

```ts
const writes = computeMoveWrites({ orderedKeys, persisted, id, targetId: dest.targetId, zone: dest.zone });
if (writes === null) throw new Error(`view-order: row outside the ordered set (…)`);
if (writes.length === 0) return;                       // legitimate no-op
setRowOrder({ dataViewId: storageKey, viewId, writes });
```

`orderedKeys` stays the source order — `computeMoveWrites` derives the display order
itself, which is exactly the bug fix.

### No data migration

An order written under the old full-replace rule is just a fully-persisted set with an
empty seed tail. It keeps working unchanged.

## Critical files

- `plugins/primitives/plugins/data-view/plugins/view-order/core/internal/order-ops.ts` — `computeMoveWrites`; `applyMove` doc now says "display order"
- `plugins/primitives/plugins/data-view/plugins/view-order/core/internal/order-ops.test.ts` — rewritten (below)
- `plugins/primitives/plugins/data-view/plugins/view-order/core/internal/endpoints.ts` — body `order: string[]` → `writes: RowOrderRow[]`
- `plugins/primitives/plugins/data-view/plugins/view-order/core/index.ts` — export `computeMoveWrites`, `RowOrderWrite`
- `plugins/primitives/plugins/data-view/plugins/view-order/server/internal/handle-set-row-order.ts` — upsert-only
- `plugins/primitives/plugins/data-view/plugins/view-order/server/internal/handle-set-row-order.test.ts` — rewritten
- `plugins/primitives/plugins/data-view/plugins/view-order/server/internal/tables.ts` — only if the optional unique index is taken
- `plugins/primitives/plugins/data-view/plugins/view-order/web/components/row-order-contribution.tsx` — `onMove`
- `plugins/primitives/plugins/data-view/plugins/view-order/CLAUDE.md` — replace "Why every write is a full replace" + the Cost and Retention sections
- `plugins/primitives/plugins/data-view/CLAUDE.md` — the RowOrder-slot paragraph claiming a drag "rebuilds the full order"

Reused, not rebuilt: `Rank.between` / `Rank.nBetween` / `Rank.compare`
(`primitives/rank/core/internal/rank.ts`), `seedRanks` + `applyMove` (this plugin),
`HttpError` + `implement` (`infra/endpoints`), `db-test-fixture` (`database`).

Untouched: `rowOrderResource` and its loader, `CollectRowOrder`, the `rowOrderEnabled`
gate, `orderSectionsByRank`, drag-while-windowed.

## Verification

1. `bun test plugins/primitives/plugins/data-view/plugins/view-order` — the pure suite,
   extended with:
   - the existing `A,B,C → drag C before B → A,C,B` counterexample, now via `computeMoveWrites`;
   - **the downward-seed case**: seeds `A..E`, drag `B` before `D` → display `A,C,B,D,E`,
     and `writes` covers `A,C,B` (a source-prefix rule would emit only `A,B` and no-op the drag);
   - **the second-drag regression**: persisted `[A,C,B]`, source `[A,B,C]`, drag `A` after
     `B` → display `C,B,A`, not the `B,A,C` today's `applyMove(source, …)` produces;
   - **cost gates**: drag row 1 above row 0 in a 1000-key never-arranged list →
     `writes.length === 1`; drag row 900 to the top → `writes.length === 1`; drag row 0 to
     just before row 900 → `writes.length === 900`;
   - a **round-trip property test** over a deterministic LCG: for random
     `(orderedKeys, persisted, id, targetId, zone)`, folding `writes` into `persisted` and
     re-running `seedRanks` + display-sort reproduces `next` **exactly**. This is the real
     stability gate — it asserts the next render shows what was dropped.
   - the DB suite: upsert-only (a key absent from `writes` survives), duplicate-key 400,
     non-ascending-rank 400, per-`viewId` scoping.
2. `./equin build` — clean; a migration appears **only** if the optional unique
   index is taken.
3. `./equin check` — `migrations-in-sync`, `plugins-doc-in-sync`, `plugin-boundaries`,
   `type-check`.
4. Open `http://att-1783644652-py3f.localhost:9000/agents` (tasks list, "Recent", sort
   cleared). Drag the 2nd row above the 1st. Then:
   `SELECT count(*) FROM data_view_row_order WHERE data_view_id = 'tasks-list';`
   → **2**, not 3666. Reload: the two rows hold their arrangement and the tail is unchanged.
5. **The bug gate.** Drag a *third* row up into that arranged prefix. Reload. The first
   drag's arrangement is still there. (On `main` today, this second drag resets the list
   to source order with one row moved.)
6. Drag a row from far down (~row 900) to the very top → `count(*)` grows by exactly 1,
   and the row sticks after reload.
7. `bun run test:dom plugins/primitives/plugins/data-view` — DOM suites still pass; drag
   past the window edge still autoscrolls and drops (the A4 windowing behavior is untouched).

## Follow-ups (file as tasks, do not do here)

- **Generic data-view row GC** — already filed; now the only reclaim path for
  `data_view_row_order` / `data_view_custom_values`.
- **Server-delegated row order** — `dataSource` surfaces stay excluded by the
  `rowOrderEnabled` gate; a `DataViewServer.QueryAugmentor` joining `data_view_row_order`
  would lift that. The bounded rule makes it cheaper to reach: the join is against the
  arranged prefix, not the whole view.
