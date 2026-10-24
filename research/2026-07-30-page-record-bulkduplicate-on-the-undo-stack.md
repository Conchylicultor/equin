# Record `bulkDuplicate` on the unified undo stack

## Context

`bulkDuplicate` is the **last** editor mutation reachable from
`useBlockEditor()` that puts nothing on the shared undo stack. Cmd+Z after
hitting the selection bar's Duplicate button (or Cmd+D) consumes an *older*
history entry while the clones stay behind — the same bug just fixed for `paste`
and `bulkMove`
([`research/2026-07-30-page-record-paste-and-bulkmove-on-the-undo-stack.md`](./2026-07-30-page-record-paste-and-bulkmove-on-the-undo-stack.md)),
and the follow-up that plan explicitly deferred.

It was deferred for a reason that this plan removes rather than works around:
the duplicate path mints its row ids **server-side** (`insertForest`,
`server/internal/forest.ts:78-124`, whose comment says server-minting is exactly
what distinguishes it from paste), so there is no client-computed after-state to
invert. Recording asynchronously off the endpoint's `{rootIds}` response is not
an option — it would reintroduce the original bug in a narrower window, leaving
an interval where Cmd+Z still hits the wrong entry.

Second defect, same root cause: `bulkDuplicate` has **no optimistic overlay**
(`block-editor-context.tsx:899-905` is a bare `store.bulkDuplicate(ids)`), so
duplicating a large selection shows nothing until the round-trip plus the
live-state push land.

**The fix is the one paste already took**: mint ids client-side, make duplicate a
`BlockOp`, and route it through `dispatchOp` — the single path that records an
undo entry and builds an overlay. Two facts make this cheap:

- **`serializeForest(rows, rootIds)`** (`web/serialize-blocks.ts:10`) is already
  the client-side forest serializer used by *copy*, and its own doc comment
  admits it "mirrors the server's `serializeSubtree` so copy (client) and
  duplicate (server) produce the same shape". Duplicate ≡ copy + paste-after-each
  -source, so it should just call it.
- The memory store already implements client-minted duplicate end to end
  (`block-store.ts:312-341`), proving the algebra works client-side.

**Intended outcome.** Every mutation on the editor context records exactly one
undo entry, with no exceptions left. Duplicate becomes optimistic. The bespoke
`POST /blocks/bulk-duplicate` path, `BlockStore.bulkDuplicate`, and the *second*
forest serializer are deleted, so — as with paste — there is no longer a write
path that can silently skip recording.

**Non-goals** (explicitly out, listed as follow-ups at the end): selecting the
clones after duplicating, and deep-copying a duplicated sub-page's content.

---

## Part 1 — `duplicate` as a `BlockOp`

### 1a. The op (`core/block-ops.ts`)

A duplicate is N independent forest insertions — one per selection root, each
landing immediately after its own source. So the op carries **placements**, and
one op is one gesture is one undo entry:

```ts
/**
 * Duplicate a block selection: each placement clones one selection root's
 * subtree and lands it immediately after that root. Ids are minted CLIENT-side
 * (`withMintedIds`) for the same reason paste mints them — it is what lets both
 * sides plan the same rows and the client overlay the result immediately.
 *
 * No `parentId` on a placement, deliberately: a clone always lands after its
 * source, so the destination is never anchor-less. Keep it that way —
 * `translateOpForStore` only rewrites `parentId` for the kinds that have one, so
 * adding the field here would silently skip anchor translation.
 */
| { kind: "duplicate"; placements: { afterId: string; forest: IdentifiedBlock[] }[] }
```

plus its zod mirror next to the `paste` one (`block-ops.ts:204-209`).

**Reducer — extract the shared arm, do not copy it.** `applyPaste`
(`block-ops.ts:1076-1102`) already *is* "insert one identified forest at one
anchor". Lift its body verbatim into

```ts
function insertForestAt(
  blocks: BlockNode[],
  at: { forest: IdentifiedBlock[]; afterId: string | null; parentId?: string | null },
): BlockNode[]
```

then `applyPaste = insertForestAt(blocks, op)` and

```ts
function applyDuplicate(blocks, op) {
  return op.placements.reduce(insertForestAt, blocks);
}
```

with the `duplicate` arm added to the reducer switch (`block-ops.ts:480`).

