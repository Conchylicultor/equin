# Block-selection paste: anchor the insert at the selection's document-order end

## Context

Pasting while a multi-block selection is active can insert the copied blocks **mid-selection**, splitting the selected run in half. Notion inserts after the end of the selection.

The originating bug report described the defect with the **direction reversed**. Both claims in it were checked against a real build (`bun e2e/copy-paste-verify.mjs`, plus a scripted Playwright repro) before planning:

| Repro | Result |
| --- | --- |
| alpha → Escape → **Shift+ArrowDown** (alpha+bravo) → Cmd+C → Cmd+V | `alpha, bravo, alpha′, bravo′, charlie` — **already correct** |
| charlie → Escape → **Shift+ArrowUp** (bravo+charlie) → Cmd+C → Cmd+V | `alpha, bravo, bravo′, charlie′, charlie` — **broken, pastes mid-run** |

So the reported downward repro does not reproduce; the real defect is the **upward-extended** selection.

**Root cause.** `block-editor.tsx` anchors the paste at `headRef.current` — the range's *moving* end:

```ts
const afterId = headRef.current ?? focusedBlockId ?? roots[roots.length - 1] ?? null;
```

The head is the bottom of the selection only when it was extended *downward*. Extend upward and the head is the **top**, so the copies land inside the selected run. The rule is duplicated at two call sites (`:534` file paste, `:562` forest/markdown paste), which is how they can drift apart.

**The fix is structural, not a patch:** the insert anchor is a property of the selection's *document order*, not of how the user happened to build the range. Deriving it from document order makes the extension direction irrelevant by construction — the whole class of bug goes away rather than the one direction that was reported.

**Decided (user, this conversation): insert after the selection end. Paste does NOT replace the selected blocks.** Notion's replace rule is deliberately out of scope — it needs a new atomic delete+insert server op (reusing `deleteBlocksSubtree` so sub-page trash/lifecycle hooks still fire) and a single-undo-entry story, since bulk delete currently undoes through the patch pipeline. That is a separate task if wanted.

### Secondary defect: the e2e encodes the wrong expectation

`e2e/copy-paste-verify.mjs` assertions **B and C currently FAIL** on `main`'s behavior — they assert the mid-selection order (`alpha, alpha′, bravo′, bravo, charlie`) as if it were correct, with a comment rationalizing the `afterId = headRef.current` rule. They must be corrected to the real expected order regardless of this fix, and the upward case — the actual regression guard — is not covered at all.

## Approach

Reuse the DFS document-order helper that already exists and is already trusted by the bulk indent/outdent folds. No new ordering logic.

`plugins/page/plugins/editor/core/block-ops.ts:247-267` already has (module-private):

- `documentOrder(blocks)` — rank-ordered DFS from the forest roots. Its own doc-comment states the trap this bug fell into: *"A block's `rank` is only comparable against its OWN siblings — a global rank sort is therefore NOT document order."*
- `inDocumentOrder(blocks, ids)` — `ids` sorted top-to-bottom, absent ids dropped. Used by `foldIndent`/`foldOutdent`.

`block-ops.ts:3` already imports from `@plugins/primitives/plugins/tree/core`, so `selectionRoots` is a natural addition there.

### 1. New pure helper in `core/block-ops.ts`

Add next to `inDocumentOrder`, keeping `documentOrder`/`inDocumentOrder` private:

```ts
/**
 * Where a paste lands when a block selection is active: as a sibling AFTER the
 * last selected subtree root in DOCUMENT order.
 *
 * Not the range's head — that is the selection's moving end, which is the TOP of
 * the run when the user extended upward, and anchoring there splits the run in
 * half. Document order is direction-independent by construction.
 *
 * Roots, not the last selected id: inserting after a root places the copies after
 * that root's entire subtree, so a selected parent's descendants are never split.
 */
export function pasteAnchorId(
  blocks: BlockNode[],
  selectedIds: ReadonlySet<string>,
  focusedBlockId: string | null,
): string | null {
  const roots = selectionRoots(blocks, selectedIds);
  return inDocumentOrder(blocks, roots).at(-1) ?? focusedBlockId ?? null;
}
```

