# Page editor: paste lands AT the insertion point (`splice` op)

## Context

Pasting `The plugin system⏎` into an empty block put the text in a NEW block
below, leaving the caret's block empty. The cause is structural. A transfer is
routed by its raw SHAPE (`decideTransfer`, `editor/web/internal/transfer.ts`):
text with no newline goes to Lexical's native inline paste; anything with a
newline becomes a block forest pasted AFTER the caret's block
(`BlockForestPastePlugin` → `paste({afterId: block.id})`). "Contains a newline"
is not the same as "carries structure", and "after this block" is not the same
as "at the caret". So every multi-line paste lands in the wrong place:

- empty line + `a⏎b` → an empty line stays above `a`, `b`;
- `foo|bar` + `a⏎b` → `foobar`, `a`, `b` (the text is not at the caret at all);
- dropping multi-line text into a block has the same bug through a separate
  door (`block-editor.tsx` `onExternalDrop`).

The interim fix in this worktree (`splitCaretPaste` + `selection.insertNodes`
followed by `paste`) fixes the empty-line and end-of-line cases only. It is two
edits (two undo entries, not atomic) and it cannot express a mid-line paste.
This plan replaces it.

**Target rule (the Notion model):**

> A forest pasted or dropped at an insertion point inside a block's text is
> SPLICED there: the text before the point keeps its line and absorbs the
> forest's leading paragraph; the text after the point goes to the end of the
> forest's last paragraph; everything else lands in between. One op, one undo
> entry, and client and server compute the same rows.

## The primitive: a `splice` BlockOp

New arm in `BlockOp` / `BlockOpSchema` (`editor/core/block-ops.ts`), reduced by
the shared `applyBlockOp`, so the web overlay and the server
(`server/internal/handle-apply-block-op.ts`) run the same code:

```ts
| {
    kind: "splice";
    blockId: string;          // the block holding the insertion point
    position: number;         // linear offset in `runs` (stored-runs basis)
    runs: RichText;           // LIVE runs of the block, the selected range already
                              // removed (`runsWithoutSpan`), like split's `runs`
    forest: IdentifiedBlock[];// ids minted client-side (`withPasteIds`), like paste
    tailId: string;           // pre-minted id for a tail line, used only if needed
  }
```

`applySplice(blocks, op, ctx)`, built from the reducer's existing pieces
(`splitRuns`, `mergeRuns`, `insertForestAt` / `planForestInsert`, and split's
child-adoption logic):

1. `[before, after] = splitRuns(op.runs, op.position)`.
2. **Head.** If `forest[0]` is a plain paragraph (the `defaultText` type from
   `blockOpContext`, with no children), its runs merge into the origin:
   `origin.text = before + head`, and it leaves the forest. Otherwise
   `origin.text = before`.
3. **Consume an empty origin.** If the origin ends up textless (empty `before`,
   no head merged), is the default-text type, and has no children, it is removed
   and the forest takes its slot. This is what makes pasting `# Title⏎body` into
   an empty line leave no blank line.
4. **Body.** The remaining forest is inserted where split would put its tail:
   the next sibling, or the first children when the origin has visible children
   and the point is at its end. Extract that placement from `applySplit` into
   one helper so the two ops cannot disagree.
5. **Tail.** If `after` is non-empty: when the last inserted root in document
   order is a childless plain paragraph, `after` is appended to it; otherwise a
   tail block `tailId` is minted of the origin's split-sibling type (the same
   `siblingType` / `tailData` rules as split) with `text: after`. The origin's
   visible children are adopted by the tail line, the same way split adopts
   them onto its tail.
6. If nothing remains after the head merge (a single-paragraph paste), the op
   is just a text edit of the origin, and it still goes through this op path.

Refusals are the same as split's (page row, anchor type) plus paste's (a missing
anchor refuses the whole op), so a refused splice is dropped by `dispatchOp`
before it reaches the network.

**Text.** This follows split's split between row and doc (see the live-path trace):
- Only the ORIGIN has a live Y.Doc. The client applies
  `origin: op.runs → before+head` as one surgery (`applyBlockRuns` /
  `$spliceRunsInto`) inside `owner.untracked`, and records it as `runsEdits` on
  the same entry.
- Every other row (inserted blocks, the tail) is new, and new rows are seeded from
  their creation `data.text`, so no doc surgery is needed there.
- The server writes rows only, exactly as it does for split today.

