# Pages sidebar: sibling order = document order, defined by the server

## Context

`5b03c4769` made the Pages sidebar tree derive its **hierarchy** from `pageId` (the
denormalized nearest page ancestor), fixing sub-pages nested under a content block
being orphaned to the tree root. But sibling **order** still comes from sorting raw
`page_blocks.rank` strings globally:

```ts
// pages-sidebar.tsx
getParentId: (b) => b.pageId,   // display relation — fixed in 5b03c4769
getRank:     (b) => b.rank,     // storage relation — still a lie
```

A `rank` is a fractional-index key **only comparable within one `(parent_id, rank)`
space**. The sidebar's sibling set — pages sharing a `pageId` — can span *several*
such spaces (some sub-pages are direct children of the page, others sit under a text
line / toggle). Sorting those ranks against each other is meaningless. Two symptoms:

1. **Order.** Sibling order is stable but does not match the order the sub-pages
   appear in the page content.
2. **Aborted drops.** `computeDrop` → `computeFlatReorder` rank-sorts the sibling set
   and calls `Rank.between(a, a)` on a duplicate — which throws → `computeDrop`
   returns `null` → `tree-list.tsx:265` silently swallows the drag.

There is a third, quieter defect underneath: **display order and DnD arithmetic are
two different orders today.** Display order is the array order (a global rank sort);
`computeFlatReorder`'s neighbourhood is a *rank sort of the sibling set*. They
silently disagree, so even a successful drop can resolve against neighbours the user
never saw.

The fix makes all three one order, defined **by the server resource**, not re-derived
client-side from storage pointers.

### The bug is live, and one action from manifesting

Queried against main (`singularity`):

| | |
|---|---|
| live pages / live blocks | 21 / 359 |
| pages nested under a content block | **3** |
| sidebar groups currently spanning >1 rank space | 0 |

All 3 nested pages (`Agent manager`, `Plugin system`, `Apps`) sit under the **same**
text block in the `Website` page, holding ranks `a1`, `a2`, `a3` — so that group
happens to span a single rank space today and looks correct **by luck**. Add one
*direct* sub-page to `Website` and the group spans two spaces; that new child mints
from the `Website`-children space and will very likely be `a1` — colliding with
`Agent manager`'s `a1`. Order breaks and drops start aborting. This is latent, not
theoretical.

## Design

The server resource emits, per page row, a **`docRank`**: a real fractional-index
`Rank`, unique and ordered within that page's **sidebar sibling group** (= pages
sharing a `pageId`), derived from true document order. The sidebar reads
`getRank: (b) => b.docRank`.

Why this exact shape:

- **Display order, array order, and `computeFlatReorder`'s neighbourhood become the
  same order.** That is the actual repair; `docRank` is just its carrier.
- **It must be a real minted fractional key, not an encoded path.** A composite path
  string (`"a1/a0"`) would fail `generateKeyBetween`'s alphabet validation → *every*
  drop aborts. `Rank.nBetween(null, null, n)` yields valid, distinct, ordered keys.
- **Additive, not a replacement.** `rank` stays truthful (`onMove`/`onCreate` read
  `target.parentId` — storage — off the same row). Overwriting `rank` with the doc
  rank would make the *same row* carry different `rank` values depending on whether
  it was read from `pagesResource` or `blocksResource` (a sub-page appears in both).

### Computing document order

An **upward** recursive CTE from the page rows — only pages + their ancestor chains
(~pages × depth), never the whole forest. This loader re-runs on **every**
`page_blocks` write (including the ~1s `data.text` projection while typing), so a
downward full-forest CTE is not affordable.

```sql
WITH RECURSIVE up AS (
  SELECT b.id AS page_row_id, b.page_id, b.parent_id AS cursor, ARRAY[b.rank] AS path
  FROM "page_blocks" b WHERE b.type = 'page' AND b.deleted_at IS NULL
  UNION ALL
  SELECT u.page_row_id, u.page_id, p.parent_id, p.rank || u.path
  FROM up u JOIN "page_blocks" p ON p.id = u.cursor AND p.deleted_at IS NULL
  WHERE u.cursor IS NOT NULL AND u.cursor IS DISTINCT FROM u.page_id
    AND array_length(u.path, 1) < 64          -- cycle guard, see Hole C
)
SELECT page_row_id, page_id, path FROM up WHERE cursor IS NULL OR cursor = page_id
```

