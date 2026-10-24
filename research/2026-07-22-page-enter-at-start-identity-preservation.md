# Page editor: Enter-at-start preserves the block's identity (insert empty ABOVE)

## Context

Pressing **Enter at the very start of a block** in the page editor today does the
Notion-violating thing: the origin block is emptied and **all** its text — and,
since the visible-line adoption rule, all its children — move to a freshly-minted
`newId`. The origin's per-block CRDT content doc is truncated to empty, a brand-new
doc is minted for `newId`, and focus jumps to `newId`. So the text's **block id
changes**, which churns every block-id-keyed thing: the content-doc registry
(`block id ⇒ Y.Doc` identity), the undo focus routing, and — in principle — any
future block-id anchor.

Notion's model is identity-preserving: Enter at the start of a line inserts an
**empty sibling ABOVE** and leaves the line itself untouched, caret staying with
the text. This was called out as the out-of-scope follow-up in
[`research/2026-07-18-page-visible-line-invariants.md`](2026-07-18-page-visible-line-invariants.md)
(line 12) and is what this plan implements.

**Intended outcome:** Enter at position 0 of a **non-empty** block inserts a new
empty sibling immediately above, and the origin block keeps its id, full text,
children subtree, content doc, expanded state, and data — completely untouched.
The caret stays in the origin at offset 0. Empty-block Enter (nothing after the
caret) keeps today's behavior (new empty block **below**, caret moves down).

## The discriminator

`op.position === 0 && afterRuns.length > 0` isolates exactly the target case:
- `splitRuns(runs, 0)` gives `beforeRuns = []`, `afterRuns = coalesce(all runs)`, so
  `afterRuns.length > 0` ⇔ "the block has non-empty plain text". (Equals
  `runsLength(runs) > 0` at position 0.)
- **Empty-block Enter** → `afterRuns` empty → falls through to today's behavior.
- **Mid/end split** (`position > 0`) and **`asChild`** → unchanged.

