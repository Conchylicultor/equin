# Partial cross-block text selection in the page editor

## Context

In the page editor, every text block is its own Lexical instance and therefore its own
contenteditable *editing host*. A browser clamps a selection to the host it started in,
so dragging out of a block cannot extend it. Today the editor responds by promoting
the gesture to a **whole-block** selection once the pointer leaves the origin row
(`web/components/block-editor.tsx` `applySelectionAt`, ~1152; documented in the editor
`CLAUDE.md` § "A text drag becomes a block selection at the first boundary").

The most common editing gesture therefore does not work: select from the middle of
block A to the middle of block C, then press Delete. The expected result (Notion,
Google Docs) is that A's head and C's tail join into one block and everything between
is removed. Today it deletes A, B and C entirely.

Goal: an **editor-owned text span** that can cross blocks, with partial ends. It is
painted without a native selection, and it supports delete, type-over, cut/copy and
keyboard extension, each as a single atomic, collab-safe undo step.

All paths below are relative to `plugins/page/plugins/editor/` unless noted.

## Design

### 1. The selection is a union, owned by `use-block-selection`

`internal/use-block-selection.ts` today holds one shape, a contiguous block range. It
becomes a discriminated union:

```ts
type EditorSelection =
  | { kind: "none" }
  | { kind: "blocks"; anchor: BlockId; head: BlockId }            // today's model
  | { kind: "text"; anchor: SpanPoint; head: SpanPoint };          // new
type SpanPoint = { blockId: BlockId; offset: number };             // linear, stored-runs basis
```

- **One normaliser constructs `text` spans: `normalizeSpan(anchor, head, rows)`** (pure, in
  `core/`). It orders the two points by visible order. An endpoint on a block that has
  no text, or that cannot be a merge target (a page row, an anchor, a void block), is
  widened to the whole block. If either end widens, the result is
  `{kind:"blocks"}`. Because of this, no `text` span with a non-text endpoint can exist,
  and every consumer can assume both ends are text-bearing. Offsets are snapped to
  token boundaries (chips/dates/math are tokens in `TextRun.text`), so a cut can never
  split a token.
- **The keyboard owner does not change.** A `text` span behaves like `blocks`: the
  container holds focus and `releaseCaret` drops any DOM selection. The invariant in
  § "A native selection lives in an editing surface, or nowhere" still holds, because
  the span is a **painted** selection, not a native one.
- A `text` span whose anchor and head are in the same block is legal. That is what
  lets a drag return into its origin block without re-seating a caret, so the
  "promotion is one-way" rule (and the caret-in-a-blurred-block hazard behind it) goes
  away.

### 2. Painting: the CSS Custom Highlight API

The span is painted with `CSS.highlights.set("page-text-span", new Highlight(...ranges))`
and a `::highlight(page-text-span)` rule using the same selection token as the bands
(`bg-primary/15` equivalent). Why this API:

- It paints arbitrary DOM `Range`s **across editing hosts** with no DOM mutation and no
  native selection. A native selection is exactly what the hosts cannot hold, and DOM
  mutation would fight Lexical/Yjs reconciliation.
- Support: Chromium 105, Safari 17.2, Firefox 140, which covers every target.

New optional handle method on `BlockFocusHandle` (`internal/caret-authority.ts`, implemented
in `components/block-text-editor.tsx`, built on the existing `$linearOffsetOfPoint` /
`$placeCaretAtLinearOffset` mapping in `internal/block-text-extensions.ts`):

```ts
domRangeOf?(from: number, to: number): Range | null;   // linear offsets → DOM Range, reads only
```

A new `components/text-span-highlight.tsx` resolves one range per covered text block:
`[offA, len]` for A, `[0, len]` for the middle blocks, `[0, offC]` for C. Middle blocks
**without** text (images, dividers) keep today's row band; `resolveSelectionBands`
receives just those ids. It re-resolves when the span changes and when a covered
block's Lexical editor updates, through a new `onTextUpdate` subscription on the handle.
Remote collab edits can make an offset stale, so offsets are clamped to the current
length on re-resolve. A covered endpoint block that is removed remotely clears the
selection.

**Rule:** the span is never cached as DOM Ranges. It is offsets, and Ranges are derived
for painting.

### 3. Entering and extending a span

**Pointer** (`block-editor.tsx`, the promotion branch of `applySelectionAt`):

- **At promotion**, before `focusContainer()` releases it, read the origin's native
  selection anchor as a linear offset. Use a new handle method `nativeAnchorOffset?()`,
  wrapping `$linearSelectionSpan`. This value is the span's anchor.
- **On every move**, call `handle.offsetAtPoint(x, y)` (it already exists and moves no
  caret) on the row under the pointer to get the head. A row with no text, or a `null`
  result, gives the whole-block head. When the pointer is above or below the row, clamp
  to 0 or len. Then apply `setTextSpan(normalizeSpan(anchor, head))`.