The walk stops exactly at the nearest page ancestor (`= page_id`), so `path` is the
rank path from a direct child of the parent page down to the page row.

**Correctness.** Within one `pageId` group, comparing `path` lexicographically is DFS
pre-order. No path is a proper prefix of another: if `path(X)` prefixed `path(Y)`,
then `Y` descends *through* `X`, making `X` a page ancestor of `Y` — so
`pageId(Y) = X ≠ pageId(X)`, contradicting same-group. Paths therefore diverge at some
index where both elements are ranks of live siblings under a common parent — distinct
by `page_blocks_parent_rank_live_uq` / `page_blocks_root_rank_live_uq`. Total order,
no ties.

Edge cases, all correct: root page (`page_id NULL`, `parent_id NULL`) → terminal at
the base, `path = [rank]`. Page whose parent *is* a page → `cursor = page_id` at the
base → terminal. Page under a root-level content block → walks to `parent_id IS NULL`,
lands in the `NULL` group with a content-rank prefix.

### Three holes this must not fall into

**A — the read-set regex only sees double-quoted identifiers** (`plugins/database/server/internal/client.ts:136`):

```js
const re = /\b(from|join|delete\s+from)\s+"([^"]+)"/gi;
```

Raw SQL writing `FROM page_blocks` captures **nothing** → the `page_blocks → pages`
edge never registers in `tableToResources()` → `applyDbChange` early-outs → **the
sidebar silently stops updating.** No error, no log. (The file's own comment says raw
SQL "falls to coarse over-capture" — true for *quoted* raw SQL; unquoted falls to
*under*-capture.) `page-id.ts`'s unquoted CTE is not a precedent: it is a write path,
which has no read-set contract.

Mitigation, belt and braces: interpolate the drizzle table (`sql\`… FROM ${_blocks} b\``,
which renders `"page_blocks"`), **and** keep the existing drizzle select as the
membership query so the edge is captured by the ORM regardless.

**B — membership must never become a function of the traversal.** If the recursive
term can't reach a terminal (a broken ancestor chain), that page yields no row and
would **vanish from `pagesResource`** — not just mis-ordered in the sidebar, but gone
from the `[[` picker, breadcrumbs, story gallery and blog panel. Today's flat select
cannot lose a row. So: the drizzle select stays the **driving** relation and the path
map is looked up onto it; a page with no resolved path keeps its row.

**C — a `parent_id` cycle hangs the loader** forever, pinning a pool connection on a
path that runs on every write. Hence the `array_length` cap above.

**Collation.** `rank_text` is a `TEXT COLLATE "C"` domain, so byte order *is* rank
order — but a recursive CTE's column-type resolution can flatten the domain back to
plain `text`, silently reverting to locale collation where `'a' < 'B'` while JS
`Rank.compare` says `'B' < 'a'`. **Sort the paths in JS, never in SQL**, and comment
why, so a future "optimize the sort into SQL" doesn't quietly invert mixed-case ranks.

### Unresolvable path: there is no orphan, and no user journey to one

The question that motivated a visible "Orphans" category (mirroring Trash): pages
`A ⊂ B ⊂ C`, the user deletes `B` — what happens to `A`?

**`A` is trashed with `B`, in the same operation.** `collectBlockSubtrees`
(`collect-subtree.ts:24-31`) recurses on `parent_id` and **crosses page boundaries on
purpose** (its own comment, lines 11-14), so the collected set is `B` + `B`'s content
+ `A` + `A`'s content. `pageRootIds` (`trash-blocks.ts:131`) takes only *requested*
roots that are pages → one entry labelled `B`; `flagTrashed` (141-151) sets `deletedAt`
on all of it. Trash shows one row, `B`; restoring it brings `A` back in place. Notion's
model. `A` is never left live under a trashed `B`.

