# Run-aware caret offset mapping for the block editor

## Context

Each block in the page editor is its own Lexical editor. The caret helpers in
`plugins/page/plugins/editor/web/internal/caret-geometry.ts` translate between a
**linear plain-text character offset** (the basis the stored `RichText` runs use —
see `splitRuns`/`textOf`/`serializeBlockRuns`) and a Lexical caret position.

These helpers were written when a block's paragraph held a **single** `TextNode`.
Now that inline rich-text formatting has landed (bold/italic/underline/strike/code
marks, color, links, plus inline decorator tokens like `[[pageId]]` page-links and
inline math), a paragraph holds **many** leaves: multiple `TextNode`s, `LinkNode`s
wrapping text, `LineBreakNode`s, and atomic decorator nodes. Every helper that
assumes one text node is now wrong:

- **`$placeCaretAtOffset` / `placeCaretAtOffset`** clamp the offset into the
  *first* text node of the first paragraph. After a Backspace-merge the caret
  should land at the JOIN point (`textOf(target).length`, the merge target's
  original text length); for a mixed-format target that offset lands past the
  first run, so it sticks at the end of the first run or falls back to `focus()`.
  **(the reported bug)**
- **`$caretOffsetWithinParagraph`** returns `selection.anchor.offset`, which is
  *relative to the anchor text node*, not the paragraph. Value-sync captures the
  wrong offset before a rebuild and restores into the first text node. **(stated)**