**A dead anchor drops exactly its own placement, and that differs from paste on
purpose.** Paste refuses the *whole* op on a missing anchor because guessing
another parent would drop content the user never asked to place. A duplicate
placement names its destination explicitly and independently, so the fold's
natural per-placement identity (`insertForestAt` returns `blocks` unchanged when
`byId(afterId)` misses) is the right answer: the clone whose source was raced
away is dropped, the others land. All-or-nothing would be strictly worse — the
client's rows always contain every anchor (it built the op from them), so a
refusal can only ever fire server-side, where dropping N clones instead of 1 just
widens the never-confirming set. Document both sentences on `applyDuplicate`.

**Rank windows are order-independent** — verify this with a test rather than
trusting it. Folding `[A, B]` for adjacent sibling roots gives `A'` in
`(rank A, rank B)` and `B'` after `B`; folding `[B, A]` gives the same rows,
because a clone always lands strictly between its source and the source's next
sibling. So the placement array's order is not load-bearing for client/server
agreement (the array travels on the op and both sides fold it identically) — it
is chosen for determinism and a legible history only.

Export `inDocumentOrder` (`block-ops.ts:373`, currently private) and add it to
`core/index.ts`.

### 1b. Op wiring — one arm each, all in existing switches

| site | arm |
| --- | --- |
| `core/block-ops.ts` `opBlockIds` | `op.placements.flatMap((p) => p.forest.map((n) => n.id))` — ROOT ids only, the same deliberate under-approximation paste documents |
| `web/block-editor-context.tsx` `OP_LABELS` | `duplicate: "Duplicate blocks"` — the reason this is a distinct kind and not a `paste` with more placements: the history label is keyed by kind |
| `web/block-editor-context.tsx` `opFocusId` | `null`, for paste's reason — duplicate never moves the caret |
| `web/internal/optimistic-block-ops.ts` `buildOverlayOp` | share paste's helper (rename `buildPasteOverlayOp` → `buildForestOverlayOp`, still **not exported**): `{ kind: "create", ids: <same root ids as opBlockIds> }` |
| `web/internal/composition.ts` `resolveOpOwnerPage` | `singleOwnerPage(rows, op.placements.map((p) => p.afterId))` — preserves today's cross-page refusal byte-for-byte (see 2b) |
| `web/internal/composition.ts` `translateOpForStore` | **none** — placements carry no `parentId` |

The server needs **nothing**: `handleApplyBlockOp` is generic over `BlockOp.kind`
and persists the reducer's diff.

### 1c. The provider (`web/block-editor-context.tsx:899`)

```ts
const bulkDuplicate = useCallback(
  (ids: string[]) => {
    if (ids.length === 0) return;
    const before = rowsRef.current;
    // Document-ordered for determinism and to match every other selection-driven
    // op (the folds, `pasteAnchorId`) — `selectionRoots` preserves input-ARRAY
    // order, which is nobody's order. Not load-bearing for agreement: the array
    // travels on the op, so both sides fold it identically.
    const roots = inDocumentOrder(toNodes(before), selectionRoots(before, new Set(ids)));
    if (roots.length === 0) return;
    // One `serializeForest` call PER root, not one zipped call: a filtered
    // positional array is exactly the silent-desync hazard the paste op's
    // "ids ride the node" rule exists to prevent.
    dispatchOp({
      kind: "duplicate",
      placements: roots.map((id) => ({
        afterId: id,
        forest: withMintedIds(serializeForest(before, [id])),
      })),
    });
  },
  [dispatchOp],
);
```

`serializeForest` is same-plugin (`../serialize-blocks`), so no barrel change.

**Return type changes from `Promise<string[]>` to `void`**, for paste's reason:
`dispatchOp` correctly drops an op whose reducer diff is empty, so "the ids that
were created" would be a lie in exactly the case a caller would want to know
about (an absorbed failure). Both call sites already discard it —
`block-editor.tsx:1102` and `:556-559`, where `duplicate: (ids) => void
bulkDuplicate(ids)` collapses to `duplicate: bulkDuplicate` and its comment is
deleted. Update the context signature at `:294`.

---

## Part 2 — Delete the server duplicate path

This is the structural half. With no server forest serializer and no
`bulkDuplicate` on the `BlockStore` seam, a duplicate can only reach the pipeline
through `dispatchOp`.

### 2a. Deletions

