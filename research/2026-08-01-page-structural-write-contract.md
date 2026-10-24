# A page's structural writes are one ordered stream over one locked forest

## Context

Two concurrency defects in the page editor's structural write path were found
while fixing the post-Enter keystroke race. Both were mitigated under time
pressure. **Neither mitigation is enforced by anything**, so both classes can
silently return — and the next writer added is exposed by default.

**1 — Lost update.** `handleApplyBlockOp` read the forest OUTSIDE its write
transaction, so two concurrent ops on one page both read the pre-state and the
later writer's `UPDATE` reasserted its stale snapshot over every column,
including ones its own op never reasoned about. Captured in the wild: a `split`
carrying `parentId` from a pre-indent read, silently un-indenting a block —
invisible to the client, which had predicted both ops correctly.

Mitigated with `lockPageForWrite` (`server/internal/page-write-lock.ts`), applied
to the op and patch handlers only. The lock is out-of-band: nothing in the
schema, the types, or the build requires taking it. **Of the nine code paths that
mutate `page_blocks`, two take it** — `handleMoveBlock`, `handleBulkMoveBlock`,
`handleTurnIntoPage`, `handleCreateBlock`, `handleUpdateBlock`,
`deleteBlocksSubtree`, `untrashBlocks` and `replacePageContent` all write the
same `(parent_id, rank)` / `type` / `data` columns unguarded. Three of them
(move, bulk-move, turn-into-page) even hand-roll a *narrower* read-inside-tx to
dodge a TOCTOU they each noticed separately — evidence that the invariant is
real and that nothing makes it available.

Also unresolved: the `BeforeDelete` hooks run over a delete set **predicted from
an unlocked read**, while the authoritative set is recomputed under the lock. The
two can legitimately disagree.

**2 — Write reordering.** Causally dependent structural writes (a `convertTo` and
the `split` that inherits its type; an `indent` and the `split` that reads the
moved block) are independent POSTs, so the browser may deliver them in either
order. Captured in the wild: a `split` arriving before the `convertTo` it
depended on, so the user's bullet silently reverted one push later.

Mitigated with a per-page promise chain in `web/block-store.ts` (`writeChainRef`).
The constraint is expressed nowhere durable, and the chain covers only two of the
surface's writers: `move`, `bulkMove` and `bulkDelete` are fire-and-forget
`fetchEndpoint` calls sitting outside it (their eslint-disable reads *"drag again
to fix"*), and `composite-block-store.tsx`'s detached-persist POSTs `patchBlocks`
directly.

Both defects predate the caret work but were latent because a human pauses
between structural edits. The caret authority replays buffered keystrokes with no
pauses, so both now occur routinely.

**Outcome intended:** an unlocked forest write becomes a *tsc error*; a delete
hook sees the set that is actually deleted; and structural write order becomes a
property of the primitive that already assumes it, rather than a ref in one
consumer.

## The two invariants, and why each belongs where it goes

> **A. Atomicity.** A structural write to a page's forest reads and writes that
> forest inside ONE transaction that holds the page's lock. There is no way to
> write `page_blocks` without one.

> **B. Order.** One writer's mutations reach the server in the order it issued
> them.

They are different properties and must not be conflated. **B is per-writer and
causal**: between two *different* writers (a second tab, an out-of-band client)
no causal order exists, so there is nothing to preserve — A is the complete and
correct answer there, and this is a design fact, not a residual gap. Today's
structural writes all originate in a browser client (`crdt-multitab-agent-verify`
covers the out-of-band writer, and it writes only the CRDT *text* lane's
`doc-update` endpoint, never `page_blocks`), so A alone makes a second tab or a
future MCP writer safe.

And B is not a page-editor property at all. `optimistic-mutation`'s whole model is

```
data = pendingOps.reduce(apply, serverTruth)
```

— an **ordered fold**. A consumer whose ops don't commute needs the server to
apply them in the same order, or server truth diverges from the prediction. The
primitive already says so, in the comment on its failed-op retry drain
(`use-optimistic-resource.ts:449`):

> Ordering is load-bearing: structural ops depend on their predecessors'
> server-side effects (a second split targets the block the first one created),
> so a concurrent replay can land out of order and be durably rejected for a row
> that is merely not committed YET.

It enforces that on the **retry** path and not on **first dispatch**. The page
editor's chain is that missing half, written one layer too high. Ordering goes
into the primitive.

---

## Stage 1 — the forest write chokepoint (invariant A)

### 1a. One minter, one brand

`server/internal/page-forest.ts` replaces `page-write-lock.ts` (the FNV-1a key
derivation and the `pg_advisory_xact_lock` class constant move across verbatim —
that part is correct and stays).

```ts
declare const forestTx: unique symbol;
/** A transaction proven to hold the write lock on the pages it names. */
export type PageForestTx = RankExecutor & { readonly [forestTx]: true };

export interface PageForestCtx {
  readonly tx: PageForestTx;
  /** The scoped page rows, loaded under the lock. Memoized; lazy, so a
   *  delete/purge over many pages pays for no forest it never reads. */
  forest(): Promise<BlockRow[]>;
  /** Work that must NOT hold the lock (re-push, reindex, notify fan-out). */
  afterCommit(cb: () => void | Promise<void>): void;
}

export async function withPageForest<T>(
  pageIds: string | string[],
  fn: (ctx: PageForestCtx) => Promise<T>,
): Promise<{ value: T; watermark: string }>;
```

`withPageForest` is the **only** producer of a `PageForestTx`. It opens the
transaction, takes one `pg_advisory_xact_lock` per page id **in sorted order** as
the transaction's first statements (deterministic order is what keeps two
multi-page writers — a cross-page `move`, a subtree delete spanning sub-pages —
from deadlocking), reads `currentTxId(tx)` inside the transaction so no handler
hand-rolls the ack token, commits, then drains the `afterCommit` queue.

