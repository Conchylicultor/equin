# Document-level caret coordinator + unified keystroke intent (page block editor)

> Status: plan / awaiting implementation
> Category: page (`plugins/page/plugins/editor/`)
> Pairs with the already-landed optimistic block-ops work; see
> `research/2026-06-09-global-optimistic-mutation-primitive.md` (this is its
> "Block editor: authoritative client document model" follow-up sub-task — the
> reducer, client-minted UUIDs, and autosave-freeze already shipped; what remains
> is the **caret coordinator** and **intent resolution**).

## Context

In the page block editor every block is its own Lexical editor instance, and
cross-block caret movement is hand-coded in
`plugins/page/plugins/editor/web/components/keyboard-plugin.tsx` with structural
(text-offset) heuristics. Three bugs result:

- **Up** moves the caret to the start of the current visual line instead of into
  the block above. `isAtStart()` only returns true at offset 0, so the first Up
  fires the native "go to line start" and only a *second* Up crosses the block.
- **Left/Right across blocks are not handled at all** — there are no
  `KEY_ARROW_LEFT/RIGHT_COMMAND` handlers, so Left at a block's start no-ops.
- **Multi-line blocks are mishandled**: `isAtStart`/`isAtEnd` are purely
  structural (offset 0 / offset === length), not visual — so the top/bottom line
  is detected wrong — and the caret's pixel column is never preserved when
  crossing into a neighbour.

Root cause: the focus registry carries only `{ focus: () => void }` (bare Lexical
focus, no caret target), there is **no visual-line / pixel-column awareness**, and
the keystroke→operation mapping is scattered across `keyboard-plugin.tsx` plus the
`makeBlockAPI.split()/merge()` methods.

Intended outcome: a **document-level caret coordinator** that detects the caret's
top/bottom visual line and pixel column in the source editor and places it at the
same column on the matching edge of the neighbouring block, handling
Up/Down/Left/Right; **paired with a single pure intent-resolution step** that maps
`(keystroke, caret, block context) → operation` for *all* caret-affecting keys
(Enter/Backspace/Tab/Arrows), centralizing today's scattered decisions.

Decisions locked with the user:
- **Unify all keystrokes** into one resolver (not navigation-only).
- **Home/End stay line-local (native)** — they never cross blocks.

## Current architecture (verified)

- `block-editor.tsx` flattens the block tree depth-first into `flat: FlatBlock[]`
  and pushes that order to the context via `setFlatOrder` → `flatOrderRef.current`
  (the authoritative nav order; includes non-text blocks).
- `block-editor-context.tsx` owns `focusHandlesRef: Map<string,{focus:()=>void}>`,
  `flatOrderRef`, and the `BlockEditorAPI` (`makeBlockAPI`). `focusUp/focusDown`
  do `flat[idx∓1]` then bare `.focus()` — no column, and no skip over
  non-focusable blocks (so they silently no-op next to a divider/image).
- `block-text-editor.tsx` registers the handle: `registerFocusHandle(block.id,
  { focus: () => lexicalEditorRef.current?.focus() })`. `lexicalEditorRef` (the
  `LexicalEditor`) is captured by `EditorRefPlugin`. Renders a real
  `contenteditable` div — measurable via `getRootElement()`.
- `keyboard-plugin.tsx` registers Enter/Backspace/Tab/ArrowUp/ArrowDown/Escape at
  `COMMAND_PRIORITY_HIGH`; reads `isAtStart/isAtEnd/getAbsoluteOffset`; calls
  `editor.split/merge/indent/outdent/focusUp/focusDown`. No Left/Right.
- `makeBlockAPI.split()` decides `asChild`; `merge()` decides outdent-vs-merge
  and does the post-op focus — these are the scattered intent sites to unify.
- Reducer `applyBlockOp(BlockNode[], BlockOp)` (`core/block-ops.ts`) is pure and
  intentionally **caret-free**; ops are `split | merge | indent | outdent |
  insert | delete | move`. `childrenOf(nodes, parentId)` is the ordered-children
  helper. The optimistic overlay (`web/internal/optimistic-block-ops.ts`) and
  autosave-freeze (`frozenIds`) already work — **do not touch the op/overlay path.**

Precedent for caret-rect measurement already in repo:
`plugins/page/plugins/inline-page-link/web/components/inline-page-link-plugin.tsx:95`
uses `window.getSelection().getRangeAt(0).getBoundingClientRect()` inside a Lexical
read. `block-editor.tsx:73` already does `getBoundingClientRect()` over
`[data-block-id]` rows. No `caretRangeFromPoint`/`@lexical/selection` usage yet.