| file | delete |
| --- | --- |
| `server/internal/handle-bulk-duplicate-block.ts` | whole file |
| `server/index.ts` | its import (`:15`), the `bulkDuplicateBlocks` import (`:33`), the route entry (`:68`) |
| `core/endpoints.ts` | `BulkDuplicateBlocksBodySchema` + type (`:67-72`), `bulkDuplicateBlocks` (`:177-181`) |
| `core/index.ts` | the three `BulkDuplicate*` export lines (`:18`, `:25`, `:34`) and `serializeSubtree` from `:94` |
| `core/block-forest.ts` | `serializeSubtree` (`:23-36`) — loses both callers |
| `server/internal/forest.ts` | the `serializeSubtree` adapter (`:74-76`) + its `serializeSubtreeCore` import (`:8`); **check `rankWindow`'s server export for the same fate** — if `handle-bulk-duplicate-block.ts` was its last server caller, delete it too |
| `web/block-store.ts` | the `bulkDuplicate` interface member (`:112`), both implementations (`:197-207`, `:312-341`), both object entries (`:217`, `:353`), the `bulkDuplicateBlocks` / `serializeSubtree` imports (`:36`, `:40`) |
| `web/composite-block-store.tsx` | routed `bulkDuplicate` (`:276-281`), memo entry + dep (`:297`, `:299`), and `singleOwnerPage`'s import if it goes unused there |

Comment rewrites the deletions force:

- **`insertForest` (`server/internal/forest.ts:78-96`) is now the HISTORY-RESTORE
  path only** — `replacePageContent` (`server/internal/page-content.ts:177`) is
  its sole remaining caller, and it genuinely mints server-side (a restore has no
  client prediction to agree with). Rewrite the "Server-minted ids are what makes
  this the DUPLICATE path" paragraph, which is now false.
- **`web/serialize-blocks.ts`** — drop "Mirrors the server's `serializeSubtree`";
  it is now *the* forest serializer, shared by copy and duplicate.
- **`web/block-store.ts:230-235`** — clause (b) ("`bulkDuplicate` can resolve its
  new root ids SYNCHRONOUSLY") dies with the method; keep clause (a), which is
  still the reason `rowsRef` exists.
- **`server/internal/parent-liveness.test.ts:10`, `:154`** — the insert
  chokepoint's caller list no longer includes bulk-duplicate. (No guard is lost:
  `loadPageBlocks` returns live rows only, so a trashed anchor is simply absent
  and `insertForestAt` drops that placement — the op path's own equivalent, the
  same one paste already relies on.)

### 2b. Equivalence, verified

| case | old path | new path |
| --- | --- | --- |
| clone position | `rankWindow(rows, root.parentId, root.id, ∅)` in `handle-bulk-duplicate-block.ts:30` | the same `rankWindow` call inside `insertForestAt` |
| roots | `selectionRoots(rows, ids)` server-side | `selectionRoots` client-side, document-ordered, riding the op |
| page scope | `computePageId(root.parentId, tx)` | `insertScopePageId(blocks, parentId)` in the shared arm — paste's rule |
| cross-page selection | `singleOwnerPage` throws (`composite-block-store.tsx:278`) | `singleOwnerPage` throws in `resolveOpOwnerPage` — same helper, same message |
| memory mode | bespoke `useMemoryBlockStore.bulkDuplicate` | the reducer, via `dispatch` — strictly fewer code paths |

One **deliberate behavior change**, worth knowing before review: in the composite
(expanded sub-page) case the union rows contain the sub-page's children, so
`serializeForest` clones them where the server's page-scoped `loadPageBlocks`
could not. That makes duplicate agree with **copy**, which already serializes the
same union rows — i.e. duplicate ≡ copy+paste becomes true where it was quietly
false. A collapsed sub-page still clones as a bare page row (see the follow-ups).

---

## Part 3 — Tests

**`core/block-ops.test.ts`** — new `describe("duplicate")` beside the existing
`describe("paste")` (`:1141`):

- one root: the clone lands immediately after its source, subtree cloned whole,
  `expanded` preserved, every id fresh;
- two **adjacent sibling** roots: order is `A A' B B'` with no rank collision —
  the case the old server comment claimed and nothing tested;
- **placement order does not change the result**: shuffle the array, assert an
  identical structure (the order-independence claim in §1a);
