# Block editor: single authoritative tree-op reducer

> Status: plan / awaiting implementation
> Scope: **server-correctness fix only.** Define block tree operations once as a
> pure reducer and have the server compute structure from it. The client stays a
> fire-and-forget round-trip refreshed by the live `blocksResource` push. The
> reducer is written so it can later back the `optimistic-mutation` primitive's
> `apply` — but wiring optimistic prediction, the doc-level caret coordinator, and
> autosave-freeze are **out of scope** (separate follow-up).

## Context

The page block editor (`plugins/page/plugins/editor/`) implements every
structural keystroke as an ad-hoc single-row rank edit. Seven server handlers
(split, merge, indent, outdent, move, create, delete) each re-derive sibling and
rank math directly against the DB, and they have diverged. Result: structural
edits put blocks in the wrong place.

Symptoms (all reproduce today):
- **Outdent** a first/middle child sends it adrift instead of keeping its visual
  place, and its *following* siblings are **not** reparented under it (Notion
  reparents them as children of the outdented block).
- **Enter at the end** of a block that has **expanded children** inserts the new
  block *after the whole subtree* instead of as the **first child**.
- **Backspace at the start** of an **indented** block always **merges** into the
  previous block instead of **de-indenting** (outdenting) it. (At top level,
  backspace-at-start should still merge into the previous sibling.)

The root cause is architectural: tree math is re-derived in seven places. The fix
is to define the operations **once** as a pure reducer over the page's in-memory
`Block[]`, and have a single server endpoint load → apply → reconcile → notify.
Intended design recorded in
[`research/2026-06-09-global-optimistic-mutation-primitive.md`](./2026-06-09-global-optimistic-mutation-primitive.md)
("Follow-up sub-task" section).

## Design

### 1. Pure reducer — `core/block-ops.ts` (NEW)

A discriminated `BlockOp` union plus `applyBlockOp(blocks, op): BlockNode[]`,
pure (no DB, no `nextRankUnder`), operating on the full page block list
(including collapsed). New blocks carry **client-minted UUIDs** so client and
server compute identical results. Caret/focus is **not** part of the reducer.

```ts
export type BlockOp =
  | { kind: "split"; blockId: string; position: number; newId: string;
      asChild?: boolean; childType?: string }
  | { kind: "merge"; blockId: string }            // merge into prev sibling
  | { kind: "indent"; blockId: string }
  | { kind: "outdent"; blockId: string }
  | { kind: "insert"; newId: string; type: string; data?: unknown;
      afterId?: string | null; parentId?: string | null }  // afterId wins
  | { kind: "delete"; blockId: string }
  | { kind: "move"; blockId: string; parentId: string | null; rank: string };
```

- `BlockNode` = JSON-pure subset `{ id, pageId, parentId, type, data, rank: string,
  expanded }`. The server adapts rows ↔ nodes; `createdAt`/`updatedAt` stay out of
  the reducer (server stamps new rows during reconcile).
- `BlockOpSchema` (Zod discriminated union, `rank` as `z.string()`) lives in this
  file for server body validation.

**Shared helpers** (the single source of rank/tree math, replacing the ad-hoc SQL
in all 7 handlers):
- `childrenOf(blocks, parentId)` — filter by `parentId`, sort by
  `Rank.compare(Rank.from(a.rank), Rank.from(b.rank))`.
- `prevSibling` / `nextSibling` (rank-immediate neighbour among `childrenOf(parent)`).
- `byId`, `textOf(node)` (`typeof data.text === "string" ? data.text : ""`),
  `withText`, immutable `replace`/`remove`/`add`.
- `subtreeIds` (reuse the tree primitive), `isDescendant` for the move cycle guard.

**Per-op algorithms** (ranks computed purely with `Rank.between` / `Rank.nBetween`):

- **insert** — `afterId`: rank `between(after, nextSibling(after))`, inherit
  `after.parentId`. Else append under `parentId`: rank `between(lastChild, null)`.
  New node `expanded:false`, same `pageId`; open the parent if any.
- **split** — truncate original text to `before`; new node carries `after`.
  - `asChild` (resolved by the client, see §3): parent = block, type =
    `childType ?? block.type`, rank `between(null, firstChild)`, force
    `block.expanded = true`. → **fixes Enter-at-end-with-children → first child.**
  - else sibling: parent = `block.parentId`, type = `block.type`, rank
    `between(block, nextSibling(block))`.
- **merge** — `prev = prevSibling(block)`; if none, **no-op**. `prev.text =
  prevText + curText`. **Adopt children**: append `childrenOf(block)` under `prev`
  after `prev`'s existing children via `Rank.nBetween(lastPrevKid, null, n)`
  (order-preserving); set `prev.expanded = true` if any. Remove `block`.