- The `select-none` handling for the rest of the gesture and the edge auto-scroll stay
  as they are. `applySelectionAt` stays the single applier for both clocks.
- **The background marquee is unchanged**: it is still a whole-block gesture.

**Keyboard** (`internal/keystroke-intent.ts` ~677, `components/keyboard-plugin.tsx` ~250):

- On the top/bottom line, Shift+Up/Down currently gives `selectBlock`. It becomes a new
  intent, `extendSpan`. Its anchor is the current native anchor offset. Its head is the
  neighbouring text block at the caret's x, from `offsetAtPoint(caretX, edgeLineY)`.
  Shift+Left/Right at a block edge does the same, with head at offset 0 of the next
  block or len of the previous one.
- In `text` mode, `use-block-selection` `onKeyDown` moves the head as follows:
  - Shift+Left/Right moves it ±1 token (crossing blocks at the edges).
  - Shift+Up/Down moves it one visual line. The x and y come from `domRangeOf(head, head)`
    rects plus `offsetAtPoint`, and when there is no line above or below in the block,
    from the neighbouring block's edge line.
- Escape climbs the existing ladder: a `text` span becomes the `blocks` selection of
  every block it touches.
- A plain arrow collapses the span and lands a caret at its start or end, through the
  caret authority's existing landing.

### 4. Mutations: one new op, `deleteSpan`

Combining today's ops (deleteRange on A, then `delete` on the blocks between, then
`merge` of C) would cost three server transactions. A failure partway through would
leave a half-applied edit, and other clients could observe the intermediate states. It
must be **one op**, in `core/block-ops.ts`:

```ts
| { kind: "deleteSpan"; targetId: string; sourceId: string; runs?: RichText }
//   targetId = A (keeps its id); sourceId = C; runs = C's tail (live, from the doc)
```

The lines in between are **not a parameter**. The reducer (`applyDeleteSpan`, next to
`applyMerge` ~1510) derives them as the visible lines strictly between A and C, so a
client cannot pass a set that disagrees with the forest. Semantics:

1. Every visible line strictly between A and C is trashed (soft delete, as `applyDelete`
   does), **except ancestors of C**. Those are fully selected but cannot be deleted
   without deleting C, so they are unwrapped: their children are lifted, using the
   `unwrap` rule.
2. C is merged into A with `applyMerge`'s rules: A keeps its id, C's children are
   adopted, and C is trashed. A's own children that were between A and C are already
   gone after step 1. Children of a deleted block that were *not* covered (they come
   after C) are lifted, so no unselected content is ever destroyed.
3. Same refusals as `merge`, which `normalizeSpan` has already ruled out on the client.

Client executor `deleteSpan()` in `web/block-editor-context.tsx`, modelled on
`mergeBlock` (~2159). It reuses `predictOp`, `admitsRows`, `owner.untracked`,
`recordEntry` and `dropRejectedEntry`:

- **Same block:** `recordDocEdit(A, "Delete", () => surgery.deleteRange(offA, offC))`.
  No structural op is needed.
- **Cross block:** first `predictOp` plus `admitsRows` (the zoom backstop). Inside
  `untracked`, in one microtask, splice A's doc to replace `[offA, len)` with C's tail,
  using `$spliceRunsInto` (`core/runs-splice.ts`). Then `store.dispatch`, and
  `recordEntry({ before, after, runsEdits: [{blockId: A, before, after}] })`. That gives
  one undo entry and one server transaction. An unmounted A takes the
  `spliceStoredBlockDoc` path, as `mergeBlock` does.
- The op is also wired into `OP_LABELS`, `opNamedIds`, `opFocusId` and the
  `BlockOpContext` parity, and into the server op handler, which shares the reducer.

**Gestures built on it:**

- **Delete / Backspace:** `deleteSpan`, then land the caret at the join.
- **Type-over (printable key, Enter, IME composition start):** `deleteSpan`, then land at
  the join, then feed the key through the caret authority's existing `replayInput`
  buffer. This is the mechanism that already carries keys typed during an in-flight
  landing, so typing-replaces-selection needs no new input path. A new
  `onBeforeInput`/`keydown` arm in `use-block-selection` handles `text` mode only.
  `blocks` mode keeps ignoring printable keys.
- **Cut:** copy, then `deleteSpan`.
- **Paste over a span:** `deleteSpan`, then the existing caret-paste path (`splice`).

### 5. Copy

`writeClipboard` (`block-editor.tsx` ~857) branches on the selection kind. A `text` span
serialises through `serializeForest(rows, roots, { runsOverride })`, a new optional map
from block id to sliced runs:

- A gets `splitRuns(readRuns(A), offA)[1]`, and C gets `[0]` of its split.
- **The ends are read from live docs (`readRuns`), not from `data.text`**, because the
  projection lags by about 1s.