**Undo.** One `recordEntry` holds the structural patch plus the origin's
`runsEdits`, which `structural-undo` already replays. Removed rows (a consumed
origin) are pinned by `pinRestoredText`.

**Caret.** After the op, the caret goes to the end of the pasted content: the
tail line, at `runsLength(line) - runsLength(after)`. `opFocusId("splice")`
returns that line for undo/redo.

## The doors

| Door | Before | After |
|---|---|---|
| Caret paste (`BlockForestPastePlugin`) | forest → `paste` after the block | forest → `splice` at the selection (collapsed or range) |
| Drop inside a block's text | container `onExternalDrop` → `paste` after the row | `splice` at the drop point |
| Drop on the non-editable area | `paste` at the pointer row | unchanged |
| Block-selection paste (`onPaste`, no caret) | `paste` after the selection end | unchanged: there is no insertion point inside text |

**Classification.** `decideTransfer` keeps its four arms, but its `inline` arm
narrows to *newline-free text*. That text cannot carry structure, so native
paste stays exactly right for it (URL-paste, token-paste, `text/html` marks and
`BlockClipboardInsertPlugin` all keep working). Every other text or forest
transfer at an insertion point becomes a `splice`, including a lone
`para⏎` (a head-only splice). This removes "one parsed paragraph mistaken for
structure" as a class of bug: whatever the parse yields, the splice puts it at
the point.

**Drop point.** The container keeps owning drops outside text. For a drop
*inside* an editing host it resolves the insertion point from the pointer
(`caretPositionFromPoint`, mapped to a linear offset by the block's surgery
handle, the same basis as `$linearCaretOffset`) and dispatches `splice`. It
still `preventDefault`s in the bubble phase, so the native `insertFromDrop`
never runs. The url-paste drop arm keeps its `stopPropagation`.

**Out of scope.** `code-block` uses `BlockTextArea` (a native textarea), which
receives no forest and is unchanged. Block-selection paste keeps the `paste`
op. The cut-sub-page claim rules come along unchanged, because the forest still
goes through `withPasteIds` / `claimCutPages` / `markCutsPasted`, now called from
one shared `prepareForest` used by both `paste` and `splice`.

## Changes

- `editor/core/block-ops.ts`: the `splice` arm, its schema entry, `applySplice`,
  the split-placement helper shared with `applySplit`, the `OP_LABELS` label,
  and `opFocusId`.
- `editor/web/block-editor-context.tsx`: `splice({blockId, position, runs,
  forest})` on the editor context. It mints the ids, applies the origin surgery,
  records one entry (structural + `runsEdits`) and focuses the caret.
  `prepareForest` is shared with `paste`.
- `editor/web/components/block-forest-paste-plugin.tsx`: build `runs` /
  `position` from the selection (`serializeBlockRuns`, `$linearCaretOffset`,
  `runsWithoutSpan` for a range), then call `splice`.
- `editor/web/components/block-editor.tsx`: the `onExternalDrop` inside-text arm
  → `splice`.
- `editor/web/internal/transfer.ts`: the `inline` rule becomes "no newline";
  **delete `splitCaretPaste`** and the interim `insertNodes` path.
  `$runsToInlineNodes` is deleted too if nothing else uses it.
- Server: nothing new beyond the shared reducer. Check that `blockOpCtx()`
  exposes the default-text type (step 2), and add it if not.
- `editor/CLAUDE.md`: rewrite "The transfer door" and "Paste is an op" around
  the splice rule.

## Verification

- `core/block-ops.test.ts` `describe("splice")`: empty origin + one paragraph;
  empty origin + a heading first (origin consumed); `foo|bar` + `a⏎b` →
  `fooa`, `bbar`; mid-line with a non-paragraph last block (tail minted with
  split's sibling type); a point at the end with visible children (forest lands
  as first children); range replace; refusals (anchor, page row, missing
  block); ids exactly as given.
- `optimistic-block-ops.test.ts`: splice targets/effect;
  `structural-undo.test.tsx`: add `splice` to "every mutation lands exactly
  one undo entry", and check that undo restores the origin text.
- e2e: extend `editor/e2e/copy-paste-verify.ts` (the user's exact
  `The plugin system⏎` case, mid-line splice, Cmd+Z restores in one step) and
  `drop-verify.ts` (multi-line drop mid-text splices at the point);
  re-run `paste-optimistic-verify.ts`, `sub-page-clipboard-verify.ts`,
  `caret-clipboard-verify.ts` and the url-paste e2e scripts for regressions.
- `./equin build`, then paste by hand in a page on the worktree deploy.
