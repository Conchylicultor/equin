# Inline mark boundary caret — virtual delimiter positions

## Context

In the Page app, a block that **ends** with a marked run traps the caret inside the
mark. `` `xxxx` `` at the end of a block is one `TextNode` carrying the `code`
format bit; the caret at `offset === getTextContentSize()` is the last position
that exists. There is no "outside the span" position, so the user can never type
plain text after it. Symmetric at block start.

Inline marks are format **bits on a `TextNode`** (`Mark = bold | italic |
underline | strikethrough | code`, `core/rich-text.ts:21`), not nodes with edges.
So this is not the `decorator-nav` bug (a position that exists but isn't painted).
It is a position that **does not exist**: at a mark boundary the caret is one
point with two meanings — inside the span, or outside it — and the DOM offers one.

**The model (user's).** Behave as if every mark boundary held an invisible
one-character delimiter. Rendering is unchanged; only cursor and edit semantics
pretend the character is there.

```
`zz`|          ArrowLeft  →  `zz|`        (step inside)
`zz`|          Backspace  →  zz|          (delete the delimiter = drop the mark)
```

**Outcome.** The caret can reach the position after (and before) a mark span
anywhere in a block, typing there is unmarked, and Backspace at that position
removes the formatting — the markdown-source behavior, without markdown source.

Scope: the five marks only. `color` (a `style`) and `link` (a `LinkNode`
element) are out — see Non-goals.

## Decisions taken

| Decision | Choice |
|---|---|
| Representation | **Virtual positions**, not real zero-width text nodes |
| Depth state | **Stored explicitly**, never inferred from `selection.format` |
| Granularity | **One stop per boundary** (cap 1), not one per mark |
| Backspace-removes-the-mark | **In scope**, gated on an explicit step |
| Pending-marks indicator | **Follow-up task**, not this plan |

### Why not real zero-width nodes

Tempting (every existing mechanism would work for free) but wrong here:

- `web/internal/inline-format-surgery.ts` slices by node-local offset under a
  byte-identity precondition on `nodeText`. Its own comment: a boundary error
  there "would not mis-place a caret, it would slice the wrong characters out of
  the user's text." Phantom characters shift every one of those offsets.
- `core/runs-yjs.ts` seeds each block's `Y.Doc` with a `clientID` **derived from
  runs content**, precisely so replicas seeding the same block independently
  "converge by no-op merge". A seam node is inserted by whichever peer's caret
  happened to be at that boundary — peer-local, order-dependent content in a
  shared `Y.XmlText`. Two peers at one boundary give two seams, and `coalesce`
  won't merge them.
- Plus: `serializeBlockRuns` must strip them, copy/paste carries them into other
  apps, search indexes them.

Real seams are derived state stored as content — reconciled on every keystroke.

### Why depth must be stored, not derived

The obvious cheap design is "depth = `selection.format` diverges from the anchor
node's format bits", leaning on Lexical's `markCollapsedSelectionFormat`. **It is
aliased by three shipped mechanisms** (all verified against Lexical 0.44 source):

1. **`FormatShortcutsPlugin` (`format-shortcuts-plugin.tsx:25-31,61-67`)** fires on
   a collapsed caret by design. Lexical's collapsed branch of `formatText` is a
   pure selection toggle. Cmd+E at the end of a `` `xxxx` `` run yields
   `format = N \ {code}` — **bit-identical** to depth 1.
2. **`applyInlineFormat` (`inline-format-surgery.ts:237,288-298`)** snapshots
   `preFormat` and restores it onto the post-transform caret. So **every**
   successful `**b**` autoformat lands at `format = 0`, `node = {bold}` — a
   fabricated depth 1.
3. **Programmatic caret landings.** `TextNode.select()` leaves `format` untouched;
   `$placeCaretAtLinearOffset` deliberately resolves a boundary to the *end of the
   earlier leaf* — exactly where depth lives. `appendRunsAtJoin`
   (`collab-text-surgery.ts:288-303`) focuses an editor with no prior selection
   (format 0) and lands at the end of a possibly-bold run.

Under a derived depth, Backspace after **any** of these strips formatting from a
whole span instead of deleting a character — an invisible, destructive edit on the
undo stack. An explicit store makes depth reachable **only** by our own arrow
step, so all three take the ordinary character deletion.

Lexical's format-divergence carry is also only a **~200 ms window keyed on
`(anchorKey, offset)`** (`onSelectionChange`), not a durable state — and
`shouldSkipSelectionChange` explicitly does *not* skip at `offset === 0 ||
offset === length`, the boundary positions. `selection.format` is therefore the
**effect** (what to type with), re-asserted from the store; never the encoding.

### Why cap at 1 — and what it dissolves

A boundary sits between the left run's marks `L` and the right run's marks `R`.

> **A boundary has exactly TWO caret states — one carrying `L`, one carrying
> `R`. The browser hands you one of them (`natural`). The virtual stop is the
> other one.**

One press crosses the whole boundary; one Backspace deletes the whole boundary.

This dissolves the nesting-order question outright. Exit order would otherwise
have had to derive from `wrappersOf` reversed (`core/inline-markdown.ts:382-403`):
`code, strikethrough, italic, bold, underline` — note **not** reverse
`MARK_ORDER`, which is documented as a *storage sort key* and would exit
`underline` (the outermost wrapper, emitted before the `MARK_TAGS` loop) first.
With cap 1 the caret never stops between two delimiters, so the order is
unobservable and nothing can drift.

The stop's marks and the arrow that reaches it come out of **one** branch
(`virtualStop`), because they are one fact — which of the two states the caret is
standing in:

| Boundary | `L` | `R` | `natural` | stop | crossed by |
|---|---|---|---|---|---|
| `` `zz`| `` end of block | `{code}` | `{}` | `{code}` = L | `{}` | ArrowRight |
| `` |`zz` `` start of block | `{}` | `{code}` | `{code}` = R | `{}` | ArrowLeft |
| `` `zz`|plain `` mid-block | `{code}` | `{}` | `{code}` = L | `{}` | ArrowRight |
| `` plain|`zz` `` mid-block | `{}` | `{code}` | `{}` = L | **`{code}`** | ArrowRight |
| `` **a**|`b` `` mid-block | `{bold}` | `{code}` | `{bold}` = L | **`{code}`** | ArrowRight |

A stop exists iff `L ≠ R` **and** `natural` is one of the two sides (an element
anchor belongs to neither, so it has crossed nothing). `natural` is what Lexical
derives at the caret's own anchor — the live document, never `selection.format`.

> **CORRECTED (1) 2026-08-06, against the deployed build.** This section
> originally claimed the common mid-line seam (`marked` → `plain`) needed **no**
> stop, because the plain run's own start position already carries `{}` — and
> therefore that the key-repeat cost was confined to rare disjoint-mark seams.
> `e2e/mark-boundary-verify.ts` phase 6 falsified it: **Chromium biases the seam
> to the END of the earlier (code) node**, so `natural = {code}`, not `{}`. Every
> mark boundary gets a stop, and every one costs one extra press. That is the
> trade already chosen ("behaves consistently everywhere"), so the design stands.
>
> Two things follow. First, **mid-block was broken before this feature too** —
> the left bias means typing at `` `zz`|abc `` previously produced a *code-marked*
> character; the plan wrongly asserted that case already worked. The feature is
> worth more than it was scoped for. Second, the direction needed **no change**:
> it derives the answer from the live anchor rather than from any assumption
> about the browser, so a falsified assumption cost one test expectation and not
> a redesign. Keep it that way — do not reintroduce a `atStart || atEnd` special
> case.

> **CORRECTED (2) 2026-08-06.** The rule stated here was originally *"the stop's
> mark set is `L ∩ R`"*, and the rows above with `L ∩ R` in bold are where that
> is wrong. It shipped, and **30 e2e assertions plus a full unit suite passed
> over it**, because:
>
> > `L ∩ R` equals the correct answer exactly when the stop's own side is a
> > **subset** of `natural`'s side.
>
> That holds at every block edge (one side is the empty unmarked neighbour) and
> at the measured mid-block seam (`right ⊆ left`) — i.e. at every boundary the
> first round of tests covered. The first row where the two diverge is a marked
> run on the **right** of a seam, and there the wrong rule fails *silently*:
> `L ∩ R = {}`, `natural = {}`, so it concludes "the missing state is one the
> caret already has" and synthesizes **no stop at all**. The caret could append
> to a code span but never prepend into one — the exact mirror of the block-end
> bug this feature exists to fix, reported as "the arrows are not symmetrical".
>
> `L ∩ R` is not meaningless; it answers a *different* question, and now appears
> under its own name as `delimiterDeletion().residual` — what both runs keep once
> the delimiter between them is deleted, hence the caret's own marks afterwards.
> The lesson generalises: a stop's marks and the arrow reaching it are **one**
> decision, so they now come from one function returning both.

## Non-goals

- **`color` and `link`.** Both are wrappers in the emitted markdown
  (`wrappersOf`) but neither is a format bit. `link` needs nothing: Lexical
  already moves a collapsed caret out of an inline parent whose
  `canInsertTextAfter()` is false, and `insertText` inserts a sibling after the
  `LinkNode`. `color` is a genuine gap — stepping out of red `` `code` `` leaves
  the caret red. File as follow-up.
- **A pending-marks indicator.** Nothing today reflects a collapsed caret's
  pending format (`FormatToolbarPlugin` is gated on a non-collapsed selection), so
  depth 0 and depth 1 are pixel-identical. Follow-up task.
- **The prompt editor.** `primitives/text-editor` mounts `PlainTextPlugin` — no
  marks at all. This is page-editor-only; it does **not** belong beside
  `decorator-nav` in the text-editor primitive.

## Design

### 1. The boundary strip — pure

New `web/internal/mark-boundary.ts`. No React, no Lexical, no DOM.

```ts
export interface MarkBoundary {
  left: Mark[];    // marks of the run to the LEFT  ([] at a paragraph edge, decorator, or line break)
  right: Mark[];   // marks of the run to the RIGHT ([] likewise)
  natural: Mark[]; // what Lexical derives at this anchor (marksOfTextNode, [] for element anchors)
}

/** The state `natural` is NOT — which arrow reaches it, and what it carries. */
export function virtualStop(b: MarkBoundary): { direction: "left" | "right"; marks: Mark[] } | null;

/** What deleting the delimiter does: `left \ right` off the left span, `right \ left`
 *  off the right span, `left ∩ right` left over (and onto the caret). */
export function delimiterDeletion(b: MarkBoundary): {
  before: Mark[];
  after: Mark[];
  residual: Mark[];
};
```

Direction and marks are one return value on purpose: two independently exported
functions is exactly the shape that let a wrong mark set sit beside a right
direction for as long as they happened to agree. Likewise the deletion is split
by SIDE rather than given as one symmetric-difference list — a mark lives on
exactly one side of a boundary, so a single-direction strip walk silently
no-ops on the marks of the other side.

A block edge is modelled as **an empty unmarked neighbour** — that one choice is
what makes block-start, block-end and mid-block a single code path.

Leaf → marks: `null` → `[]`; `TextNode` → `marksOfTextNode`; line break or
decorator → `[]`. That last is not a shortcut — `walkNode` in `runs-lexical.ts`
emits both as unmarked runs, so the caret model and the persisted model cannot
drift.

### 2. The depth store — explicit, self-invalidating

New `web/internal/mark-depth.ts`. A module-private
`WeakMap<LexicalEditor, {anchorKey: string; anchorOffset: number}>`.

- **Written** only by the `markStep` executor.
- **Read** with verification: the entry counts only while the live selection is
  still collapsed at exactly that `(anchorKey, anchorOffset)`. Any other position
  reads as depth 0.
- **Cleared** on any update carrying dirty leaves (one `registerUpdateListener`),
  and on editor teardown (the `WeakMap` handles unmount).

Verification-on-read plus clear-on-content-change means the entry can never be
stale: its own key is its invalidation.

A `SELECTION_CHANGE_COMMAND` listener at `COMMAND_PRIORITY_LOW` **re-asserts** the
effect while the entry is valid — if `selection.format` has drifted off
the stop's marks (the 200 ms window lapsing on a blur/refocus or a remote patch),
set it back. The store is the truth; the format is the projection.

### 3. Threading it through — the existing architecture is respected

`keyboard-plugin.tsx` is a thin executor whose doc comment states all decisions
live in `resolveKeystroke`. That holds.

**`web/internal/caret-geometry.ts`** — `CaretContext` gains one field:

```ts
/** The mark boundary at the caret, or null when there is none (mid-run, non-collapsed). */
boundary: MarkBoundary | null;
/** True when the caret has already stepped past this boundary's delimiter. */
escaped: boolean;
```

Both computed inside the **existing** `editor.getEditorState().read(...)`, via a
module-private `$readMarkBoundary()`. `escaped` comes from the depth store, which
`readCaretContext` takes as a parameter so the geometry module stays free of
module state. Cost: one anchor read + at most two sibling walks per keystroke;
`readCaretContext` already does two full paragraph walks.

`readCaretContext` has exactly one other construction site
(`keystroke-intent.test.ts:83`) — a one-line fixture fix.

**`web/internal/keystroke-intent.ts`** — two new `KeyIntent` variants:

```ts
| { type: "markStep"; marks: Mark[] }             // selection-only; linear offset does not move
| { type: "unmark"; marks: Mark[]; side: "before" | "after" }
```

- **ArrowLeft / ArrowRight**: before the existing `atStart` / `atEnd` guards — if
  `caret.boundary` has a `virtualStop` and we are not already `escaped`,
  return `markStep`. Otherwise fall through to today's ladder unchanged.
- **Backspace**: a new rung at the **top**, above the `atStart` guard (the caret
  is at a run's *end*, so `atStart` is false and today's guard would passthrough).
  Fires **only** when `caret.escaped` — so Cmd+E, autoformat and merge landings all
  take the ordinary deletion, and Backspace-at-start on a bold line still merges
  exactly as today. **Delete** gets the symmetric rung above its `atEnd` guard.
- Enter / Tab / Up / Down: untouched. `caret.offset` is independent of the
  boundary, so `splitRuns` and every reducer path see the same numbers.

That the ladder is unchanged below the new rung is the safety property, and should
be stated in the module comment: the new rung is reachable only after an explicit
arrow step in the same interaction.

### 4. The two executors

**`markStep`** — selection only. No undo capture, no `discrete: true`
(`captureBlockDocEdit` gates *content* mutations; `placeCaretAtOffset` and friends
already do plain `editor.update()`). Set the format via `sel.formatText(mark)` per
differing mark — Lexical's documented collapsed-caret toggle, the same path
`FORMAT_TEXT_COMMAND` takes — then record the anchor in the depth store.
`preventDefault`, since the caret must not move.

**`unmark`** — a content mutation, so it needs the full contract:

- A Lexical command listener **runs inside an `editor.update()`**, where a nested
  `discrete: true` update is *enqueued, not committed*. It must therefore
  `queueMicrotask` before calling `recordDocEdit` — the same deferral `split` and
  the inline autoformat already make. `applyInlineFormat` throws on exactly this
  mistake; the new helper must too.
- Deferring means the selection may have moved, so the mutation takes a **plan**
  (linear offset + marks + side) and **re-verifies against live state** before
  mutating, aborting on drift — the `InlineFormatPlan` shape.

New `removeMarkSpan(editor, plan)` in **`inline-format-surgery.ts`** (widen its
header from "inline markdown autoformat" to "inline mark surgery"). It already
owns `prevLeafInParagraph` / `nextLeafInParagraph` (which climb out of a
`LinkNode` and stop at the paragraph), the `hasFormat`-guarded `toggleFormat`
idiom that makes the runs round-trip correct *by construction*, the
`INLINE_FORMAT_TAG` re-entrancy marker, and the `discrete` + outside-an-update
contract. A third near-identical surgery module would be worse.

**Which nodes lose the mark:** the maximal contiguous span of leaves carrying it,
walking `prevLeafInParagraph` (or `next`) from the anchor while
`$isTextNode(n) && n.hasFormat(mark)`. It stops at a leaf without the mark (the
opener's position, correct by construction), at a decorator or line break (both
unmarked in the runs model, so a span across a soft break is genuinely two spans —
document, don't "fix"), or at the paragraph start. Nodes differing in *other*
attributes are separate `TextNode`s but all carry the mark, so the whole span goes
— right, since `coalesce()` guarantees distinct-attr ⇒ distinct node.

Wire as `recordDocEdit(blockId, "Remove formatting", () => removeMarkSpan(...))`.
`captureBlockDocEdit` fences it off the 500 ms typing run with `stopCapturing()`
on both sides, so **one Cmd+Z restores the mark and nothing else**. A drift-abort
returns `null` capture and puts nothing on the stack — free.

Post-condition is self-consistent: after the strip the anchor no longer carries
the mark, so the boundary is gone and the store entry clears on the content change.

### 5. Serialization — clean by construction

`serializeBlockRuns` walks node-by-node into `coalesce`, which drops empty-text
runs and merges adjacent runs by `attrKey`. Two neighbours made identical by a
strip merge into one canonical run; zero-length and duplicated runs are
structurally impossible. The only requirement is that the strip goes **through
Lexical → the collab binding → the block's `Y.Doc`**, never a runs rewrite.

CRDT: a mark strip is a per-node property write on the `Y.Map` `@lexical/yjs`
gives each text node, converging LWW against a remote peer typing into the same
node (the remote's characters end up unmarked too — the sensible answer).

## Files to touch

In dependency order:

1. `plugins/page/plugins/editor/core/runs-lexical.ts` — export the private
   `marksOf` as `marksOfTextNode`; add to the `core` barrel. One derivation of
   `TextNode → Mark[]`, shared by the serializer and the caret read, so the caret
   model can never disagree with the persisted one.
2. `…/web/internal/mark-boundary.ts` *(new)* — pure: `MarkBoundary`,
   `virtualStop`, `delimiterDeletion`.
3. `…/web/internal/mark-boundary.test.ts` *(new)* — the four boundary shapes from
   the table above, plus the no-stop cases (equal sides, element anchor).
4. `…/web/internal/mark-depth.ts` *(new)* — the verified store + the re-assert
   listener.
5. `…/web/internal/caret-geometry.ts` — `CaretContext.boundary` + `.escaped`,
   computed by a module-private `$readMarkBoundary()` inside the existing state
   read.
6. `…/web/internal/keystroke-intent.ts` — two `KeyIntent` variants; virtual-step
   branch in ArrowLeft/ArrowRight; new top rung in Backspace/Delete.
7. `…/web/internal/keystroke-intent.test.ts` — `boundary: null, escaped: false` in
   the `caret()` fixture; new describes for the step branches, the `escaped` gate
   refusing an unmark, and the Backspace ladder proven unchanged when not escaped.
8. `…/web/internal/inline-format-surgery.ts` — widen header; add `MarkSpanPlan` +
   `removeMarkSpan`, whose strip walks BOTH sides of the seam from the two leaves
   it sits between, and repairs the caret to the deletion's `residual`.
9. `…/web/components/keyboard-plugin.tsx` — the two executor cases + a
   `recordDocEdit` latest-ref. No decisions here.
10. `…/web/internal/mark-arrival.ts` *(new)* + `caret-surface.ts`'s
    `CaretLandOptions.crossing` + `internal/caret-landing.ts` — the CROSS-BLOCK
    arrival. A block's own edge can be a boundary, and a horizontal crossing must
    meet the state facing the side it came from, exactly as a within-block step
    does. `crossing` is declared only by `landCaret`'s horizontal arms, so a
    click / focus restore / vertical crossing lands `natural` and can never arm
    the `escaped` gate.
11. `…/e2e/mark-boundary-verify.ts` *(new)* — see below.
12. `plugins/page/plugins/editor/CLAUDE.md` — a section stating the model, the
    `escaped` gate as the safety property, block edges as empty unmarked
    neighbours, and the known bounds.

## Verification

`./equin build`, then drive the deployed app.

**Automated** — new `e2e/mark-boundary-verify.ts`, modelled on
`e2e/inline-format-verify.ts` and reusing `e2e/support/blank-page.ts`
(`openBlankPage`, `blockText`, `caretState`). Assert on **persisted rows**
(`GET /api/pages/:pageId/blocks`) wherever the claim is about the data model —
`selection.format` is not readable from the DOM, and a DOM-only read would pass on
a mark that never left the browser.

1. Type `` `zz` `` (autoformats to a `{code}` run), ArrowRight, type `x` → rows are
   `[{zz, code}, {x}]`. **The load-bearing assertion.**
2. Same, then ArrowLeft, type `x` → one run `{zzx, code}` (stepped back inside).
3. Type `` `zz` ``, ArrowRight, Backspace → one unmarked run `zz`; one Cmd+Z
   restores the `{code}` mark and nothing else.
4. **The `escaped` gate.** Type `` `zz` ``, press **Cmd+E**, then Backspace → row is
   `{z, code}`; a character was deleted, no mark stripped. Repeat with the
   autoformat path (type `**b**` then Backspace → `{b}` gone, bold intact on
   nothing) and the merge path (Backspace-merge into a bold-ending block, then
   Backspace → a character goes, bold survives).
5. Block **start**: a block whose first run is bold — ArrowLeft, type → unmarked
   run first.
6. Mid-block: `` `zz` `` followed by plain text — the seam owns a stop too, and
   crossing it costs exactly one extra ArrowRight.
   *(Phases 8-10 were added after the first round: the traversal-symmetry walk,
   the MIRRORED seam `` a`aaa` `` — where the stop is the state inside the code
   run at its start, i.e. the row `L ∩ R` got wrong — and the cross-block
   arrival, whose second half proves a CLICK still lands `natural`.)*
7. Convergence in a second browser context (cold load, fresh socket).

**Manual, in the browser** — the things source cannot settle:

- ~~**Mid-block anchoring.**~~ **SETTLED 2026-08-06 — it biases LEFT.** Phase 6
  measured `caretInsideCode === true` at the seam, so `natural` is the code run's
  marks and mid-block seams do get a stop. See the corrected table above. No code
  changed; phase 6's expectations flipped.
- **Key-repeat.** Hold ArrowRight across `a**bold**c` — confirm no visible stall.
- **Durability.** Step out, Cmd+Tab away and back, type → still unmarked (the
  re-assert listener earning its place).
- **Decorator seam.** A marked run followed by a `@date` chip: confirm the chip is
  still crossable and the caret doesn't strand at the unpainted element boundary.
  `KeyboardPlugin` registers before `DecoratorNavPlugin` at the same priority, so
  a step here consumes a press DecoratorNav would have used.
- **IME.** Composition started at a virtual stop —
  `$shouldPreventDefaultAndInsertText`'s format-divergence clause is gated on
  `!anchorNode.isComposing()`, so CJK input at depth 1 may come out marked.
  Confirm; document as a known bound if so.
- **Empty marked node.** Lexical's `insertText` sets an *empty* node's own format
  from `selection.format` — typing at depth 1 into an empty marked node may rewrite
  that node's marks instead of creating a sibling. Confirm.

Also run `./equin check` (`type-check` covers the widened `CaretContext`
across both construction sites) and
`./equin test plugins/page/plugins/editor`.

## Follow-ups (file as separate tasks)

- Pending-marks indicator for a collapsed caret — the feature is currently
  invisible; ArrowRight paints nothing.
- `color` as a delimiter — stepping out of red `` `code` `` leaves the caret red.
- `decorator-nav`'s own documented bound (a decorator first/last in its paragraph
  has no far-side position) is the same class of bug and now has a neighbour that
  solves the mark half; worth revisiting whether the boundary model extends.