- The payload is written with `granularity: "text"`. The paste side already treats that
  as a splice into the caret line, so A's tail merges into the line being pasted into,
  as in Notion.
- The `text/plain` markdown fallback comes from the same forest.

### 6. Docs to update

Rewrite § "A text drag becomes a block selection at the first boundary" in the editor
`CLAUDE.md` as "A text drag becomes an editor-owned span at the first boundary". The
one-way rule is retired, and the § "native selection" invariant now gives the span as
its reason. Add a short § "The text span is painted, never native" covering offsets as
the source of truth, the highlight, and the clamping rule.

## Critical files

| File | Change |
|---|---|
| `core/block-ops.ts` | `deleteSpan` op, `applyDeleteSpan` reducer, labels/ids/focus |
| `core/text-span.ts` (new) | `SpanPoint`, `normalizeSpan`, token snapping, run slicing |
| `web/internal/use-block-selection.ts` | selection union, `text`-mode keyboard (delete/type/extend/escape) |
| `web/components/block-editor.tsx` | promotion → span capture, `writeClipboard` branch |
| `web/components/text-span-highlight.tsx` (new) | Custom Highlight painter |
| `web/internal/caret-authority.ts`, `web/components/block-text-editor.tsx` | `domRangeOf`, `nativeAnchorOffset`, `onTextUpdate` handle methods |
| `web/internal/keystroke-intent.ts`, `web/components/keyboard-plugin.tsx` | `extendSpan` intent |
| `web/block-editor-context.tsx` | `deleteSpan` executor (mirrors `mergeBlock`) |
| `web/serialize-blocks.ts` | `runsOverride` |
| server op handler for `/blocks/op` | accept `deleteSpan` (shared reducer) |

## Phasing

1. **Model + op:** `normalizeSpan`, `deleteSpan` reducer and server, and unit tests.
2. **Pointer span + highlight + Delete/Backspace + undo.** This is the reported use case.
3. **Type-over, cut/copy, paste-over.**
4. **Keyboard extension** (Shift+Arrow across blocks).

Phases 1–2 can ship alone.

## Verification

- **Unit (`./singularity test plugins/page/plugins/editor`):**
  - `normalizeSpan`: ordering, non-text endpoint widening, token snapping.
  - `applyDeleteSpan`:
    - A/B/C siblings.
    - A with children.
    - C nested under B (unwrap rule).
    - B with children after C (lift).
    - Same refusals as merge.
    - Client/server reducer parity.
  - jsdom: the selection union transitions (`text` to `blocks` on Escape).
- **E2E (new `e2e/cross-block-span-verify.ts`, using `support/type-lines`,
  `support/blank-page`):** type three lines, then drag from mid line 1 to mid line 3 and
  assert:
  - `CSS.highlights.get("page-text-span")` covers the expected text, and no native
    selection exists.
  - Delete leaves one block containing `head1 + tail3`.
  - Cmd+Z restores all three blocks with their text, and Cmd+Shift+Z redoes.
  - Typing `x` over a fresh span gives `head1 + "x" + tail3`.
  - Cmd+C puts the expected partial markdown on the clipboard.
  - Drag back into the origin keeps a partial span (no whole-block selection).
- **Update** `e2e/cross-block-text-selection-verify.ts`: its "promotes to whole-block"
  assertions become span assertions.
- **Collab:** with two tabs on one page, delete a span in tab 1 and check that tab 2
  converges in one step. Run the `editor-collab` e2e `crdt-newblock-verify.ts` as a
  regression check.
- `./singularity build`, then a manual check at `http://<worktree>.localhost:9000` in a
  page.

## Implementation notes (phases 3–4)

Where the build departed from the design above, and why:

- **`deleteSpan`'s `runs` is A's whole result** (head + tail), not C's tail: only
  the client knows where in A the span starts. (Phase 1.)
- **One typed character is part of the span's edit, not replayed.** Replaying it
  through the flight buffer makes it a separate typing run, so typing over a span
  cost TWO undo steps, where typing over a selection inside one block is one run.
  `joinAroundSpan(…, typed)` puts it between head and tail (wearing the head's
  trailing marks) and the caret lands after it: one op, one entry. Enter and
  other keys still ride the buffer (`CaretAuthority.landWithInput`).
- **Paste over a span is ONE entry over two ops** (`replaceSpan`): the splice is
  planned against the rows the delete leaves, both ops are dispatched under one
  entry id, and the entry brackets the whole gesture. A paste creating no line
  folds into the `deleteSpan` op itself. The undo stack's `coalesceKey` could not
  express it (a merged entry keeps the FIRST entry's undo, which does not remove
  the pasted rows).
- **The resolver reads the selection's FOCUS for Shift+Arrow** (`CaretContext.focus`):
  a range grown to a block's edge has its focus there while its anchor is mid-line.
- **Shift+Up/Down at a block edge with no line beyond is the browser's**, where
  `selectBlock` used to select the block. Whole blocks are one Escape away.