- **`$absoluteOffset`** (feeds `readCaretContext().offset`, used as the split
  `position` → `splitRuns`) also returns the text-node-relative offset, and returns
  `null` when the caret sits inside a `LinkNode` (its parent isn't a root child).
  So **splitting a formatted block already splits at the wrong character today.**
  (latent, same root cause)
- **`$atEnd`** compares the text-node-relative `anchor.offset` to the *whole
  paragraph* `getTextContentSize()`, so it is `false` at the end of any block that
  ends in a formatted run — breaking Enter-at-end behavior (sibling type / nest).
  (latent, same root cause)
- **`$atStart`** is `false` at the true start when a block begins with a link
  (anchor's parent is the `LinkNode`, not the paragraph). (latent edge case)

All five fail for the same reason. The clean fix is **one** leaf-walking primitive
that maps the linear offset ↔ Lexical caret position in the runs basis, with every
helper routed through it. Decided scope (confirmed with the user): **unify all
five**, and make the walker **token-aware** (decorator tokens count their full
serialized-token length, matching `textOf`/`splitRuns`/`serializeBlockRuns`).

## Offset basis (single source of truth)

The linear offset is the **stored-runs plain-text basis** already used by
`splitRuns`, `runsLength`, `textOf`, and `serializeBlockRuns`:

- `TextNode` → `getTextContentSize()` chars
- `LineBreakNode` → 1 char (`\n`)
- decorator node (e.g. `PageLinkInlineNode`) → **length of its serialized token**
  (the same string `tokenOf` already produces in `serializeBlockRuns`). Note these
  nodes deliberately return `""` from `getTextContent()`, so Lexical's native
  `getTextContent()` basis would drift by the token length — we must use the token
  length, not `getTextContentSize()`.
- `LinkNode` (element) → sum of its children (recursed into, never a leaf itself)
- between paragraphs → +1 char join (matches `serializeBlockRuns`'s `\n` push). In
  practice `runsToLexical` builds a single paragraph, but the walk stays general.

This basis makes `Σ nodePlainLength(leaves) === runsLength(serializeBlockRuns(...))`,
so read→write round-trips and the merge `joinOffset = textOf(target).length` line
up exactly.

## Design

### New primitive in `block-text-extensions.ts`

This file already owns the runs↔Lexical conversion and the private `tokenOf`, so
the linear-offset ↔ position mapping is the third member of that family and belongs
here (no import cycle: it never imports `caret-geometry`).

Add and export:

1. `nodePlainLength(node: LexicalNode): number` — the per-leaf length above
   (`$isLineBreakNode` → 1, `$isTextNode` → `getTextContentSize()`, else
   `tokenOf(node).length`). Single source reused by the walkers; `tokenOf` stays
   private and is called here.

2. `$linearCaretOffset(): number | null` — inside a read/update, returns the
   selection anchor's linear offset, or `null` when there is no range selection.
   Walk the root's element children (paragraphs) in document order, accumulating
   `acc` (+1 between paragraphs). DFS each paragraph's descendants:
   - **text anchor** (`$isTextNode(anchorNode)`): when the walk reaches that exact
     text node, return `acc + anchor.offset`.
   - **element anchor** (anchor on a paragraph/`LinkNode`; `anchor.offset` is a
     child index): when the walk reaches that element, return `acc` + sum of
     `nodePlainLength` over the leaves of its first `anchor.offset` children.
   - otherwise add `nodePlainLength(leaf)` for each leaf and recurse into elements.

3. `$placeCaretAtLinearOffset(offset: number): void` — inside an update, clamp to
   `[0, $paragraphsPlainLength()]`, then walk leaves tracking `[leafStart, leafEnd]`:
   - first leaf where `offset <= leafEnd` is the target (`<=` so a text/text
     boundary resolves to the *end* of the earlier run — correct for the merge seam).
   - `TextNode` → text selection at `min(offset - leafStart, size)`.
   - `LineBreakNode` / decorator (atomic) → **element** selection in the leaf's
     parent at the child index (`offset <= leafStart` → before the node; else
     after, index + 1). For a decorator hit strictly inside, clamp to the nearer
     edge.
   - empty paragraph (no leaves) → `paragraph.selectStart()`.

4. `$paragraphsPlainLength(): number` — total of the basis above (leaves + joins),
   for the `atEnd` comparison and the clamp.

Pseudocode lives with the implementation; the traversal is a small shared DFS used
by both `$linearCaretOffset` and `$placeCaretAtLinearOffset`.

### Rewire `caret-geometry.ts` (keep its public API)

Import the four helpers above and make the existing functions thin adapters so
`value-sync-plugin.tsx` and `block-text-editor.tsx` need no changes:

- `$absoluteOffset()` → `return $linearCaretOffset();` (delete the bespoke loop).
- `$atStart()` → `collapsed && $linearCaretOffset() === 0`.
- `$atEnd()` → `collapsed && $linearCaretOffset() === $paragraphsPlainLength()`.
  (Delete the `$getRoot().getFirstChild()/getLastChild()` logic in both.)
- `$placeCaretAtOffset(offset)` → `$placeCaretAtLinearOffset(offset)`.
- `$caretOffsetWithinParagraph()` → keep the collapsed guard, then
  `return $linearCaretOffset();` (it already returns `null` for non-collapsed).
- `readCaretContext()` structural read: compute `off = $linearCaretOffset()` and
  `total = $paragraphsPlainLength()` once and derive `offset/atStart/atEnd` from
  them (collapses three reads into one walk).
- `placeCaretAtOffset(editor, offset)`, `placeCaretAtColumn`, `placeCaretAtBoundary`,
  and all visual/pixel geometry are unchanged.

No call sites change: `block-editor-context.tsx` merge (`focusOffset(joinOffset)`),
`keyboard-plugin.tsx` (`readCaretContext`), and `value-sync-plugin.tsx` all keep
their current imports/signatures.

## Files to modify

- `plugins/page/plugins/editor/web/internal/block-text-extensions.ts` — add
  `nodePlainLength`, `$linearCaretOffset`, `$placeCaretAtLinearOffset`,
  `$paragraphsPlainLength` (reuses private `tokenOf`, `$isTextNode`,
  `$isLineBreakNode`, `$isElementNode`, `$isLinkNode` already imported here).
- `plugins/page/plugins/editor/web/internal/caret-geometry.ts` — route
  `$absoluteOffset`, `$atStart`, `$atEnd`, `$placeCaretAtOffset`,
  `$caretOffsetWithinParagraph`, and `readCaretContext` through the new primitive.

No schema, server, core type, or barrel changes — purely internal web helpers.

## Reused existing code

- `tokenOf` (private, `block-text-extensions.ts`) — token serialization for
  decorator length; do not duplicate.
- `splitRuns` / `runsLength` / `textOf` (`core/rich-text.ts`, `core/block-ops.ts`)
  — define the basis the walker must match; the merge `joinOffset` source.
- Lexical guards `$isTextNode` / `$isLineBreakNode` / `$isElementNode` /
  `$isLinkNode`, `$createRangeSelection`, `$setSelection` — already imported.

## Verification

1. **Unit (bun:test, co-located `block-text-extensions.test.ts`)** — headless
   Lexical editor (`createEditor` + `editor.update`); no DOM needed for node-tree
   walks and selection set/read. Cover, building the tree via `runsToLexical`:
   - multi-`TextNode` paragraph (`"Hello " + bold "world"`): caret in the bold node
     → `$linearCaretOffset` returns the linear offset (e.g. 11, not 5); placing at
     11 lands at the bold node's end; round-trip read===write.
   - `LinkNode`-wrapped run: anchor inside the link resolves to a non-null linear
     offset (regression for the old `null`); place lands inside the link.
   - `LineBreakNode`: offset just before/after `\n` lands on the correct side.
   - decorator token (register `PageLinkInlineNode`): `nodePlainLength` ===
     token length; offsets past the token stay aligned with `serializeBlockRuns`.
   - boundary cases: offset 0 → `atStart`; offset `total` → `atEnd` for a block
     ending in a formatted run (the old `$atEnd` bug).
   Run: `bun test plugins/page/plugins/editor/web/internal/block-text-extensions.test.ts`
   (after a build / `bun install` so `node_modules` is populated).
2. **Build**: `./equin build`, app at `http://att-1781566786-4c1n.localhost:9000`.
3. **Manual e2e (Playwright `e2e/screenshot.mjs`)** on a page:
   - Type `Hello `, bold-select `world`, then a plain block `foo` below; put the
     caret at the start of `foo` and press **Backspace** → caret must land between
     `world` and `foo` (the seam), not after `Hello` or at the block end.
   - In a block ending with a bold word, press **Enter at the end** → a new sibling
     block is created (exercises the fixed `$atEnd`), not a mid-word split.
   - Split a formatted block mid-text (Enter) → the two halves split at the visual
     caret, preserving marks on each side (exercises the fixed split `position`).
