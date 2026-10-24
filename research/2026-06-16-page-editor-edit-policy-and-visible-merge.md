# Page editor: declarative block edit-policy + visible-order merge

## Context

The block page editor handles caret-affecting keystrokes through one pure function,
`resolveKeystroke` (`plugins/page/plugins/editor/web/internal/keystroke-intent.ts`),
which emits a `KeyIntent` that a thin executor (`keyboard-plugin.tsx`) maps to a
`BlockEditorAPI` call. Structural ops then flow through the shared `applyBlockOp`
reducer (`core/block-ops.ts`), run identically on client (optimistic) and server.

Two Notion-parity behaviors are wrong today, and both come from a missing concept
rather than a local bug:

1. **Backspace at the start of a formatted block deletes it instead of resetting
   it to plain text.** Pressing Backspace at the start of a `1.`/`•`/to-do/quote
   item immediately merges it into the previous block. Notion first converts the
   block to a plain paragraph (keeping its text + children); only a *second*
   Backspace merges. Root cause: **the resolver is block-type-blind** — it knows
   `node.type` but has no per-type policy for "what this block does at an editing
   boundary", so it can't decide "reset before merge". The same gap breaks
   *Enter on an empty list item* (should exit the list) and *Enter on an empty
   quote* (should become a paragraph) — today they spawn another empty
   formatted block forever.

2. **Backspace-merge targets the previous *sibling*, not the previous *visible*
   block.** Given

   ```
   xx
     yy0
     yy1
   zz        ← Backspace at start
   ```

   the caret lands at the end of `xx` (bad); it should land at `yy1` — the last
   *visible* block in document order — and `zz`'s text should merge there. Root
   cause: `applyMerge` uses `prevSibling`; it must use the previous **visible
   leaf** (deepest last expanded descendant of the previous sibling).

**Scope: these two root causes only.** No forward-Delete, no new shortcuts, no
headings, no inline rich text. `> ` stays mapped to the toggle block (unchanged).

The outcome: both behaviors become correct, and — because the fix adds a
*declarative per-block edit policy* rather than special-casing types — any future
block type gets the right boundary behavior by declaring one field, with zero
edits to the editor core.

---

## Root cause 1 — declarative block edit-policy

### 1a. Add policy fields to the block handle
`plugins/page/plugins/editor/core/define-block.ts` — add to both `BlockHandle<T>`
and the `defineBlock` opts/return (mirror the existing `markdownPrefixes` field):

```ts
/** Backspace at the very start of this block first converts it to this type
 *  (keeping text + children) instead of merging — Notion's "reset block type".
 *  Generic: the editor core never names a specific block type. */
resetToOnBackspaceAtStart?: string;
/** Enter on an EMPTY block of this type converts it to this type instead of
 *  splitting — exits a list / breaks a quote out to a paragraph. */
breakOutOnEmptyEnter?: string;
```

### 1b. Each block declares its own policy
Add `resetToOnBackspaceAtStart: "text"` **and** `breakOutOnEmptyEnter: "text"` to:
- `plugins/page/plugins/bulleted-list/core/bulleted-list-block.ts`
- `plugins/page/plugins/numbered-list/core/numbered-list-block.ts`
- `plugins/page/plugins/to-do/core/to-do-block.ts`
- `plugins/page/plugins/quote/core/quote-block.ts`
- `plugins/page/plugins/toggle/core/toggle-block.ts`

`text` declares neither (it is the target). `"text"` is the verified type string of
`textBlock` (`plugins/page/plugins/text/core/text-block.ts:5`).

### 1c. Resolve the policy at the consumer (no prop drilling)
Today `splitOptions` is computed in `block-text-renderer.tsx` and drilled through
`block-text-editor.tsx` → `keyboard-plugin.tsx` → `IntentContext`. The new fields
are *static handle config*, so resolve the **whole edit policy in
`keyboard-plugin.tsx`** from the `Editor.Block` contributions registry (the same
generic collection-consumer pattern `block-text-renderer.tsx:18-22` already uses),
and fold `splitOptions` into it — removing the prop chain.

