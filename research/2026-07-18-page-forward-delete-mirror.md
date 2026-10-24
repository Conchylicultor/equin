# Forward Delete as Backspace's mirror (page editor)

## Context

`web/internal/keystroke-intent.ts` resolves every caret-affecting keystroke to a
`KeyIntent`. `KeystrokeKey` covers `Enter | Backspace | Tab | Arrow*` — **the
forward `Delete` key is absent entirely**. So Delete at the END of a block dies
at the boundary: the next visible line is never pulled up, and the ladder that
`CLAUDE.md`'s visible-line section documents has no counterpart on the right-hand
side of the caret. Listed as an explicit out-of-scope follow-up in
[`research/2026-07-18-page-visible-line-invariants.md`](./2026-07-18-page-visible-line-invariants.md).

Intended outcome: Delete-at-end merges the next visible line into the current
block, and the visible-line duality becomes **total** rather than half-drawn.

## The invariant

The existing statement, extended:

> **Backspace** deletes the nearest visible thing to the LEFT of the caret:
> marker glyph (convertTo) → indentation (outdent) → line break (merge) →
> boundary (nav-left).
>
> **Delete** deletes the nearest visible thing to the RIGHT of the caret:
> the line break below (merge the next visible line up) → boundary (nav-right).

**Delete's ladder is deliberately one rung, and that is not an omission.**
Backspace's ladder is long only because the *current* block's own marker and
indentation sit physically between the caret and the line break above it. To the
right of a caret at end-of-line, nothing sits between it and the line break — the
next block's marker and indent are *after* that break, so they are not nearer.
Anyone later tempted to "complete" Delete's ladder with a `convertTo`/`outdent`
rung would be making Delete take three presses to remove one line break, which no
editor does. This reasoning goes in `CLAUDE.md` so the asymmetry reads as a
derivation, not a gap.

## Why this needs a reducer change

Delete-at-end of X ought to be exactly Backspace-at-start of the next visible
line — same op, opposite originating block. That identity holds **only if**
`prevVisibleLine(nextVisibleLine(X)) === X` for every X. Today it does not:

`core/block-ops.ts:168` — `prevVisibleLeaf` walks *sideways-then-down*
(prev sibling → its deepest last expanded descendant) and returns `null` when the
node has no previous sibling. It has **no upward branch**. So for an expanded `X`
with first child `C`, `prevVisibleLeaf(C)` is `null`, not `X` — the duality fails
precisely at the case users hit constantly (Delete at the end of a parent bullet).

This is a genuine incompleteness in a helper named for the visible-line model, not
a new requirement. It is unreachable today only because Backspace gates `merge`
behind `hasPrevSibling`, so the missing branch is never taken.

## Changes

### 1. `core/block-ops.ts` — complete the duality

- **Rename `prevVisibleLeaf` → `prevVisibleLine`** and add the upward branch: no
  previous sibling ⇒ return the parent node (`byId(blocks, node.parentId)`), or
  `null` at the forest root. "Leaf" is wrong once it can return a parent.
  Call sites: `core/index.ts:48`, `applyMerge` (`:460`), `block-editor-context.tsx:16,1047`,
  `core/block-ops.test.ts`, plus `CLAUDE.md` prose.
- **Add `nextVisibleLine(blocks, node)`** — the dual, and the first such helper in
  the repo (`rg nextVisible` is currently empty):
  ```ts
  // first visible child, else the nearest following sibling walking up
  if (node.expanded) { const kids = childrenOf(blocks, node.id); if (kids[0]) return kids[0]; }
  let cur: BlockNode | null = node;
  while (cur) {
    const sib = nextSibling(blocks, cur);
    if (sib) return sib;
    cur = cur.parentId ? byId(blocks, cur.parentId) : null;
  }
  return null;
  ```
  Both stop naturally at a page boundary: a sub-page's subtree lives in another
  `page_id` partition and is simply absent from `blocks`.