No new op field: `position` + `runs` are already on the op, so the reducer derives
the whole behavior from state (matching the codebase's "derive in the reducer, don't
carry intent flags" rule — the adoption rule works the same way).

## Changes

### 1. Reducer — `plugins/page/plugins/editor/core/block-ops.ts` (`applySplit`)

Add an **early return** right after `splitRuns` (after line 394, before `let next = blocks`).
Helpers `prevSibling` (:155), `add` (:272), `asObject` (:224), `Rank`, `RichText` are
all in scope.

```ts
const runs = op.runs ?? runsOfNode(block);
const [beforeRuns, afterRuns] = splitRuns(runs, op.position);

// Enter at the START of a NON-EMPTY block: preserve the origin's identity.
// Insert a NEW EMPTY sibling immediately ABOVE and leave the origin completely
// untouched (id, full text, children subtree, content doc, expanded, data). The
// caret stays in the origin at offset 0 (the executor's job). Notion's model —
// and it keeps the text's block id stable, so block-id-keyed state never churns.
// `afterRuns.length > 0` isolates this from EMPTY-block Enter (position 0 but
// nothing after the caret), which must keep spawning a plain empty sibling BELOW
// with the caret moving down. asChild and mid/end splits are unaffected.
if (!op.asChild && op.position === 0 && afterRuns.length > 0) {
  const prev = prevSibling(blocks, block);
  const aboveRank = Rank.between(
    prev ? Rank.from(prev.rank) : null,
    Rank.from(block.rank),
  );
  const aboveNode: BlockNode = {
    id: op.newId,
    pageId: block.pageId,
    parentId: block.parentId,
    type: op.siblingType ?? block.type,      // siblingType is never set here; belt-and-braces
    data: { ...asObject(op.tailData !== undefined ? op.tailData : block.data), text: [] },
    rank: aboveRank.toJSON(),
    expanded: false,
  };
  return add(blocks, aboveNode);              // origin's object reference returned untouched
}

let next = blocks;
```

- The origin is not `withRuns`-ed, not reparented, not re-`expanded` — its subtree
  stays put (children keep `parentId === block.id`).
- `data` inherits the origin's already-valid data with `text: []` and applies
  `tailData` when present, so a checked to-do yields an **empty unchecked** to-do
  above while the origin stays checked. Every block-type schema stays satisfied
  (`parseBlockData` at the server boundary is happy).
- First-child case (`prev === null`) → `Rank.between(null, block.rank)`, a valid rank
  before the origin as the new first child.

### 2. Executor / API — `plugins/page/plugins/editor/web/block-editor-context.tsx` (`makeBlockAPI().split`, :1080–1133)

The executor **must branch on the same condition** — focus and live-doc surgery live
outside the pure reducer. Crucially, without the branch the existing path would still
call `truncateAt(0)`, which deletes the origin's **entire live content doc**.

- Add `runsLength` to the `@plugins/.../core` import (block near :15–29).
- Add `recordStructural` to `makeBlockAPI`'s `useCallback` dependency array (:1214–1225)
  — the new path uses it (currently only `recordStructuralWithDocEdit` is listed).
- Branch inside `split()` before the existing focus/doc/record logic:

```ts
const asChild = opts?.asChild ?? false;
const newId = crypto.randomUUID();
const op: BlockOp = { kind: "split", blockId, position, newId, asChild,
  childType: opts?.childType, siblingType: opts?.siblingType,
  tailData: opts?.tailData, runs: opts?.runs };

// Enter at the START of a NON-EMPTY block: the reducer inserts an empty sibling
// ABOVE and leaves the origin untouched. The caret is already at offset 0 and
// never lost focus (the Enter keydown was preventDefaulted). So do NOT focusNew
// (would steal focus to the empty block), do NOT truncate the origin's doc
// (nothing moved out of it), and record a PLAIN structural entry whose undo/redo
// focus the ORIGIN. The empty block seeds a trivially-empty doc on mount, like insert.
if (!asChild && position === 0 && runsLength(opts?.runs ?? []) > 0) {
  const { before, after } = applyOverlay(op);
  recordStructural(before, after, OP_LABELS.split, blockId);   // focusId = origin
  return;
}

// --- existing path (mid/end split, empty-block Enter, asChild) unchanged ---
focusNew(newId);
const { before, after } = applyOverlay(op);
queueMicrotask(() => {
  const docEdit = captureBlockDocEdit(blockId, () =>
    focusHandlesRef.current.get(blockId)?.truncateAt?.(position));
  recordStructuralWithDocEdit(before, after, OP_LABELS.split, newId, docEdit);
});
```

**Focus/undo wiring needs no other edits.** `derivePatchEntry` over `before→after`
sees `inserted=[emptyAbove]`, so with `focusId = blockId`: `redoFocus = focusId → blockId`
(redo re-inserts the empty block, focus stays in origin); `undoFocus = undoPatch.upserts[0]?.id ?? focusId → blockId`
(undo deletes the empty block, origin survives — never `<body>`). `opFocusId` is not
consulted (split bypasses `dispatchOp`), so no change there. Do **not** route this
through `dispatchOp`.

`keyboard-plugin.tsx` needs no change — it already serializes live `runs` and
`api.split` is the sole split producer.

### 3. Content doc — no surgery (confirmed)

Origin's doc/registry entry/`Y.UndoManager` are untouched (the whole point). The new
empty block seeds an empty doc on mount, byte-identical to a gutter-`+` insert
(deterministic empty encoding, doc-init FK-gated on `serverIds`). Undo deletes the
empty block; its `page_block_docs` row FK-cascades — nothing lost. The pre-seed /
`SKIP_DOM_SELECTION_TAG` / `rootStart` split-focus machinery is simply not on this
path (origin is a pre-existing confirmed block that keeps DOM focus throughout).

### 4. Server — no change

Same `applyBlockOp` + `reconcileBlocks`: one inserted row (origin unchanged), handled
as an ordinary insert. `opBlockIds` stays `[blockId, newId]` (accurate: origin
named-but-unchanged, newId created).

## Tests

### `core/block-ops.test.ts`
- **Rewrite** the pin at **:341–355** (`"adoption: position-0 split leaves an empty head above; the tail carries the full text AND the children"`) — it asserts the old behavior. New test: position-0 split of a non-empty block inserts an empty sibling **above** (`ids(out, null) === ["NEW", "P"]`, NEW empty & childless), and the origin is untouched (**same object reference**, full text, `expanded`, children `["K1","K2"]`).
- **Add**: (a) empty-block position-0 split keeps empty-sibling-**below** (`["P","NEW"]`); (b) `tailData` case → empty unchecked to-do above, origin data literally unchanged (`{checked:true,text:"helloworld"}`); (c) first-child position-0 split → new **first child** under the parent.
- **BLOCKER — fix the two round-trip fuzz properties.** `split ∘ merge round-trip` (:1484) and `split then FORWARD-DELETE` (:1518) generate `position ∈ [0, len]` and, at position-0-nonempty, assert the tail is the origin's next visible line — now false. Change the generator so a **non-empty** block is never split at 0:
  ```ts
  const position = len === 0 ? 0 : 1 + Math.floor(rand() * len);
  ```
  Coverage of all mid/end positions and empty-block position-0 is preserved; the `rounds > 400` non-vacuity floors hold.
- **Add** the clean inverse property (the inverse of insert-empty-above is `delete newId`, restoring the forest byte-for-byte incl. ranks — a *merge* of newId would not, since it keeps the empty block and deletes the origin): ~200 seeds over `randomForest`, pick a non-empty non-page block, split at 0, assert `prevVisibleLine` of origin is the empty `RT` and `applyBlockOp(split, {kind:"delete", blockId:"RT"}) === rows`.
- The chain/property fuzz (:1341, :1440), the guard at :1370, and `expect(split).not.toBe(rows)` (:1408) need **no change** (verified — `add` returns a fresh array, strictly-ascending ranks, no mutation).

### `web/internal/keystroke-intent.test.ts`
Resolver is unchanged. Add one layering test: Enter at start of a non-empty block still resolves to `{type:"split", position:0, asChild:false}` (identity preservation is downstream).

### e2e — new `e2e/enter-at-start-verify.mjs` (model on `e2e/crdt-split-merge-verify.mjs`)
Observable = **block-id stability** (`data-block-id`): type `"hello world"`, capture `originId`, let the ~1s projection land; caret to offset 0 (click at `{x:2,y:12}` — Home/Cmd+Left don't work headless), press Enter; assert two blocks, the block still carrying `originId` holds `"hello world"` with marks intact, a new **empty** block precedes it in DOM order, caret collapsed in `originId` at offset 0; type a char → lands in `originId` (doc followed the id); `Cmd+Z` → empty block gone in one undo, focus back on `originId`, text intact; second browser context converges.

## Docs

- `plugins/page/plugins/editor/CLAUDE.md`, "Visible-line invariants (Enter / Backspace / Delete)": add a paragraph — Enter at start of a *non-empty* block inserts an empty sibling ABOVE and preserves the origin's identity (id/text/children/doc/data/expanded), caret staying put; the `afterRuns.length > 0` discriminator vs empty-block Enter; why (block-id-keyed state stability).
- Optional one-line "superseded by …" pointer in `research/2026-07-18-page-visible-line-invariants.md` (leave the historical model text as-is).

## Verification

1. `bun test plugins/page/plugins/editor/core/block-ops.test.ts` and `bun run test:dom plugins/page/plugins/editor` (after `./equin build` / `bun install`).
2. `./equin build` → app at `http://<worktree>.localhost:9000`.
3. `bun e2e/enter-at-start-verify.mjs` (new script above) — screenshots each step.
4. Manual smoke: type a paragraph, caret to start, Enter → empty line above, text (and any children) stay in the SAME block below with caret in it; Enter at start of a checked to-do → empty unchecked to-do above, original stays checked; Cmd+Z removes the empty line in one undo.

## Critical files

- `plugins/page/plugins/editor/core/block-ops.ts` — reducer early-return in `applySplit`.
- `plugins/page/plugins/editor/web/block-editor-context.tsx` — `split()` branch, `runsLength` import, `recordStructural` dep.
- `plugins/page/plugins/editor/core/block-ops.test.ts` — rewrite :341–355; fix positions :1484 & :1518; add tests + inverse property.
- `plugins/page/plugins/editor/web/internal/keystroke-intent.test.ts` — layering test.
- `e2e/enter-at-start-verify.mjs` (new) — modeled on `e2e/crdt-split-merge-verify.mjs`.
- `plugins/page/plugins/editor/CLAUDE.md` — invariant note.

## Risks

- **Round-trip fuzz breakage** (the real trap): without the :1484/:1518 position-generator fix the pure suite goes red even though the reducer is correct. Handled above.
- Empty-block Enter must stay unchanged — guarded by `afterRuns.length > 0`, pinned by a dedicated test.
- Both layers (reducer + executor) must branch on the same condition; the executor branch is load-bearing (skips the origin-doc `truncateAt(0)`), not just cosmetic focus.
