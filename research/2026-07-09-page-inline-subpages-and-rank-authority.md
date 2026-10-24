# Inline sub-pages + rank authority

## Context

A server crash was reported:

```
[http] POST /api/pages/block-1783508240248-6o4jvk/blocks/op: a0 >= a0
  at generateKeyBetween (fractional-indexing/src/index.js:216)
  at between (plugins/primitives/plugins/rank/core/internal/rank.ts:18)
  at applySplit (plugins/page/plugins/editor/core/block-ops.ts:286)
```

Pressing Enter in a text block asked for a rank strictly between the block and its
next sibling — and both held `"a0"`. Confirmed in the DB:

```
parent block-1783508240248-6o4jvk (the page)
  block-1783508240333-lg2nwe  type=text  rank=a0   ← split target
  block-1783508278584-klx9xv  type=page  rank=a0   ← duplicate
  block-1783508249284-rahtkj  type=page  rank=a1
  block-1783508257814-6976c6  type=page  rank=a2
```

### Root cause

`page_blocks` has **one** ordering space, `(parent_id, rank)`. Two live resources
project it into **disjoint** views:

| resource | filter | consumer |
|---|---|---|
| `pagesLiveResource` | `type = 'page'` | sidebar page tree |
| `blocksLiveResource` | `page_id = ? AND type <> 'page'` | content editor |

Each client mints fractional-index ranks over **only the rows it can see**. A sidebar
drag ran `computeFlatReorder` over the page-only siblings `[a1, a2]`, computed
`generateKeyBetween(null, "a1")` — which is exactly `"a0"` — and wrote it verbatim
through `moveBlock`. The text block already at `"a0"` was invisible to the sidebar.

The same hole exists in the other direction: the editor's client reducer runs over
`blocksResource` (no sub-pages) while the server's runs over `loadPageBlocks` (which
*does* include them), so client and server already mint **different** ranks for every
split/insert on a page that has sub-pages.

### Intended outcome

Adopt the Notion model: **sub-pages render inline as blocks in the content editor**, so
the shared rank space becomes one real, rendered ordering. The sidebar becomes a
filtered *subsequence* of it. Reordering a page in the sidebar positions its block
relative to its neighbouring page block in the content flow.

The invariant to encode: **rank arithmetic is only valid over a complete sibling set.**
Enforced structurally — after this change the page endpoints do not *accept* a
client-minted rank at all, so a filtered view cannot express one. Plus a DB uniqueness
constraint as defense-in-depth.

---

## Design

### 1. One forest

`loadPageBlocks(pageId)` is already `WHERE page_id = ?` with no type filter — it already
returns sub-page rows and already excludes their content (a sub-page's own content
carries `page_id = <subpage id>`). So the server's reducer forest is *exactly* the forest
the content view wants, and a sub-page row is automatically a **leaf** in it.

Deleting `ne(_blocks.type, PAGE_BLOCK_TYPE)` from `blocksLiveResource` makes client and
server see the identical tree. That single line is the linchpin; it also erases the
standing client/server rank divergence.

### 2. Rank authority lives at the endpoint, not the tree

The page endpoints stop accepting ranks:

- `MoveBlockBodySchema`: `{ parentId, rank }` → `{ parentId, targetId, zone }`.
  `handleMoveBlock` computes the rank against the true sibling set.
- `CreateBlockBodySchema.rank`: **deleted**. The existing `afterId` path already computes
  the rank server-side against the true siblings.

This mirrors the precedent already live in this repo: the conversations queue sends
`{conversationId, targetId, zone}` with **no rank on the wire**, and `handleReorder`
calls `rankAdjacentTo` against its own complete table
(`plugins/conversations/.../queue/server/internal/queue-ranks.ts`).

The generic tree keeps its `rank` (tasks and agents feed it complete row sets and are
correct today — changing them is regression risk for no benefit). It simply *also* hands
consumers `{targetId, zone}`, exactly as `ManualOrderConfig.onMove` already does.
The footgun is closed where it matters: for `page_blocks` a filtered view has no way to
send a rank.

The editor still predicts a rank locally for its optimistic overlay — it legitimately
holds the complete forest. Same shape as the queue's `apply-reorder.ts`.