## Design

Three new internal modules under `plugins/page/plugins/editor/web/internal/`,
plus thin wiring changes. No new plugin, no boundary changes (all internal to the
`editor` plugin). No server changes. No reducer/overlay changes.

### 1. Caret geometry — `internal/caret-geometry.ts` (pure, DOM/Lexical helpers)

Source-editor read (called inside the source block's Lexical context):

```ts
export interface CaretContext {
  offset: number;       // linear offset (from existing getAbsoluteOffset)
  collapsed: boolean;
  atStart: boolean;     // structural: collapsed at offset 0 of first child
  atEnd: boolean;       // structural: collapsed at end of last child
  onTopLine: boolean;   // VISUAL: caret on the first visual line
  onBottomLine: boolean;// VISUAL: caret on the last visual line
  caretX: number;       // viewport x (px) of the caret, for column preservation
}

export function readCaretContext(editor: LexicalEditor): CaretContext | null;
```

Visual-line detection is font/padding-agnostic by comparing the caret rect to
reference rects built at the contenteditable's content start/end (not absolute
padding math):

```
root = editor.getRootElement()
startRange = createRange(); startRange.selectNodeContents(root); startRange.collapse(true)
endRange   = createRange(); endRange.selectNodeContents(root);   endRange.collapse(false)
caretRect  = window.getSelection().getRangeAt(0).getBoundingClientRect()
onTopLine    = caretRect.top    <= startRange.rect.top    + EPS
onBottomLine = caretRect.bottom >= endRange.rect.bottom  - EPS
caretX       = caretRect.left
```
- `EPS` ≈ half a line-height (derive from `endRange.bottom - startRange.top` when
  multi-line, else from `getComputedStyle(root).lineHeight`).
- Degenerate collapsed rect (empty block → 0×0 at origin): treat as single empty
  line (`onTopLine = onBottomLine = true`) and `caretX = root rect left + paddingLeft`.
- Single-line block ⇒ `onTopLine && onBottomLine` both true (Up and Down both
  cross — correct).

Target-editor placement (called on the neighbour via its handle):

```ts
// Place caret at pixel column x on the target's top or bottom visual line.
export function placeCaretAtColumn(editor: LexicalEditor, x: number, edge: "top" | "bottom"): void;
// Place caret at the very start/end (used by Left/Right crossing).
export function placeCaretAtBoundary(editor: LexicalEditor, edge: "start" | "end"): void;
```

`placeCaretAtColumn`:
1. `editor.focus()`; `root = editor.getRootElement()`.
2. Compute a `y` inside the target line: top → `startRange.rect.top + lh/2`;
   bottom → `endRange.rect.bottom − lh/2`. Clamp `x` to `[rootRect.left+1,
   rootRect.right−1]`.
3. `domCaret = caretRangeFromPoint(x, y)` (WebKit/Chrome) **or**
   `caretPositionFromPoint(x, y)` (Firefox) — feature-detect both.
4. Convert DOM point → Lexical selection precisely (race-free, no reliance on
   async selectionchange): inside `editor.update()`, use
   `$getNearestNodeFromDOMNode(domCaret.startContainer)` and build a collapsed
   `$createRangeSelection()` at `(node.getKey(), domCaret.startOffset, "text")`
   (or element-anchor for an empty paragraph), then `$setSelection(sel)`.
5. Fallback when the point resolves outside the root (null/again the parent):
   `placeCaretAtBoundary(editor, edge === "top" ? "start" : "end")`.

`placeCaretAtBoundary`: `editor.focus()` then `editor.update(() => edge ===
"start" ? $getRoot().selectStart() : $getRoot().selectEnd())` — clean Lexical API,
no pixel math.

### 2. Unified intent resolver — `internal/keystroke-intent.ts` (pure, unit-tested)

The single mapping `(keystroke, caret, block context) → intent`. Absorbs the
asChild and merge-vs-outdent decisions currently inside `makeBlockAPI`.

```ts
export type KeyIntent =
  | { type: "split"; position: number; asChild: boolean }
  | { type: "merge" }                          // backspace@start, top-level
  | { type: "outdent" }                        // backspace@start indented, or shift+tab
  | { type: "indent" }                         // tab
  | { type: "nav"; dir: "up" | "down" | "left" | "right" }
  | { type: "selectBlock"; extend?: "up" | "down" }  // escape / shift+arrow at a visual edge
  | { type: "passthrough" };                   // let Lexical handle natively

export function resolveKeystroke(
  key: "Enter" | "Backspace" | "Tab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
  mods: { shift: boolean },
  caret: CaretContext,
  ctx: { nodes: BlockNode[]; blockId: string; pageId: string; splitOptions?: { asChild?: boolean; childType?: string } },
): KeyIntent;
```