- **`applyMerge` — adopted children take the merged block's visible slot.**
  Today adoption always appends after the target's existing children. Correct when
  the target is the previous sibling's deepest leaf (nothing of the target's
  follows), **wrong** when the target is the merged block's own parent: `S`'s
  children would land after `S`'s former next siblings instead of in `S`'s place.
  The general rule is one sentence — *adopted children occupy the visible position
  the merged block occupied* — so branch the rank minting:
  - `target.id === S.parentId` (the new upward case; `S` is therefore the first
    child) → `Rank.nBetween(null, nextSibling(S)?.rank ?? null, n)`.
  - otherwise → today's `Rank.nBetween(lastPrevKid, null, n)`, unchanged.

  The existing `PAGE_BLOCK_TYPE` refusals both still apply and now also cover
  "the parent is the page row".

### 2. `web/internal/keystroke-intent.ts` — the Delete case

- `KeystrokeKey` gains `"Delete"`.
- `KeyIntent` gains `{ type: "mergeNext" }`. Kept distinct from `merge` rather than
  parameterised, because the two differ in *which block is the source*, and the
  resolver stays a pure decision (it does not resolve ids).
  ```ts
  case "Delete": {
    if (!caret.atEnd || !caret.collapsed) return { type: "passthrough" };
    // Nearest visible thing to the RIGHT of a caret at end-of-line is the line
    // break itself — the next block's marker/indent sit AFTER it. One rung.
    if (!nextVisibleLine(ctx.nodes, node)) return { type: "nav", dir: "right" };
    return { type: "mergeNext" };
  }
  ```
- The boundary rung is `nav right`, the exact mirror of Backspace's `nav left` →
  page title. It resolves to whatever `<BlockEditor caretAfter>` offers (nothing
  today), and the keystroke is still consumed — no new branch in the resolver, per
  the `CaretSurface` rule.

### 3. `web/block-editor-context.tsx` — one merge implementation, two entry points

Extract today's `merge` body into an internal `mergeBlock(sourceId, runs)`; the
target is `prevVisibleLine(nodes, source)` as it already is. Then:

- `merge({ runs })` → `mergeBlock(blockId, runs)` — Backspace, byte-identical
  behavior.
- `mergeNext()` (new on `BlockEditorAPI`) → resolve `next = nextVisibleLine(...)`,
  read its live runs, `mergeBlock(next.id, runs)`. By the completed duality the
  target resolves back to this block, so the append lands in the currently-focused
  editor and the caret sits at the join offset — i.e. it does not move, which is
  what forward-delete must do. Free from the existing code path.

Everything downstream is reused unchanged: the microtask-deferred append-first
ordering, `captureBlockDocEdit`, `recordStructuralWithDocEdit`, and
`undoTextOverride` (already keyed to the *source* block, which is now the next
block — correct without edit).

### 4. `BlockFocusHandle` — the missing read

`mergeNext`'s source is a *different* block, and the handle exposes only writes
(`truncateAt`, `appendRunsAtEnd`). Add the symmetric member:

```ts
/** Serialize this block's LIVE runs (the read dual of `appendRunsAtEnd`). */
readRuns?: () => RichText;
```

Implemented in `web/components/block-text-editor.tsx:138` as
`() => serializeBlockRuns(editor)` — the same call `keyboard-plugin.tsx` already
makes for split/convertTo/merge, just reachable from outside the block's own tree.

Falling back to `runsOfNode(next)` (the ≤1s lagged `data.text` projection) would
silently drop text typed in the next block moments earlier — an absorbed failure.
So `readRuns` is used whenever the handle exists. It legitimately does not for
**text-less blocks** (divider, image, file, embed register no handle at all), where
`runsOfNode` returning empty runs is the true answer, not a fallback.

### 5. `web/components/keyboard-plugin.tsx` — wiring