In `keyboard-plugin.tsx`, inside `handle()` (it already builds `IntentContext`):
```ts
const contributions = Editor.Block.useContributions();          // hoist to component body
const node = toNodes(rowsRef.current).find((b) => b.id === blockIdRef.current);
const h = contributions.find((c) => c.block.type === node?.type)?.block;
const editPolicy = {
  asChild: h?.splitChildWhenExpanded && node?.expanded ? true : undefined,
  childType: h?.splitChildWhenExpanded?.childType,
  resetToOnBackspaceAtStart: h?.resetToOnBackspaceAtStart,
  breakOutOnEmptyEnter: h?.breakOutOnEmptyEnter,
};
```
Pass `editPolicy` into the `resolveKeystroke` ctx. Drop the `splitOptions` prop from
`KeyboardPlugin` and `BlockTextEditor`, and the `splitOptions` computation from
`BlockTextRenderer` (the `asChild`/`childType` move into the policy above).

> Deviation from the `splitOptions`-as-prop precedent is intentional and named:
> the new policy is static handle config (not render-state-dependent like
> `block.expanded`), so resolving it once at the consumer from the registry is the
> cleaner primitive and lets future boundary behaviors add a field + a resolver
> branch with no prop drilling. `block.expanded` is read from the live `node`.

### 1d. New intent + resolver branches
`keystroke-intent.ts`:
- Replace `IntentContext.splitOptions` with `editPolicy?: { asChild?: boolean;
  childType?: string; resetToOnBackspaceAtStart?: string; breakOutOnEmptyEnter?: string }`.
- Add `| { type: "convertTo"; to: string }` to `KeyIntent`.
- **Backspace** (after the existing `isIndented → outdent`, before `merge`):
  ```ts
  const p = ctx.editPolicy;
  if (p?.resetToOnBackspaceAtStart && node.type !== p.resetToOnBackspaceAtStart)
    return { type: "convertTo", to: p.resetToOnBackspaceAtStart };
  ```
  Order = outdent (indented) → reset (formatted) → merge → noop. Matches Notion:
  an indented bullet outdents first, then at top level resets to text, then merges.
- **Enter** (before computing `asChild`/`split`):
  ```ts
  const len = textLengthOf(node);
  if (len === 0 && p?.breakOutOnEmptyEnter && node.type !== p.breakOutOnEmptyEnter)
    return { type: "convertTo", to: p.breakOutOnEmptyEnter };
  ```
  `asChild` now reads `p?.asChild` instead of `ctx.splitOptions?.asChild`.

### 1e. Executor maps `convertTo`
`keyboard-plugin.tsx` `execute()` — new case, mirroring the proven
`markdown-shortcut-plugin.tsx:108-112` shape (seed target's empty payload, overlay
live text):
```ts
case "convertTo": {
  event.preventDefault();
  const text = serializeBlockText(lexicalEditor);
  const target = contributions.find((c) => c.block.type === intent.to)?.block;
  api.convertTo(intent.to, { ...(target?.empty?.() ?? {}), text });
  return true;
}
```
`convertTo` (`block-editor-context.tsx:277`) already exists; all formatted blocks
share `BlockTextRenderer`, so the Lexical instance + caret reconcile in place.

---

## Root cause 2 — merge into the previous visible leaf

### 2a. Pure helper in `core/block-ops.ts`
```ts
/** The previous block in VISIBLE document order: the deepest last expanded
 *  descendant of `node`'s previous sibling. Null if there is no previous sibling.
 *  Stops descending at a collapsed block (its children aren't visible). */
export function prevVisibleLeaf(blocks: BlockNode[], node: BlockNode): BlockNode | null {
  let cur = prevSibling(blocks, node);
  if (!cur) return null;
  while (cur.expanded) {
    const kids = childrenOf(blocks, cur.id);
    if (kids.length === 0) break;
    cur = kids[kids.length - 1]!;
  }
  return cur;
}
```

### 2b. `applyMerge` merges into the leaf, not the sibling
In `applyMerge` (`block-ops.ts:248`), replace `const prev = prevSibling(blocks, block)`
with `const prev = prevVisibleLeaf(blocks, block)`. The rest is unchanged — text
concatenation, child adoption under `prev`, and removal of `block` all already
operate on `prev`. (Merge only fires for non-indented blocks with a previous
sibling, so a leaf always exists; the `if (!prev) return blocks` guard stays.)

### 2c. Focus the leaf at the join offset
The executor must land the caret at the **join** = the leaf's *original* text length
(not its post-merge end). `placeCaretAtBoundary` only does start/end, so add an
offset placement:

- `caret-geometry.ts` — `placeCaretAtOffset(editor, offset)`: `editor.focus()` then
  in an `editor.update()` build a collapsed `$createRangeSelection` at `offset`
  clamped into the first paragraph's text node (reuse the `$absoluteOffset` linear
  model; for a single-paragraph block this is the text node offset).
- `block-text-editor.tsx` — register a `focusOffset?: (n: number) => void` capability
  on the `BlockFocusHandle` (alongside `focusBoundary`), wired to
  `placeCaretAtOffset`.
- `block-editor-context.tsx` `BlockFocusHandle` interface — add `focusOffset?`.
- `block-editor-context.tsx` `makeBlockAPI().merge()` (currently lines 304-321):
  compute the target via `prevVisibleLeaf(nodes, block)` and the join offset from
  its current text, then after `dispatchOp` defer focus:
  ```ts
  const target = prevVisibleLeaf(nodes, block);
  if (!target) return;
  const joinOffset = textOf(target).length;     // textOf already imported from ../core
  dispatchOp({ kind: "merge", blockId, text: opts?.text });
  const targetId = target.id;
  queueMicrotask(() => {
    const fh = focusHandlesRef.current.get(targetId);
    fh?.focusOffset?.(joinOffset) ?? fh?.focus();
  });
  ```
  An absolute offset is timing-robust: whether or not the merged text has synced
  into the leaf's editor yet, `joinOffset` is the correct caret position. Import
  `prevVisibleLeaf` from `../core`.

> Edge case (pre-existing, out of scope): if the previous visible leaf is a void
> block (image/divider), `focusOffset` is absent and focus falls back to `focus()`;
> the reducer's text-into-void behavior is unchanged from today. Common case
> (text→text) is fully correct.

---

## Files to modify

- `core/define-block.ts` — two new optional handle fields (1a)
- `{bulleted-list,numbered-list,to-do,quote,toggle}/core/*-block.ts` — declare policy (1b)
- `web/components/keyboard-plugin.tsx` — resolve editPolicy from registry; `convertTo` case; drop `splitOptions` prop (1c, 1e)
- `web/internal/keystroke-intent.ts` — `editPolicy` ctx, `convertTo` intent, Backspace/Enter branches (1d)
- `web/components/block-text-renderer.tsx` — drop `splitOptions` computation/prop (1c)
- `web/components/block-text-editor.tsx` — drop `splitOptions` prop; register `focusOffset` (1c, 2c)
- `core/block-ops.ts` — `prevVisibleLeaf`; `applyMerge` retarget (2a, 2b)
- `web/internal/caret-geometry.ts` — `placeCaretAtOffset` (2c)
- `web/block-editor-context.tsx` — `BlockFocusHandle.focusOffset`; `merge()` retarget + join-offset focus (2c)

## Verification

1. **Unit (pure, fast):**
   - `bun test plugins/page/plugins/editor/core/block-ops.test.ts` — add cases:
     `prevVisibleLeaf` descends to the deepest last expanded child, stops at a
     collapsed parent, returns null with no prev sibling; `applyMerge` concatenates
     into the visible leaf (the `xx/yy0/yy1/zz` scenario) and adopts `zz`'s children
     under `yy1`.
   - `bun test plugins/page/plugins/editor/web/internal/keystroke-intent.test.ts` —
     add cases: Backspace at start of a block whose `editPolicy.resetToOnBackspaceAtStart`
     is set and `type !== "text"` → `{ type: "convertTo", to: "text" }`; same block at
     `type === "text"` → `merge`; indented formatted block → still `outdent` first;
     Enter on empty block with `breakOutOnEmptyEnter` → `convertTo`; Enter on non-empty
     → `split`.
2. **Build:** `./equin build`
3. **Manual / Playwright** at `http://<worktree>.localhost:9000` (Pages app, a page
   with the `xx / yy0 / yy1 / zz` structure), via `bun e2e/screenshot.mjs` or a
   scripted run:
   - Backspace at start of a `1.` item → becomes plain text (marker gone), text +
     caret preserved; second Backspace merges.
   - Enter on an empty bullet/quote → becomes an empty paragraph (exits the list).
   - Backspace at start of `zz` → caret lands at end of `yy1` (not `xx`); `zz`'s text
     joins `yy1` at the caret.
   - Regression: Enter mid-text still splits; Tab/Shift+Tab indent/outdent; Enter at
     end of an expanded toggle still nests as first child; arrow up/down column
     preservation intact.