**And the near-miss journey is already handled natively.** `A` can only return alone if
it holds its own trash entry (trashed separately, or multi-selected with `B` → two
entries). Restoring `A` while `B` is still trashed hits `untrashBlocks`' `parentGone`
branch, which re-parents it to the workspace root (`targetParentId = null`,
`targetPageId = null`; write at 283-293) — **`A` becomes a top-level page**: visible,
reachable, editable. That is the orphan handling, and it already exists.

Measured against main, both dangling states are consequently **0 rows**:

| state | rows in main |
|---|---|
| **B** — live page whose `pageId` points at a trashed/missing row | **0** |
| **C** — live block whose `parentId` points at a trashed/missing row | **0** |

So the state is **not user-facing** — it is corruption: a live page whose parent
pointer references a trashed row, which neither delete nor restore can produce. The
sole way in is `POST /api/blocks/:id/move` with a trashed `parentId`, which the UI can
never offer (trashed blocks are excluded from every resource → never rendered → never a
drop target). It is reachable only by a direct API call or a future bug.

**Therefore: no Orphans category** (it would be a permanently-empty UI for a state the
app already prevents), **and no crash report** (the right response to a footgun is to
remove the footgun — see step 6, the liveness guard, now in scope). The loader simply
completes the total order: a page with no resolved path sorts **last within its group,
by its raw `rank`**. That is a defined behavior for a degenerate input, not an absorbed
failure — the row is kept and deterministically placed. With the guard in place this
branch is provably dead code.

### Alias nodes are a required companion fix

`tree-view.tsx`'s alias pass gives a reference node `rank: hierarchy.getRank(row)` —
the target's `docRank`, from a **different** sibling group. Since every group is minted
`a0, a1, …`, an alias pointing at *any* page's first sub-page gets `a0` and collides
with its host parent's own first real child's `a0`. Collisions go from coincidental
to near-certain — **symptom #2 would survive in the exact tree this change targets.**

It aborts drops on **real** targets too: sorting `[a0(real), a0(alias), a1(real)]` and
dropping `after` the real `a0` makes the alias the next neighbour →
`Rank.between(a0, a0)` throws. `wrappedOnMove`'s alias degrade does **not** save it —
the abort happens strictly earlier, inside `computeDrop`, before `onMove` is called.

Fix: in the alias pass, mint each alias parent's aliases after that parent's last real
sibling (`Rank.nBetween(maxRealRank, null, k)`). Aliases are already appended last in
array order, so rank order and display order finally agree there too.

## Implementation

1. **`plugins/page/plugins/editor/core/schemas.ts`** — add
   `PageRowSchema = BlockSchema.extend({ docRank: RankSchema })` and
   `export type PageRow = z.infer<typeof PageRowSchema>`. Docblock: derived per-load
   ordering key, unique within a `pageId` group, ordered by document order; **never
   persisted, never written back**; `rank` remains the storage key. (This is the one
   real cost of the design: a `Rank`-typed field that must not be treated as storage.)
2. **`plugins/page/plugins/editor/core/resources.ts`** —
   `resourceDescriptor<PageRow[]>("pages", z.array(PageRowSchema), [])`.
   `RankSchema` already rides this exact path for `rank` (`z.custom` branch server-side
   → `toJSON` → `transform` client-side), so `mode:"push"` validation needs nothing new.
3. **`plugins/page/plugins/editor/core/index.ts`** — export `PageRowSchema`, `type PageRow`.
4. **New: `plugins/page/plugins/editor/server/internal/page-doc-order.ts`** — mirrors
   `page-id.ts`'s raw-recursive-CTE precedent. Export
   `docOrderPaths(executor = db): Promise<Map<string, string[]>>`. Interpolate
   `${_blocks}` (Hole A), depth cap (Hole C), terminal `cursor IS NULL OR cursor = page_id`.
   Returns the map only — no ordering decisions in SQL (collation).