Rules (behavior-preserving for structural keys, new for nav):
- **Enter** → `split` with `position = caret.offset`; `asChild = splitOptions.asChild
  ?? (hasExpandedChildren(ctx) && position === textLength)` — the exact predicate
  moved verbatim from `makeBlockAPI.split()`.
- **Backspace** → only when `caret.atStart && collapsed`: `isIndented(ctx) ?
  {outdent} : (hasPrevSibling(ctx) ? {merge} : {passthrough})` — the
  `makeBlockAPI.merge()` decision, moved here. Otherwise `passthrough`.
- **Tab** → `shift ? {outdent} : {indent}` (indent/outdent pre-guards — needs a
  prev sibling / not already top-level — return `passthrough` when they'd no-op).
- **ArrowUp** → `caret.onTopLine ? (shift ? {selectBlock, extend:"up"} : {nav,"up"}) : passthrough`.
- **ArrowDown** → `caret.onBottomLine ? (shift ? {selectBlock, extend:"down"} : {nav,"down"}) : passthrough`.
- **ArrowLeft** → `caret.atStart && collapsed && !shift ? {nav,"left"} : passthrough`.
- **ArrowRight** → `caret.atEnd && collapsed && !shift ? {nav,"right"} : passthrough`.
- **Home/End**: not routed through the resolver — left to native (line-local).
- Escape: stays a direct `selectBlock` (unchanged; not caret-affecting).

Pure tree helpers (`isIndented`, `hasPrevSibling`, `hasExpandedChildren`) reuse
`childrenOf` from `core/block-ops.ts` and the `parentId === pageId` "indented"
test already used in `makeBlockAPI`.

### 3. Coordinator on the context — `block-editor-context.tsx`

- **Enrich the focus handle.** Registry type becomes
  `Map<string, BlockFocusHandle>` where
  `BlockFocusHandle = { focus: () => void; focusAtColumn(x, edge): void;
  focusBoundary(edge): void }`. Only text editors register the rich handle; other
  block types (divider/image/page-link) register nothing, as today.
- **Add `navigate(fromId, dir, caret)`** replacing `focusUp/focusDown`: find the
  nearest neighbour in `flatOrderRef` *in that direction that has a handle*
  (skipping non-focusable blocks — fixes the silent no-op next to dividers), then:
  up → `handle.focusAtColumn(caret.caretX, "bottom")`; down →
  `focusAtColumn(caret.caretX, "top")`; left → `handle.focusBoundary("end")`;
  right → `handle.focusBoundary("start")`. Returns whether it moved.
- `BlockEditorAPI`: replace `focusUp()/focusDown()` (no-arg) with
  `navigate(dir, caret: CaretContext)`. Keep `split(position, asChild)` and add a
  low-level `applyOp(intent)` so the API methods become thin dispatch+focus and
  the *decisions* live only in `resolveKeystroke`. `makeBlockAPI.split()/merge()`
  lose their embedded tree logic (moved to the resolver); they just dispatch the
  op the resolver chose and run the existing post-op focus
  (`focusNew`/`queueMicrotask` prev-sibling focus) unchanged.

### 4. Rewrite `keyboard-plugin.tsx` to the resolver

The plugin becomes thin. For each handled key it (a) reads `CaretContext` via
`readCaretContext(lexicalEditor)` inside a Lexical read + DOM measure, (b) calls
`resolveKeystroke(...)` with `toNodes(rowsRef.current)` context, (c) executes:
- `split/merge/outdent/indent` → the corresponding thin `BlockEditorAPI` call
  (text serialized via existing `serializeBlockText`, as today).
- `nav` → `editor.navigate(dir, caret)` and `preventDefault()`.
- `selectBlock` → `selection.enterSelectionMode(blockId, extend)` (existing).
- `passthrough` → `return false` (native Lexical handling).
Register the two **new** commands `KEY_ARROW_LEFT_COMMAND` /
`KEY_ARROW_RIGHT_COMMAND` alongside the existing five.

## Files

- **Add** `plugins/page/plugins/editor/web/internal/caret-geometry.ts`
- **Add** `plugins/page/plugins/editor/web/internal/caret-geometry.test.ts` *(pure
  bits: line/column math, EPS, clamp; DOM-dependent parts smoke-tested where feasible)*
- **Add** `plugins/page/plugins/editor/web/internal/keystroke-intent.ts`
- **Add** `plugins/page/plugins/editor/web/internal/keystroke-intent.test.ts`
- **Modify** `plugins/page/plugins/editor/web/components/keyboard-plugin.tsx`
  (thin resolver dispatch; add Left/Right; visual-line Up/Down)
- **Modify** `plugins/page/plugins/editor/web/block-editor-context.tsx`
  (rich handle type, `navigate`, thin `split`/`merge`/`applyOp`, drop
  `focusUp/focusDown`)
- **Modify** `plugins/page/plugins/editor/web/components/block-text-editor.tsx`
  (register the rich `BlockFocusHandle` against `lexicalEditorRef`)
- **Modify** `plugins/page/plugins/editor/web/types.ts` (`BlockEditorAPI`:
  `navigate(dir, caret)` replaces `focusUp/focusDown`; add `CaretContext` import)
- Autogen docs regenerate via `./equin build`.

Reuse, don't reinvent:
- `getAbsoluteOffset` (offset) and `serializeBlockText` — existing in
  `keyboard-plugin.tsx` / `internal/block-text-extensions.ts`.
- `childrenOf`, `toNodes`, `BlockNode`, the `parentId === pageId` indented test —
  `core/block-ops.ts` + `internal/optimistic-block-ops.ts`.
- Caret-rect pattern — `inline-page-link-plugin.tsx:95`.
- Lexical APIs: `$getNearestNodeFromDOMNode`, `$createRangeSelection`,
  `$setSelection`, `$getRoot().selectStart()/selectEnd()`,
  `KEY_ARROW_LEFT_COMMAND`, `KEY_ARROW_RIGHT_COMMAND` (all from `lexical`).

## Boundary / architecture fit

- All changes internal to the `editor` plugin; one barrel per runtime untouched;
  no cross-plugin imports added; no registry/codegen edits. Run
  `./equin check plugin-boundaries` after.
- The reducer stays caret-free (per its own contract); the coordinator lives
  entirely on the web side, consistent with "caret/focus is imperative, not part
  of the op."

## Risks

- **DOM↔Lexical point conversion:** `caretRangeFromPoint` vs
  `caretPositionFromPoint` differ by engine — feature-detect both; fall back to
  `selectStart/selectEnd` when the point misses the root. The precise
  `$getNearestNodeFromDOMNode` path avoids async selectionchange races.
- **Collapsed caret rect can be degenerate** (empty block / empty line) — explicit
  single-empty-line fallback in `readCaretContext`.
- **Structural-key regression:** Enter/Backspace/Tab semantics are *moved
  verbatim*, not redesigned; `keystroke-intent.test.ts` pins each decision
  (asChild predicate, merge-vs-outdent, indent/outdent guards) so the unify step
  can't silently drift.
- **Non-focusable neighbours** (divider/image): `navigate` skips to the nearest
  block with a handle rather than no-op'ing — an intentional behavior improvement;
  verify caret doesn't get trapped between two dividers (it lands past them).

## Verification

1. `./equin build`; open a page with mixed blocks at
   `http://<worktree>.localhost:9000` (Pages app).
2. Unit tests: `keystroke-intent.test.ts` (every key×caret×context → intent) and
   `caret-geometry.test.ts` (line/column/EPS/clamp). Run via the repo test runner.
3. Scripted Playwright (`e2e/screenshot.mjs` as a base) on a page seeded with:
   one single-line block, one block wrapped to **3 visual lines**, an indented
   block, and a divider between two text blocks. Assert:
   - **Up** from a single-line block lands in the block above (one keypress), at
     the same pixel column (type a marker char, compare caret x before/after).
   - **Up/Down inside the 3-line block** move line-by-line *within* the block
     (native) and only cross at the true top/bottom visual line.
   - **Left** at a block's start lands at the **end** of the previous block;
     **Right** at end lands at the **start** of the next.
   - Column is preserved crossing into/out of the multi-line block (caret x within
     a few px).
   - Up/Down across the **divider** skip it and land in the text block beyond.
   - Enter (split, incl. asChild at end-with-children), Backspace (merge at top
     level, outdent when indented, passthrough mid-text), Tab/Shift+Tab still
     behave exactly as before (regression guard).
   - Shift+Up/Down at a visual edge enters block-selection; mid-block Shift+Arrow
     extends native text selection.
   - Home/End stay line-local (no block crossing).