- a placement whose `afterId` is absent drops **only** its own clone;
- a `type="page"` root scopes its cloned descendants to the clone's own id
  (`planForestInsert`'s page rule);
- empty `placements` → identity;
- `paste` still behaves identically after the `insertForestAt` extraction (the
  existing paste cases are the regression net — do not touch them).

**`web/serialize-blocks.test.ts`** (new, `bun:test`, next to source) — move the
`serializeSubtree` describe and the `planForestInsert` round-trip out of
`core/block-forest.test.ts:233-270` and retarget them at `serializeForest`, so
deleting the dead serializer costs no coverage.

**`web/__tests__/structural-undo.test.tsx`** — add `bulkDuplicate` to the
`RECORDED` table (`:222-253`); it now fits the table's `(h) => void` shape
directly. Delete the exclusion clause in the file header (`:5`). The table's
quadruple is what proves the fix: forward changed the rows, `canUndo` flipped,
undo restores exactly, redo reproduces.

**`e2e/duplicate-verify.ts`** (new). First extract `checkSelectionOwnsFocus` and
`enterBlockSelection` from `e2e/copy-paste-verify.ts:83-107` into
`e2e/support/` — `block-selection-verify.ts` open-codes the same dance, so the
helper is genuinely shared. Phases:

- **A** Cmd+D on a single block → exactly one clone, immediately after it;
- **B** a multi-root selection including a parent with a child → subtrees cloned,
  each clone after its own source;
- **C** Cmd+Z removes exactly the clones and nothing else (the reported symptom's
  inverse);
- **D** Cmd+Shift+Z restores them;
- **E** **optimism**: stall `**/api/pages/*/blocks/op` for 4s (the recipe in
  `e2e/paste-optimistic-verify.ts`) and assert the clones render long before the
  server could answer, that exactly one op POST fires, and that the confirming
  push neither duplicates nor drops them.

---

## Part 4 — Docs

`plugins/page/plugins/editor/CLAUDE.md`:

- **"Undo / redo"** — delete the `bulkDuplicate` sentence from *"Not recorded"*
  (only `setExpanded` and `projectText` remain); add duplicate to *"What is
  recorded"*; update the guardrail sentence naming what
  `structural-undo.test.tsx` covers.
- **"Paste is an op"** — the bullet *"`insertForest` is the DUPLICATE path only"*
  is now false. Replace it with: `insertForest` is the **history-restore** path
  only; duplicate is an op sharing paste's reducer arm (`insertForestAt`); a
  duplicate placement's dead anchor drops that placement while paste's refuses
  the whole op, and why; one forest serializer (`serializeForest`) now serves
  both copy and duplicate.

`docs/plugins-details.md` / `plugins-compact.md` regenerate via
`./equin build` (the deleted route disappears from the plugin reference).

---

## Verification

1. `./equin build`
2. `bun test plugins/page/plugins/editor/core/block-ops.test.ts`,
   `.../core/block-forest.test.ts`, `.../web/serialize-blocks.test.ts`
3. `bun run test:dom plugins/page/plugins/editor` — the per-mutation quadruple,
   now including `bulkDuplicate`
4. `bun plugins/page/plugins/editor/e2e/duplicate-verify.ts` (new)
5. `bun plugins/page/plugins/editor/e2e/copy-paste-verify.ts` and
   `paste-optimistic-verify.ts` — paste must be unchanged by the
   `insertForestAt` extraction, and still optimistic
6. `bun plugins/page/plugins/editor/e2e/block-selection-verify.ts` — the
   extracted selection helper
7. Manual at `http://<worktree>.localhost:9000/pages`: three blocks → select two
   → Duplicate → clones appear **instantly** → Cmd+Z removes exactly the clones
   → Cmd+Shift+Z restores them. Repeat with a parent+child selection, in memory
   mode (the website `editor-toy` demo), and inside an expanded nested page.
8. Page version history still restores (the one surviving `insertForest` caller).
9. `./equin check`

---

## Follow-ups to file (`add_task`), not this plan

- **Select the clones after duplicating** (Notion's behavior). Ids are now minted
  client-side and known synchronously, so this is a couple of lines — but it is a
  UX change, not an undo fix.
- **Duplicating a *collapsed* sub-page clones a bare page row**, not the page's
  content. Pre-existing (the old server path did the same), and now visibly
  inconsistent with the expanded case, which does clone the children. The honest
  fix is a server-side deep page copy behind `Editor.TurnInto`-style handling.
- **The clone's text can trail the original by up to ~1s** — it is seeded from
  `data.text`, which the CRDT projection debounces. Pre-existing and unchanged by
  this plan; the fix is to seed the clone's content doc from the source's LIVE
  runs (`BlockFocusHandle.readRuns`) rather than the projected row.