Export it from `plugins/page/plugins/editor/core/index.ts` in the existing `./block-ops` export list (alongside `canIndent`, `canOutdent`, `childrenOf`, `prevVisibleLeaf`).

### 2. Use it at both paste call sites

`plugins/page/plugins/editor/web/components/block-editor.tsx` (imports `../../core` at `:57`; `rows` is a `Block[]`, structurally a `BlockNode[]`):

- `:533-535` (file/attachment paste) and `:561-563` (forest/markdown paste) both become:
  ```ts
  const afterId = pasteAnchorId(rowsRef.current, selectedRef.current, focusedBlockId);
  ```
  One rule, one place — the two sites can no longer drift.
- Drop `headRef` from the `useBlockSelection(...)` destructuring (`:470`) and from `onPaste`'s dep array (`:566`). Nothing else in this file reads it.
- `headRef` **stays** in `use-block-selection.ts` — it is still load-bearing there for Enter (`:215`), Arrow nav/extend (`:222-236`), and Cmd+A (`:188`). Do not remove the ref from the hook.

The existing `selectionRoots(...)` calls already inside `onPaste` become redundant and go away with the helper.

### 3. Known, accepted edge

When a selection spans branches (a top-level root plus a root nested under a different parent), the document-order-last root can be the nested one, so the copies land nested under that parent. This is "after the end of the selection" read literally, and matches how the selection's other bulk ops treat roots. Note it in the helper's doc-comment; don't special-case it.

## Files to change

| File | Change |
| --- | --- |
| `plugins/page/plugins/editor/core/block-ops.ts` | Add `pasteAnchorId`; import `selectionRoots` from the tree primitive |
| `plugins/page/plugins/editor/core/index.ts` | Export `pasteAnchorId` from the `./block-ops` list |
| `plugins/page/plugins/editor/web/components/block-editor.tsx` | Both paste anchors use `pasteAnchorId`; drop `headRef` destructure + dep |
| `plugins/page/plugins/editor/core/block-ops.test.ts` | New `pasteAnchorId` cases (bun:test) |
| `e2e/copy-paste-verify.mjs` | Correct assertions B/C; add the upward-extension case |

## Verification

**1. Unit (pure, no DOM)** — add to `plugins/page/plugins/editor/core/block-ops.test.ts`, beside the existing `foldIndent`/`foldOutdent` cases that lean on the same `inDocumentOrder`:

- downward-extended range → anchor is the bottom block;
- **upward-extended range → anchor is the bottom block** (the regression that fails today, and the reason the helper exists);
- selected parent with children → anchor is the parent root, not its last descendant;
- empty selection → falls back to `focusedBlockId`, then `null`.

```bash
bun test plugins/page/plugins/editor/core/block-ops.test.ts
```

**2. End-to-end in a real browser** — `./equin build`, then:

```bash
bun e2e/copy-paste-verify.mjs --base http://att-1784204878-drki.localhost:9000
```

- B and C must be corrected to the real expected order. B becomes `["alpha","bravo","alpha","bravo","charlie",""]` (verified as today's actual downward behavior), and C's cascade updated to match; the misleading `afterId = headRef.current` rationale comment on B is removed.
- **Add assertion E, the actual guard**: caret into `charlie` → Escape → Shift+ArrowUp → Cmd+C → Cmd+V → expect `alpha, bravo, charlie, bravo′, charlie′` (today: `alpha, bravo, bravo′, charlie′, charlie`).

All assertions must pass — B/C currently fail on an unmodified build, so a green run is only meaningful after they are fixed.

**3. Checks**: `./equin check` (type-check + lint + boundaries).