- **indent** — `prev = prevSibling(block)`; if none, no-op. Reparent `block` under
  `prev`, rank `between(lastChildOf(prev), null)`, `prev.expanded = true`. Block's
  own subtree rides along via adjacency.
- **outdent** — `parent = byId(block.parentId)`; if none or
  `parent.type === PAGE_BLOCK_TYPE`, no-op. Block becomes sibling immediately after
  `parent`: rank `between(parent, nextSibling(parent))`, parent =
  `parent.parentId`. **Then reparent following siblings** (`childrenOf(parent)` with
  rank > block's original rank) as children of `block`, appended after block's
  existing children via `Rank.nBetween(lastExistingKid, null, n)` (order-preserving);
  `block.expanded = true` if any followers. → **fixes outdent place + Notion
  reparenting.** Capture `followers` and `existingKids` from the pre-move array
  before mutating.
- **delete** — drop the block and its full `subtreeIds`. (DB cascade + lifecycle
  hooks handled by the server, §2.)
- **move** (in-page) — set `parentId`/`rank` from the op (client computed via
  `computeDrop`); open new parent; cycle-guard with `isDescendant` (no-op on
  cycle). pageId unchanged. **Cross-page drag does not come here** (§ Boundary).

The reducer never changes a surviving node's `pageId` (in-page invariant) and
never mutates its input.

### 2. Single server endpoint + reconcile

Add `applyBlockOpEndpoint` in `core/endpoints.ts`:

```ts
export const applyBlockOpEndpoint = defineEndpoint({
  route: "POST /api/pages/:pageId/blocks/op",
  body: BlockOpSchema,
  response: z.object({ blocks: z.array(BlockSchema) }),
});
```

**Handler** `server/internal/handle-apply-block-op.ts` (NEW):
1. `rows = loadPageBlocks(pageId)` (reuse `forest.ts`).
2. `before = rows.map(rowToNode)`; `after = applyBlockOp(before, op)`.
3. `reconcileBlocks(before, after)` → `{ inserted, updated, deletedIds }` (NEW
   helper, `server/internal/reconcile.ts`): diff by id; `updated` = ids in both
   whose `parentId | rank | data | expanded | type` differ (deep-equal `data`).
4. **Deletes**: gather `deletedPages` (deleted nodes with `type === PAGE_BLOCK_TYPE`)
   and run `BlockLifecycle.BeforeDelete` contributions over the full deleted set,
   collecting after-callbacks — mirroring `handle-delete-block.ts:27-43`.
5. **Transaction**: insert `inserted` (stamp `createdAt`/`updatedAt`, `data ?? {}`),
   update changed columns per `updated` (+ `updatedAt`), delete subtree roots
   (`inArray`; FK cascade clears descendants).
6. **pageId**: in-page ops never change it → **skip** `recomputePageIdSubtree`
   (assert the invariant in a comment + reducer test).
7. **Notify once** via `notifyBlockChange({ pageId, type })` (emits `blocksChanged`
   + notifies `blocksLiveResource`); if `deletedPages.length > 0`, also
   `pagesLiveResource.notify()` per `handle-delete-block.ts:52-62`. Run
   after-callbacks (backlinks re-push) post-commit.

Wire the route in `server/index.ts`; **remove** the split/merge/indent/outdent
routes + handlers + endpoint defs (after `rg` confirms only the editor client
calls them).

### 3. Client — `web/block-editor-context.tsx` (+ `web/types.ts`)

Keep a simple round-trip (no `useOptimisticResource` in this task). One helper:
`dispatchOp(op) => void fetchEndpoint(applyBlockOpEndpoint, { pageId }, { body: op })`.

- **Id minting + focus**: `split` / `insert` / `insertAfter` mint
  `crypto.randomUUID()` *before* dispatch, set `pendingFocusRef.current = newId`,
  and try `focusHandlesRef.get(newId)?.focus()` — **no await** (id known up front;
  existing `registerFocusHandle` handles late mount).
- **`split` intent**: resolve `asChild` here using `rowsRef` — `block.expanded &&
  childrenOf(block).length > 0 && position === textLength` (merge with any
  contributor `opts.asChild`/`childType`). Keyboard plugin keeps calling
  `editor.split(offset, splitOptions)` unchanged.
- **`merge` intent (de-indent vs merge)**: look up block in `rowsRef`. If indented
  (non-page parent) → dispatch `{ kind: "outdent" }`, keep focus on the same block.
  Else if a prev sibling exists → `{ kind: "merge" }`, focus the prev sibling id.
  Else no-op. Keyboard plugin keeps calling `editor.merge()` unchanged.
- **`indent`/`outdent`/`remove`** build the obvious ops; optional client pre-guard
  to skip pointless requests (matches today's benign-400 swallow).

`BlockEditorAPI` signatures are unchanged; only internal behaviour + docs move.

### Boundary: what stays on its own endpoint

`moveBlock` (drag, **cross-page** via `recomputePageIdSubtree`), `bulkMove`,
`bulkDelete`, `bulkDuplicate`, `paste`, and the standalone `createBlock` /
`deleteBlock` (used by non-editor callers e.g. sidebar page delete) **stay as-is**:
they either cross page scopes or already use the shared forest helpers and are not
buggy. The reducer owns **single-block, in-page, keyboard/text-driven** edits. The
DnD client path keeps calling `moveBlock` so cross-page still works; the `move` op
variant exists for in-page/programmatic use and future reuse only.

## Files

**Add**
- `plugins/page/plugins/editor/core/block-ops.ts` — `BlockOp`, `BlockOpSchema`, `BlockNode`, `applyBlockOp`, helpers.
- `plugins/page/plugins/editor/core/block-ops.test.ts` — reducer unit tests.
- `plugins/page/plugins/editor/server/internal/handle-apply-block-op.ts` — reconcile handler.
- `plugins/page/plugins/editor/server/internal/reconcile.ts` — `reconcileBlocks` + `rowToNode`/`nodeToRow`.
- `plugins/page/plugins/editor/server/internal/reconcile.test.ts` — diff unit tests.

**Modify**
- `core/endpoints.ts` — add `applyBlockOpEndpoint`; remove `splitBlock`, `mergeBlocks`, `indentBlock`, `outdentBlock`.
- `core/index.ts` — export `applyBlockOpEndpoint`, `BlockOp`, `BlockOpSchema`, `applyBlockOp`; drop removed exports.
- `server/index.ts` — register op route; remove the 4 structural routes/imports.
- `web/block-editor-context.tsx` — rewrite `makeBlockAPI` structural methods (build/dispatch ops, mint ids, resolve split/merge intent via `rowsRef`).
- `web/types.ts` — doc updates (`merge` may de-indent; `split` derives `asChild`).
- `web/components/keyboard-plugin.tsx` — verify Enter/Backspace still call `split`/`merge` (no logic change).

**Delete** (after `rg` confirms editor-only usage)
- `server/internal/handle-split-block.ts`, `handle-merge-blocks.ts`, `handle-indent-block.ts`, `handle-outdent-block.ts`.

Reuse, don't reinvent: `Rank.between`/`nBetween`/`compare`/`from`
(`@plugins/primitives/plugins/rank/core`); `buildTree`/`isDescendant`/`subtreeIds`
(`@plugins/primitives/plugins/tree`); `loadPageBlocks` (`server/internal/forest.ts`);
`notifyBlockChange` (`server/internal/notify.ts`); `BlockLifecycle` +
`pagesLiveResource` patterns from `handle-delete-block.ts`.

## Verification

1. **Unit tests** (pure, fast; same style as `optimistic-mutation/.../overlay.test.ts`):
   - `applyBlockOp`: outdent reparents following siblings (order preserved,
     `expanded` set); outdent first-child-no-followers; outdent middle child;
     outdent at top level / under page → no-op; split-at-end-with-expanded-children
     → first child; split mid-text → sibling; split no-next-sibling; merge adopts
     children; merge no-prev → no-op; indent under prev sibling; indent no-prev →
     no-op; insert afterId vs append; delete subtree; in-page move + cycle guard
     no-op; rank ordering strictly ascending after each op; pageId invariant; input
     not mutated.
   - `reconcileBlocks`: insert-only, update-only (rank/parent/data/expanded), delete
     with subtree, split (1 update + 1 insert), no-op (equal arrays).
2. **Build**: `./equin build` (typecheck union + endpoint wiring + removed refs).
3. **E2E** via `e2e/screenshot.mjs` against `http://att-1781168874-9vey.localhost:9000`:
   - Enter at end of a block with expanded children → new block is first child.
   - Enter mid-text → sibling carrying trailing text.
   - Tab indents under prev sibling; Shift+Tab on a first/middle child with
     following siblings → keeps place AND followers become its children.
   - Backspace at start of an indented block → de-indents; at top level → merges
     (text concatenated) into previous sibling.
   - Delete a block with a subtree → whole subtree gone; a linked page's backlinks
     refresh (confirms `blocksChanged` + BeforeDelete hooks fired).

## Risks

- **Reducer/server divergence** — mitigated by sharing the *exact* same pure
  `applyBlockOp`; the server only diffs + persists, it does no tree math.
- **Lost lifecycle side-effects on delete** — the reconcile handler must replicate
  `BlockLifecycle.BeforeDelete`, `blocksChanged.emit`, and `pagesLiveResource`
  notify from `handle-delete-block.ts`; covered by the delete E2E (backlinks
  refresh).
- **`data` deep-equality in the diff** — text payloads are small; use stable
  JSON compare to avoid spurious updates.
- **Endpoint removal** — `rg` for `splitBlock`/`mergeBlocks`/`indentBlock`/
  `outdentBlock` importers before deleting; only the editor client should match.