The lazy `forest()` is what makes "the read is under the lock" true *by
construction*: there is no earlier point at which a handler could read.

### 1b. One writer module

`server/internal/forest-writer.ts` becomes the only module that names `_blocks`
in a mutation position. Every export requires the brand:

```ts
export function insertBlocks(tx: PageForestTx, rows: NewBlockRow[]): Promise<void>;
export function updateBlockFields(tx: PageForestTx, id: string, changes: BlockFieldChanges): Promise<void>;
export function deleteBlockRoots(tx: PageForestTx, ids: string[]): Promise<void>;
export function trashBlockRoots(tx: PageForestTx, ids: string[], entryId: string): Promise<void>;
export function untrashBlockRoots(tx: PageForestTx, ids: string[]): Promise<void>;

/** The op handler's whole write: reconcile before→after, persist the diff,
 *  dispatch the delete hooks over the AUTHORITATIVE set. */
export function writeForestTarget(ctx: PageForestCtx, before: BlockNode[], after: BlockNode[]): Promise<ForestWriteResult>;
/** The patch handler's whole write: rank-park, then the field-scoped columns. */
export function writeBlockPatch(ctx: PageForestCtx, patch: BlockPatch): Promise<ForestWriteResult>;
```

`writeBlockPatch` stays field-scoped — a "hand me the new forest" contract would
regress `BlockPatch` back into whole-row writes, the exact thing
[`2026-07-28-page-block-write-ownership.md`](./2026-07-28-page-block-write-ownership.md)
removed. Two write shapes, one locked context.

`parkRanks` and `recomputePageIdSubtree` take `PageForestTx` too: both permute
the non-deferrable `(parent_id, rank)` unique index, so neither is ever legal
unlocked.

### 1c. The two halves of enforcement