### 3. Page rows become illegal targets, not conditional ones

Making page rows visible makes several **already-latent** server bugs reachable. The
reducer has always seen them; only the client couldn't.

| Op | Hazard | Guard |
|---|---|---|
| `applyIndent` | reparents under a `page` prev-sibling, never updates `page_id` → row whose `parent_id` says "child of sub-page" but `page_id` says "outer page" | reducer: no-op if `prev.type === PAGE_BLOCK_TYPE` |
| `applyMerge` | merging into a page row writes a bogus `data.text` onto `PageDataSchema` data **and** adopts children across the boundary | reducer: no-op if `prev.type === PAGE_BLOCK_TYPE` |
| `applySplit` | splitting a page row is meaningless (`asChild` would cross the boundary) | reducer: no-op if `block.type === PAGE_BLOCK_TYPE` |
| `applyOutdent` | already guards `parent.type === PAGE_BLOCK_TYPE` — currently dead code, becomes live | keep |
| `applyInsert` | already computes `pageId` correctly for a child of a page row | keep |
| `convertTo` | converting a page row to `text` silently orphans every row keyed `page_id = <that id>` — unreachable by any query, forever | server `handlePatchBlocks` throws `HttpError(409)` on a `type` transition into/out of `page`; UI hides the Turn-into affordance on page rows |
| `bulkDelete` | `handleBulkDeleteBlock` runs **no** `BlockLifecycle.BeforeDelete` hooks at all — pure FK cascade, so search docs / history / backlinks are orphaned | run the same hook pass the op handler uses |

The renderer is the primary defense: a sub-page block registers a text-less
`BlockFocusHandle` (selectable, draggable, arrow-navigable) but **no text surface**, so
Enter/Backspace can never *originate* in one. The reducer guards are the belt to that
suspenders.

Because the guards make boundary crossing impossible for indent/merge/split, the
`handleApplyBlockOp` "in-page invariant" stays true and we do **not** blanket-call
`recomputePageIdSubtree` on the hot keystroke path. The genuine crossings —
`move`, `bulkMove`, turn-into-page — recompute explicitly. (`handleMoveBlock` and
`handleBulkMoveBlock` already do; add a targeted call for the `/op` `move` kind.)

### 4. `turn-into-page` collapses