- Register `KEY_DELETE_COMMAND` at `COMMAND_PRIORITY_HIGH` alongside the others
  (`rg` confirms nothing handles it today, so there is no priority contest).
- `execute()` gains `case "mergeNext": event.preventDefault(); api.mergeNext(); return true;`
  — no `serializeBlockRuns` here, since the runs come from the *other* block.

## Decisions to pin with tests

- **Delete before a text-less block deletes it** (divider, image, …): it is the
  next visible line, so it merges — i.e. vanishes — and the combined stack entry
  makes it a single Cmd+Z. Consistent with merge's existing semantics rather than
  a special case.
- **Delete before a sub-page row is a consumed no-op**: `applyMerge` already
  refuses `PAGE_BLOCK_TYPE` (deleting a sub-page from one keystroke), and
  `dispatchOp` drops the empty diff. The resolver cannot check this — it never
  names a block type — so the refusal stays in the reducer, matching Backspace.
- **Delete on an empty block** merges the next line up and loses that line's
  *type*. No special case; standard forward-delete.

## Files

| File | Change |
| --- | --- |
| `plugins/page/plugins/editor/core/block-ops.ts` | rename + upward branch, `nextVisibleLine`, `applyMerge` adoption slot |
| `plugins/page/plugins/editor/core/index.ts` | barrel: rename, export `nextVisibleLine` |
| `plugins/page/plugins/editor/web/internal/keystroke-intent.ts` | `Delete` key, `mergeNext` intent |
| `plugins/page/plugins/editor/web/block-editor-context.tsx` | `mergeBlock` extraction, `mergeNext`, `readRuns` on the handle interface |
| `plugins/page/plugins/editor/web/components/block-text-editor.tsx` | implement `readRuns` |
| `plugins/page/plugins/editor/web/components/keyboard-plugin.tsx` | `KEY_DELETE_COMMAND`, `mergeNext` case |
| `plugins/page/plugins/editor/CLAUDE.md` | extend the visible-line section |

## Tests

`core/block-ops.test.ts`:
- `prevVisibleLine` upward branch (first child → parent; forest root → null);
  existing assertions carry over under the new name.
- `nextVisibleLine`: first visible child / collapsed parent skips its subtree /
  next sibling / uncle via the upward walk / last line → null.
- **Duality property** over the existing fuzz forest:
  `prevVisibleLine(nextVisibleLine(X)) === X` for every X that has a next line.
  This is the load-bearing test — it is what makes `mergeNext` correct without a
  new op.
- `applyMerge` into a parent: text joins, adopted grandchildren land **before**
  the merged block's former next siblings.
- Round-trip: `split ∘ forward-delete-at-the-join` restores the forest
  structurally, alongside the existing `split ∘ merge` property.

`web/internal/keystroke-intent.test.ts` (mirror the `Backspace` describe):
- new `describe("Delete")`: not-at-end → passthrough; range selection →
  passthrough; at end with a next line → `mergeNext`; last visible line →
  `nav right`.
- a `trajectories` entry: repeated Delete on a block with children flattens the
  subtree one line per press, terminating at `nav right`.

## Verification

1. `bun test plugins/page/plugins/editor` — pure reducer + resolver suites,
   including the duality property.
2. `./equin build`, then at `http://att-1784374536-jx66.localhost:9000/pages`,
   drive a real page with `bun e2e/screenshot.mjs` (or a scripted Playwright run):
   - caret at end of a bullet with sub-bullets → Delete → first child's text joins,
     its own children take its slot in order;
   - caret at end of a block followed by a sibling → Delete → sibling merges up,
     **caret does not move**;
   - Cmd+Z restores rows *and* the target's content doc in one press (this is the
     combined-entry path, worth checking explicitly);
   - Delete on the last visible line does nothing and does not scroll or blur.
3. `./equin check` — `type-check` and the doc/boundary checks, since `core/index.ts`
   exports change.