This mirrors the established pair — `plugins/database/lint/no-pool-await-in-transaction.ts`
names it in its own header ("*That transitive class is closed by a different
mechanism — making the executor a REQUIRED parameter … so the leak is a tsc error
rather than a runtime hazard*"):

- **Type — closes the transitive class.** A handler that opens a bare
  `db.transaction` holds a `RankExecutor`, not a `PageForestTx`, so every write
  helper it reaches for fails to compile. Threading is unforgeable: the brand can
  only have come from `withPageForest`.
- **Lint — closes the direct class.** A new rule
  `page-editor/no-adhoc-forest-write` (`plugins/page/plugins/editor/lint/`) flags
  `.insert(_blocks)` / `.update(_blocks)` / `.delete(_blocks)` anywhere but
  `forest-writer.ts`, so a future writer cannot skip the helpers by importing the
  table directly. AST-only and self-contained (contributed lint rule files cannot
  cross-plugin import — jiti can't resolve `@plugins/*`).

### 1d. Migrating the nine writers

Mechanical and uniform; each handler's body is unchanged apart from the wrapper:

```ts
// handle-move-block.ts — before
const out = await db.transaction(async (tx) => { … tx.update(_blocks) … });

// after — the destination page is locked too, so a cross-page move is atomic
// against both pages' op streams
const { value: out, watermark } = await withPageForest([params.pageId, destPageId], async (ctx) => {
  …
  await updateBlockFields(ctx.tx, id, changes);
  ctx.afterCommit(() => notifyStructuralChange(…));
});
```

Files: `handle-apply-block-op.ts`, `handle-patch-blocks.ts`, `handle-move-block.ts`,
`handle-bulk-move-block.ts`, `handle-turn-into-page.ts`, `handle-create-block.ts`,
`handle-update-block.ts`, `handle-delete-block.ts`, `trash-blocks.ts`
(`deleteBlocksSubtree` / `untrashBlocks` / `purgeTrashedPages`), `page-content.ts`
(`replacePageContent`), `forest.ts` (`insertForest`), `rank-park.ts`, `page-id.ts`.

Two bespoke defences **delete** as dead weight once the lock is universal:
`handleTurnIntoPage`'s re-read-children-inside-tx (its comment names the childless-seed
TOCTOU it was dodging) and `handleMoveBlock`'s rank-mint-inside-tx.

---

## Stage 2 — the delete hook sees what is actually deleted

`BeforeDelete(blockIds)` becomes `OnDelete(rows, tx)` in
`server/internal/document-hooks.ts`:

```ts
export interface BlockDeleteHook {
  onDelete: (
    /** AUTHORITATIVE — reconciled under the page lock, never predicted. */
    rows: readonly DeletedBlockRow[],   // { id, type, pageId, parentId }
    /** Read anything the cascade is about to destroy — on the TX, never the pool. */
    tx: PageForestTx,
  ) => Promise<AfterCommit | void> | AfterCommit | void;
}
```

Dispatched from `forest-writer.ts` inside the locked transaction, on exactly the
branch that really hard-deletes, exactly once. The pre-transaction unlocked
`loadPageBlocks` and `predictedDeletedRows()` in `handle-apply-block-op.ts:52-88`
are **deleted**, and with them the "the two can differ" caveat and the
run-hooks-only-if-no-page-row special case (the writer already knows which branch
it took).

The reason this is now possible at all: passing **rows** instead of **ids** is
what removes the hooks' need to be "before". All three contributors want one
fact — *which of these were page rows* — and each pays a DB round-trip for it
today:

| contributor | today | after |
|---|---|---|
| `pages/content-search` | `pageIdsAmong(blockIds)` on the pool | `rows.filter(r => r.type === PAGE_BLOCK_TYPE)` |
| `pages/history` | `select … where id in (…) and type = 'page'` | same, in memory |
| `page/links` | already a no-op | unchanged |

So the lock is held for **zero** extra I/O in practice. The `tx` parameter exists
so a future hook that genuinely needs pre-delete state from another table reads it
on the transaction — satisfying `database/no-pool-await-in-transaction` by
construction, instead of today's "run it outside and accept a stale set". Heavy
re-push work still goes in the returned after-commit callback, now run by
`withPageForest`.

`trash-blocks.ts`'s `runBeforeDelete` call sites (hard-delete branch, purge)
adopt the same signature; they already hold the rows.

---

## Stage 3 — ordering moves into `optimistic-mutation`

`useOptimisticResource` serializes `mutate` per **`(resource.key, paramsKey)`** —
a module-level lane registry keyed by the same params key `queryKeyFor` derives,
not a per-hook ref. (Per-instance was another latent hole: two mounted
`useServerBlockStore`s for one `pageId` had two independent chains.)

```ts
// today — ordered on retry, racing on dispatch
drainFailed()   → for (const id of opIds) await retryOp(id);   // ordered ✓
dispatch(vars)  → void runMutate(opId, vars);                  // races  ✗

// after — one send lane; dispatch, retry and the reconnect drain share it
dispatch(vars)  → void lane.enqueue(() => runMutate(opId, vars));
```

- **The lane is failure-proof.** It advances on settle, resolve or reject alike —
  a durably-rejected op must never wedge its successors (today's
  `.then(send, send)` property, preserved). `runMutate` still returns the true
  outcome for its own op, so classification, `failed`, `retry` and the
  never-revert policy are untouched.
- **The retry drain's `await` loop collapses into the lane**; its `network`
  early-stop semantics stay (the transport is down, later ops would fail
  identically).
- **Head-of-line blocking is real and invisible.** A slow write delays its
  successors' *wire* departure; the overlay renders every op instantly
  (never-revert), so the user sees nothing. If it ever does matter, the fix is
  batching — the op endpoint taking `ops: BlockOp[]` folded in order inside one
  `withPageForest` — not weakening the lane. Explicitly out of scope here.
- **The other consumers** (`config_v2/staging`,
  `conversations/…/queue`, `conversations/…/dependencies`) can only get slower,
  never wrong; none dispatches at a rate where a lane is a throughput concern.

`block-store.ts` then drops `writeChainRef` and its 20-line comment, and `mutate`
shrinks back to the honest thing:

```ts
mutate: (v) =>
  v.tag === "patch"
    ? fetchEndpoint(patchBlocks, { pageId }, { body: v.patch }).then((r) => ({ watermark: r.watermark }))
    : fetchEndpoint(applyBlockOpEndpoint, { pageId }, { body: v.op }).then((r) => ({ watermark: r.watermark })),
```

---

## Stage 4 — the bypassers join the stream

Four writers currently sit outside the pipeline. With Stage 3 done, "a page's
structural writes are one ordered stream" is only true once they join it.

**`move` / `bulkMove` / `bulkDelete` become real `BlockOp` kinds** and their
bespoke endpoints (`moveBlock` for the editor surface, `bulkMoveBlocks`,
`bulkDeleteBlocks`) retire — the same collapse paste and bulk-duplicate already
went through ("*Both the `/blocks/paste` and `/blocks/bulk-duplicate` endpoints
are deleted: one write path for a forest insert*", editor `CLAUDE.md`).

- `bulkMove` already has its client-side reducer (`planBulkMove`), and the editor
  `CLAUDE.md` already names promoting it to a real `BlockOp` as the next step.
- `move` must keep sending **positional intent**, never a rank: `page_blocks` has
  one `(parent_id, rank)` space that several live resources project disjointly,
  so only the server sees the true sibling set. So the op kind carries
  `{ blockId, parentId, targetId, zone }`, the client reducer mints a *predicted*
  rank for the overlay and the server's stays authoritative — exactly the
  agreement `split` and `paste` already run under.
- The `moveBlock` endpoint stays alive for the **Pages sidebar**, which is a
  different surface over a different (`docRank`) ordering space.
- Consequence, and a deliberate behaviour change: DnD becomes optimistic. The two
  `// eslint-disable … drag again to fix` comments go away with the bug they
  describe.

**Detached persist** (`composite-block-store.tsx:219`) POSTs `patchBlocks`
directly because a collapsed sub-page has no mounted feed to route through. Since
the lane registry is module-level, the write can join the collapsed page's own
lane with no mounted hook — `optimistic-mutation` exposes the minimal seam for
exactly that:

```ts
/** Enqueue a write onto a resource's send lane with no overlay — for a write
 *  whose surface is unmounted. Ordering holds; there is nothing to predict. */
export function enqueueResourceWrite(resource, params, fn: () => Promise<unknown>): Promise<unknown>;
```

**And the seam is closed behind a lint rule.** `page-editor/no-adhoc-structural-write`
flags `fetchEndpoint` / `useEndpointMutation` naming `applyBlockOpEndpoint` or
`patchBlocks` outside `web/block-store.ts` and `web/composite-block-store.tsx` —
so "there is no other way to write a page's structure" is a build failure, not a
convention.

---

## Files

| File | Change |
|---|---|
| `server/internal/page-forest.ts` | **new** — `PageForestTx` brand, `withPageForest` (sorted multi-page locking, lazy `forest()`, `afterCommit`, watermark); absorbs `page-write-lock.ts` |
| `server/internal/forest-writer.ts` | **new** — the only module that mutates `_blocks`; `writeForestTarget` / `writeBlockPatch` + the low-level helpers; dispatches `OnDelete` |
| `server/internal/page-write-lock.ts` | **deleted** (folded into `page-forest.ts`) |
| `server/internal/handle-*.ts`, `trash-blocks.ts`, `page-content.ts`, `forest.ts`, `rank-park.ts`, `page-id.ts` | route every write through `withPageForest` + `forest-writer` |
| `server/internal/document-hooks.ts` | `BeforeDelete(ids)` → `OnDelete(rows, tx)` |
| `pages/content-search`, `pages/history`, `page/links` `…/delete-hook.ts` | adopt `onDelete(rows, tx)`; drop their `pageIdsAmong` / page-type `SELECT` |
| `plugins/page/plugins/editor/lint/index.ts` | **new** — `no-adhoc-forest-write`, `no-adhoc-structural-write` |
| `optimistic-mutation/web/internal/use-optimistic-resource.ts` | module-level per-`(key, paramsKey)` send lane; dispatch/retry/drain share it; export `enqueueResourceWrite` |
| `page/editor/web/block-store.ts` | delete `writeChainRef`; `move`/`bulkMove`/`bulkDelete` become dispatched ops |
| `page/editor/web/composite-block-store.tsx` | detached persist via `enqueueResourceWrite` |
| `page/editor/core/block-ops.ts`, `core/endpoints.ts` | `move` (positional intent) / `bulkMove` / `bulkDelete` op kinds; retire the two bulk endpoints |

## Docs

- `plugins/page/plugins/editor/CLAUDE.md` — the "A burst of mutations in one
  turn" bullets currently describe the two mitigations as arrangements. Replace
  with the two invariants and their enforcement (`PageForestTx` is unforgeable;
  ordering is the primitive's, not the editor's), and state plainly that
  cross-writer safety is A's job because no causal order exists between writers.
- `plugins/primitives/plugins/optimistic-mutation/CLAUDE.md` — one section:
  *ops are an ordered fold, so their writes are an ordered stream*; the lane is
  per `(resource, params)`; dispatch and the retry drain are now one mechanism.
- `plugins/database/CLAUDE.md` — cross-reference `withPageForest` as the worked
  example of the branded-executor half of the `no-pool-await-in-transaction` pair.

## Verification

```bash
./equin build && ./equin check      # incl. the two new lint rules
bun test plugins/page/plugins/editor/core       # new move/bulkMove/bulkDelete reducer arms
bun test plugins/page/plugins/editor/server     # DB-fixture concurrency tests below
bun run test:dom plugins/primitives/plugins/optimistic-mutation
bun run test:dom plugins/page/plugins/editor    # structural-undo / block-selection must stay green
```

New deterministic tests — these are what make the regression *detectable*, since
both bugs are timing-dependent in the wild:

1. **Lost update, server** (`server/internal/page-forest.test.ts`, on the
   `db-test-fixture` throwaway DB): start two `withPageForest` calls on one page
   concurrently, each read-modify-writing a different column; assert both
   effects survive. Assert the same test **fails** against a bare
   `db.transaction` — i.e. it is testing the lock, not the DB.
2. **Delete-set agreement**: an `onDelete` hook records what it was handed;
   assert it equals the set the transaction actually removed, with a concurrent
   write racing the op.
3. **Lane ordering, client**
   (`optimistic-mutation/web/__tests__/use-optimistic-resource.test.tsx`):
   dispatch A then B with A's `mutate` stalled; assert B's `mutate` has not been
   called; settle A; assert B fires. Then the failure arm — reject A, assert B
   still fires (no wedge) and A lands in `failed`.

E2E (`plugins/page/plugins/editor/e2e/`), both zero-delay, no settles:

4. **`structural-write-order-verify.ts`** — type `- ` (markdown shortcut →
   `convertTo`) then immediately Enter; assert the tail block is a bullet in
   authoritative rows (`GET /api/pages/:pageId/blocks`), not just in the DOM.
5. **`structural-atomicity-verify.ts`** — Tab then Enter with zero delay; assert
   the indent survives in authoritative rows. This is the captured incident.
6. Regression: the existing `crdt-multitab-agent-verify.ts`,
   `paste-optimistic-verify.ts`, `split-typing-verify.ts`,
   `indent-caret-verify.ts` suite, plus a DnD pass (drag a block, drag a
   multi-selection) now that both are optimistic.

## Landing order

Four commits, each independently shippable and each leaving the tree green:

1. **Stage 1** — the chokepoint. Closes the lost-update class for all nine
   writers; the largest and highest-value diff.
2. **Stage 2** — the delete-hook contract. Removes the predicted/authoritative
   divergence and an unlocked full-page read per op.
3. **Stage 3** — ordering into the primitive. Retires `writeChainRef`; fixes
   every present and future consumer.
4. **Stage 4** — the bypassers. Makes the contract exemption-free, and closes it
   behind the lint rule.