Today it creates a `page` block parented to the page root (always top-level, *not* at the
block's position), bulk-moves the children under it, then converts the original block
into a separate `page-link` — leaving two rows representing one sub-page.

With inline sub-pages the page row *is* the link. It collapses to a single atomic
server op: set `type = 'page'`, `data = {title, icon:null}`, seed an empty text child if
the block had none, and `recomputePageIdSubtree(id)` so descendants flip into the new
page. `page-link` survives as the *reference* block (`[[ ]]` links to arbitrary pages) —
semantically distinct from an in-place child.

### 5. DB guard

`unique("page_blocks_parent_rank_uq").on(parentId, rank).nullsNotDistinct()`.

`(parent_id, rank)` is the right domain: siblings share `parent_id`, and `page_id` is a
pure function of `parent_id`. `NULLS NOT DISTINCT` makes root pages (null parent) one
list. drizzle-orm 0.36 emits this; **`DEFERRABLE` is not expressible** (no drizzle
support; generated migrations are hash-guarded against hand edits; data migrations are
DML-only by the `data-migration-dml-only` allowlist check).

So the check is per-tuple, and two writers can *transiently* violate it before commit:

- **`handleBulkMoveBlock`** — `Rank.nBetween(prev,next,k)` is zipped positionally to
  `roots` (in `selectionRoots` physical order), and `rankWindow` excludes moving ids from
  the window. Repro: under parent P, siblings `B="a1"`(moving), `C="a2"`, `D="a3"`(moving);
  move `{B,D}` after `C`. Window `(a2,null)` excl `{B,D}` → `["a3","a4"]`; the loop sets
  `B → "a3"` while `D` still holds `"a3"`.
- **`handlePatchBlocks`** — the undo/redo blind writer applies client rows verbatim;
  undoing a swap re-assigns two rows to each other's ranks.

Both are fixed with **two-phase park-then-place** inside their existing transaction: first
`UPDATE` each touched row to a fresh key beyond the parent's current max, then `UPDATE` to
the final key. An ordering rule is *not* sufficient — a 2-cycle needs a scratch value.

All other paths only ever mint keys strictly inside a gap containing no live sibling
(`Rank.between` of two adjacent survivors), so they cannot collide.

---

## Files

**One forest**
- `plugins/page/plugins/editor/server/internal/resources.ts` — drop `ne(type,'page')` from `blocksLiveResource`.

**Rank authority**
- `plugins/page/plugins/editor/core/endpoints.ts` — reshape `MoveBlockBodySchema`; delete `CreateBlockBodySchema.rank`.
- `plugins/page/plugins/editor/server/internal/forest.ts` — add `rankAdjacentTo(parentId, targetId, zone, tx)` beside the existing `rankWindow`.
- `plugins/page/plugins/editor/server/internal/handle-move-block.ts` — compute the rank server-side.
- `plugins/page/plugins/editor/server/internal/handle-create-block.ts` — remove the `body.rank ?? nextRankUnder(...)` branch.
- `plugins/primitives/plugins/data-view/core/internal/types.ts` — `HierarchyConfig.onMove` dest gains `targetId?`/`zone?`; `onCreate` args gain `afterId?`, drop `rank?`.
- `plugins/primitives/plugins/tree/web/internal/tree-list.tsx` — thread `zone`/`targetId` (already in hand at the drop handler) into `onMove`.
- `plugins/primitives/plugins/tree/web/internal/use-tree-row.tsx` — `addBelow` sends `afterId: node.id` instead of minting `Rank.between(...)` over `ctx.rows`.
- `plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx` — `onMove`/`onCreate` forward positional intent.
- `plugins/apps/plugins/pages/plugins/page-tree/web/internal/create-page-with-seed.ts` — `rank` arg → `afterId`.
- `plugins/page/plugins/editor/web/block-editor-context.tsx` — `move()` sends `{targetId, zone}`, predicts the rank locally via `computeDrop` over its complete rows.
- Sweep other `createBlock` callers for `rank`: `plugins/page/plugins/inline-page-link/web/internal/create-linked-page.ts`, `plugins/apps/plugins/story/plugins/shell/web/internal/create-story.ts`.

**Guards**
- `plugins/page/plugins/editor/core/block-ops.ts` — page-row guards in `applyIndent`, `applyMerge`, `applySplit`.
- `plugins/page/plugins/editor/server/internal/handle-apply-block-op.ts` — targeted `recomputePageIdSubtree` for `body.kind === "move"`.
- `plugins/page/plugins/editor/server/internal/handle-patch-blocks.ts` — `HttpError(409)` on a `type` transition into/out of `page`; two-phase rank writes.
- `plugins/page/plugins/editor/server/internal/handle-bulk-delete-block.ts` — run `BlockLifecycle.BeforeDelete`.
- `plugins/page/plugins/editor/server/internal/handle-bulk-move-block.ts` — two-phase park-then-place.
- `plugins/page/plugins/editor/web/components/block-actions-menu.tsx` — hide Turn-into on page rows.

**Sub-page renderer**
- New plugin `plugins/page/plugins/sub-page/{core,web}` — `Editor.Block({match: PAGE_BLOCK_TYPE, component: SubPageBlock})`. Renders `PageIcon` + `pageData(block).title || "Untitled"` as a Notion-style inline page row; click → `useBlockEditor().onOpenPage?.(block.id)` (already threaded, wired to `openPane(pageDetailPane)` in `panes.tsx`). Registers a text-less `BlockFocusHandle`.
- `plugins/page/plugins/read-only-view/web/components/read-only-blocks.tsx` — branch `node.type === PAGE_BLOCK_TYPE` before the placeholder fallback; render an **inert title chip** (icon + title, not navigable). The blog is being deprecated, so no coupling to the publish marker.

**turn-into-page**
- `plugins/page/plugins/editor/server/internal/` — new `POST /api/blocks/:id/turn-into-page`: set `type`/`data`, seed an empty text child when childless, `recomputePageIdSubtree(id)`, notify.
- `plugins/page/plugins/turn-into-page/web/internal/turn-block-into-page.ts` — collapse to that one call; delete the `page-link` replacement and the `bulkMove`.

**DB guard**
- `plugins/page/plugins/editor/server/internal/tables.ts` — add the unique constraint.
- Data-repair migration (`./equin build --custom-migration --migration-name repair_duplicate_sibling_ranks`), DML-only, generic. For each duplicate `(parent_id, rank)` group keep the earliest `(created_at, id)` and push the rest to `rank || '1'`, `'2'`, … Valid canonical fractional keys (no trailing `0`) and provably order-preserving given the guard:
  ```sql
  -- only safe when no sibling already occupies the (R, R||'1') span
  NOT EXISTS (
    SELECT 1 FROM page_blocks s
    WHERE s.parent_id IS NOT DISTINCT FROM p.parent_id
      AND s.rank > p.rank AND s.rank < p.rank || '1'
  )
  ```
  Timestamp it **before** the schema migration so it applies first. If a group cannot be
  repaired, the constraint migration fails loudly — which is correct, and is caught
  pre-push by the `migration-applies-clean` check dry-running against `origin/main`'s DB.
- Then `./equin build --migration-name page_blocks_parent_rank_unique`.

---

## Verification

**Reproduce the original crash first** (on `main`, to confirm the repro is real), then re-run after the fix. Playwright, using the `e2e/screenshot.mjs` helper as a base:

1. Create a page, type into its first text block (lands at `a0`).
2. Sidebar → "Add page below" to create a sub-page sharing the parent.
3. Caret in the text block, press Enter. Before: server 500 `a0 >= a0`. After: split succeeds, and the sub-page renders inline as a page row.

**Invariant via `query_db`:**
```sql
-- must return 0 rows, before and after any exercise
SELECT parent_id, rank, count(*) FROM page_blocks GROUP BY 1,2 HAVING count(*) > 1;

-- every block's page_id must equal its nearest page ancestor
WITH RECURSIVE t AS (...)  -- compare against computePageId's rule
SELECT id FROM page_blocks WHERE page_id IS DISTINCT FROM expected;
```
Run it after: turn-into-page, dragging a content block into a sub-page, restoring a page
version, and a sidebar reorder.

**`bun:test` — pure reducer** (`plugins/page/plugins/editor/core/block-ops.test.ts`):
- split / indent / merge against a forest containing a `page` sibling in the target gap →
  no colliding rank; guards no-op when the target is a page.
- property: for every op, no minted key equals a concurrently-live key under the same parent.

**`bun:test` — DB-backed** via `plugins/database/plugins/db-test-fixture`:
- `handleBulkMoveBlock` commits on the `[B=a1, C=a2, D=a3]` two-phase repro.
- `handlePatchBlocks` commits on a swap-undo.
- `handleMoveBlock` computes the rank against the true sibling set and recomputes `page_id`
  across a page boundary.
- the repair migration on a seeded duplicate yields distinct valid keys, is a no-op on re-run,
  and preserves relative order.

**Manual** (`./equin build`, then `http://att-1783585438-8lmd.localhost:9000/pages`):
split a text block on a page with an identically-ranked sub-page; drag a content block into
a sub-page (leaves this editor, appears in the sub-page); turn a block into a page (becomes
an inline sub-page, children follow, sidebar nests it); reorder a sub-page in the sidebar and
confirm the content flow reorders with it.

---

## Follow-ups (out of scope — file as tasks)

- `agents (parent_id, rank)` and `conversation_group_members (group_id, rank)` have the same
  shape and no unique index. Their views are complete today, so no live bug — but the guard
  is missing.
- `replacePageContent` (history restore) mints fresh block ids. A snapshot containing sub-page
  rows would restore them under **new** ids, orphaning their content (still keyed to the old
  `page_id`). Pre-existing; surfaced by reading this code, not by this change.
- `handleBulkMoveBlock` zips ascending `nBetween` ranks to `selectionRoots` **physical** order,
  not rank order — a latent reordering bug independent of uniqueness.