5. **`plugins/page/plugins/editor/server/internal/resources.ts`** — keep the drizzle
   select verbatim as the membership query (Hole B + read-set). Then `docOrderPaths()`,
   group by `pageId`, sort each group by path via element-wise `Rank.compare`
   (unresolved → last within the group, by raw `rank`), mint
   `Rank.nBetween(null, null, n)` per group, return rows in that order so array order
   ≡ `docRank` order. Docblock the invariant: **`docRank` derives from ranks, not
   content** — which is why the `data.text` projection still produces an identical
   result and no push.
6. **Liveness guard on the destination parent** — `handle-move-block.ts:23-67`,
   `handle-bulk-move-block.ts:55-62`, `handle-create-block.ts`, `handle-paste-block.ts`
   filter *siblings* by `deletedAt` but never validate that `body.parentId` itself is
   live (nor does `computePageId`, `page-id.ts:12-26`). Reject a trashed/missing
   destination parent (404 — the block is not addressable). This is the **sole** way to
   produce a dangling `parentId`/`pageId`; closing it is what makes step 5's fallback
   dead code and the orphan class unreachable. Include it here rather than deferring:
   it is small, it is the native fix, and it is what earns the "no Orphans category"
   decision above.
7. **`plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx`** —
   `getRank: (b) => b.docRank`; `Block` → `PageRow` in `rows`, `pagesById`,
   `DataView<PageRow>`, `viewOptions`. Replace the `getRank` comment with why display
   order and DnD arithmetic now agree.
8. **`plugins/primitives/plugins/data-view/plugins/tree/web/components/tree-view.tsx`** —
   accumulate `maxRankByParent` in the real pass; in the alias pass mint
   `Rank.nBetween(maxRankByParent.get(parent) ?? null, null, count)` per alias parent,
   `try/catch` → fall back to `hierarchy.getRank(row)`. Replace the docblock line
   "An alias keeps its row's own rank — good enough for the DnD arithmetic" with the
   collision rationale.
9. **`plugins/page/plugins/editor/CLAUDE.md`** — a short section: the sidebar's
   ordering space is `docRank`, not `rank`; why; and the "never write it back" rule.
   Plus a line on the trash contract the guard completes: delete cascades across page
   boundaries, restore re-parents a dangling root to the workspace root — so a live
   page can never point at a trashed parent.

## Verification

- **Reproduce first** (the bug is latent — make it manifest): add a *direct* sub-page
  to the `Website` page (which has 3 sub-pages nested under a text block at `a1/a2/a3`).
  Confirm on `main`'s behavior that order is wrong and a drag beside them aborts.
- `bun test plugins/page/plugins/editor` — server suite (db fixture):
  sub-pages split across a direct child and a toggle-nested block → resource order ==
  document order; a page whose ancestor chain is broken **still appears** (Hole B);
  a `parent_id` cycle terminates (Hole C). Plus the guard (step 6): a move/create
  whose destination `parentId` is trashed is rejected 404, and `A ⊂ B`, delete `B` →
  `A` is trashed under `B`'s single entry (the cascade contract the guard completes).
- **Read-set regression test for Hole A** — assert `getReadSetIndex()` for `pages`
  contains `page_blocks` after a loader run. This fails *silently* otherwise, so it is
  the one test that must exist. (`extractReadTablesFromSql` has co-located tests in
  `plugins/database/server/internal/client.test.ts`.)
- `bun run test:dom plugins/primitives/plugins/data-view/plugins/tree` — two aliases
  under one parent get distinct ranks, both after the last real sibling.
- `./equin build`, then drive the real app at
  `http://att-1784198088-f3zp.localhost:9000/pages` via `bun e2e/screenshot.mjs`:
  sub-pages nested under a toggle order correctly against a direct sibling, and a drag
  beside an aliased (linked-page) row completes.
- `mcp__singularity__get_runtime_profile` — compare the `pages` loader aggregate
  before/after **while typing** (this loader is on the keystroke path).

## Out of scope — follow-ups to file

- **Partial index** `ON page_blocks (rank) WHERE type = 'page' AND deleted_at IS NULL`.
  The loader already seq-scans `page_blocks` on every write today (no index on `type`);
  the CTE's added cost is pages × depth PK lookups, negligible against that. The index
  helps the *existing* cost too — but it is a hash-guarded migration and should not be
  coupled to an ordering fix.
