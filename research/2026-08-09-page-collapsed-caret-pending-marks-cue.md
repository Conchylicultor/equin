# A collapsed caret shows the marks it will type with

## Context

In the page block editor a collapsed caret carries a **pending mark set** that
decides how the next typed character is formatted — and nothing on screen says
so. `FormatToolbarPlugin` returns early on `selection.isCollapsed()`, so a caret
gets no format surface at all.

Two positions that behave differently are therefore pixel-identical. At a mark
boundary the caret can sit inside the span or outside it (the virtual-delimiter
model,
[`research/2026-08-06-page-inline-mark-boundary-caret.md`](2026-08-06-page-inline-mark-boundary-caret.md)):
ArrowRight at the end of `` `code` `` moves nothing visible, yet it changes
whether the next character is code-marked. That design doc filed this as an
explicit follow-up, and `plugins/page/plugins/editor/CLAUDE.md` records it under
*Known bounds* as **"The feature is currently invisible."**

The gap predates that feature. Cmd+E / Cmd+B on a collapsed caret already sets a
pending mark with no confirmation, and so does every successful inline
autoformat: `applyInlineFormat` restores `preFormat` onto the post-transform
caret, so typing `**b**` leaves a caret that will type **unmarked** text beside a
bold run — currently invisible and routinely surprising.

**Outcome.** While a caret's pending marks differ from the text it is standing
in, a small chip under the caret says what the next character will carry
(`plain`, `code`, `bold code`). It disappears the moment the two agree again —
i.e. as soon as you type one character.

## The shape of it

> **Show the caret's pending mark set exactly when it disagrees with the text
> the caret is standing in.**

That one predicate covers all three sources with no case analysis:

| Situation | surrounding | pending | chip |
|---|---|---|---|
| `` `zz`\| `` after ArrowRight | `{code}` | `{}` | **plain** |
| `` `zz`\| `` back inside (ArrowLeft) | `{code}` | `{code}` | — |
| `` plain\| `` after Cmd+E | `{}` | `{code}` | **code** |
| `` plain\|`zz` `` after ArrowRight into the run | `{}` | `{code}` | **code** |
| after `**b**` autoformats | `{bold}` | `{}` | **plain** |
| ordinary caret mid-word | `{bold}` | `{bold}` | — |

It is **self-extinguishing**: typing a character creates a run carrying the
pending marks, so `surrounding === pending` and the chip goes. The chip is
therefore only ever on screen during the window where the caret is genuinely
ambiguous.

> **CORRECTED (1) 2026-08-09, after user feedback on the deployed build.** The
> one predicate above is not enough, and rows 2 and 6 of the table are where it
> shows. The rule shipped as:
>
> > Show the pending set exactly when it differs from the text the caret is
> > standing in.
>
> A mark boundary holds **two** caret states at one pixel and one linear offset,
> and that predicate names only ONE of them — `` `zz`| `` (stepped out, pending
> `{}` vs surrounding `{code}`) gets `plain`, while `` `zz|` `` (inside the run,
> both `{code}`) gets nothing. So the affordance built to make the two positions
> distinguishable left the pair asymmetric: a word appears when you step out and
> the screen goes blank when you step back, which reads as the chip clearing
> rather than as the caret being in the other state. "The two sides agree, so
> there is nothing remarkable to say" is simply the wrong test at a boundary,
> which is the one place in the document where agreement is not evidence of an
> ordinary caret.
>
> The rule is now **two arms**: show it when the caret is AT a boundary
> (`virtualStop(boundary) !== null`, either state) **or** when pending differs
> from surrounding. Same label function. Consequences: `` `zz|` `` reads `code`
> and the mirrored seam's natural state `` a|`zz` `` reads `plain` (both new),
> and an ELEMENT anchor is deliberately *not* at a boundary — `virtualStop`
> answers `null` there — so Cmd+B on an empty block still reaches the chip
> through the divergent arm alone.
>
> **What it costs**, stated because it is a real regression against the
> "self-extinguishing" paragraph above: typing INSIDE a marked run at a block
> edge now keeps a chip on screen, since the run's right neighbour is the empty
> unmarked void and the caret is still on a seam. Typing plain text and typing
> after stepping out are unaffected. The divergent arm still extinguishes on the
> next character.
>
> Verification followed: `e2e/pending-marks-cue-verify.ts` phase 3's ArrowLeft
> asserts `code` (was: no chip) and phase 5's natural state asserts `plain`
> (was: no chip). Phases 0, 1, 2, 4, 6 and 7 were re-derived under the new rule
> and are unchanged.

### Three decisions, and why

**Derived from `selection.format`, not from the depth store.** `mark-depth.ts`'s
header is emphatic that depth must never be derived from `selection.format`,
because three shipped mechanisms alias that divergence and a derived depth would
make Backspace strip a whole span. **That rule is about edit SEMANTICS and is
untouched here.** This is presentation: a display that fires for Cmd+E and for an
autoformat landing is not a false positive, it is the *whole point* — those are
exactly the two invisible cases the task names. Nothing in this change reads the
depth store, and nothing about Backspace changes.

State it in the code, because the two look alike: *the store decides what a key
does; `selection.format` decides what the screen says.*

**The chip shows only what TYPING does.** It deliberately does not say whether
Backspace will strip the mark or delete a character. The escaped state is only
reachable from the user's own arrow step in the same interaction, and the chip
appearing IS that step's confirmation — a second signal for a second fact would
double the vocabulary for the rarer half. Left as a follow-up.

**Not a new plugin — a second presentation of the surface that already exists.**
`FormatToolbarPlugin` is already a focus-less, `ViewportOverlay`-portaled,
selection-anchored overlay that owns the update + `SELECTION_CHANGE` + document
`selectionchange` listeners, the this-editor containment gate, the DOM-range rect
read, the clamp/flip positioning, and — crucially — the `active` snapshot, which
is `selection.hasFormat(mark)` per mark. **For a collapsed caret that snapshot IS
the pending set.** A separate per-block plugin would duplicate every one of those
and add a second selection listener to every block. So the plugin keeps one mount
and one listener set, and picks one of two mutually-exclusive presentations from
`selection.isCollapsed()`.

Consequence worth stating: the `Editor.FormatAction` collection is **not**
involved. The chip renders words, not controls, so it never names a contributor
and no `formatting/*` sub-plugin changes.

### Why the code chip cannot do it structurally

The task asks whether inline code — the one mark with a visible box
(`rounded-md bg-muted px-1`) — can show this in its own shape. It cannot, and the
finding is worth recording so it is not re-asked:

- Both caret states are the **same DOM position** (the end of the code
  `TextNode`), so the browser paints the caret at the same x either way.
- Restyling *that one* code span needs a class on its DOM node, and Lexical owns
  those nodes — a node mutation is a content write, which the virtual-delimiter
  design rejects for the same reasons it rejects real zero-width seams.
- The only remaining route is a **fake caret** (`caret-color: transparent` on the
  contenteditable plus our own blinking bar at the span's right edge). Rejected:
  any missed state change leaves the user with no visible caret at all, and it
  fights IME, forced-colors mode and caret blink.

## Files to touch

In dependency order.

1. **`plugins/page/plugins/editor/web/internal/caret-format-cue.ts`** *(new)* —
   pure module, no React / Lexical / DOM, unit-tested directly. It is the whole
   decision:

   ```ts
   // SUPERSEDED by CORRECTED (1) above — kept only to show what changed. The
   // shipped signature takes a third input and its arms are named for the
   // OUTCOME, since the boundary arm shows some aligned carets:
   //   { kind: "silent" } | { kind: "shown"; marks: Mark[] }
   //   caretFormatCue({ pending, surrounding, atBoundary }): CaretFormatCue
   /** What the caret will type with, and whether that is worth saying. */
   export type CaretFormatCue =
     | { kind: "aligned" }                       // pending === surrounding; show nothing
     | { kind: "divergent"; marks: Mark[] };     // marks may be [] — that is "plain"

   export function caretFormatCue(
     pending: readonly Mark[],
     surrounding: readonly Mark[],
   ): CaretFormatCue;

   /** The chip's copy. `Record<Mark, …>` so a sixth mark is a tsc error. */
   const MARK_LABELS: Record<Mark, string>;
   export function cueLabel(marks: readonly Mark[]): string;  // [] → "plain"
   ```

   A discriminated union rather than `Mark[] | null`, deliberately: `[]` is a
   *legitimate displayable value* here ("plain") and `null` would mean "nothing
   to show" — precisely the absorbable-failure shape the repo's guardrail bans.
   The label map lives here, not in `core/`: `Mark` is closed core data, but the
   chip's copy is UI, and this is its only reader. (Its register also differs
   from the toolbar buttons' `label` prop — `"code"` describes a state, `"Code"`
   names an action — so it is not a duplicate of those.)

2. **`…/web/internal/caret-format-cue.test.ts`** *(new)* — the six rows of the
   table above, plus set-equality regardless of array order and the empty-vs-
   empty aligned case.

3. **`…/web/components/caret-format-chip.tsx`** *(new)* — the rendering only.
   A `Badge` (`variant="muted"`, `shape="pill"`, `mono`) inside a
   `ControlSizeProvider size="xs"` (the overlay is portaled, so it inherits no
   ambient density). Non-interactive: `pointer-events-none`, `aria-hidden` (the
   state is already announced by the editor's own formatting commands), no
   `onMouseDown` handling needed since it can never be clicked.

4. **`…/web/components/format-toolbar-plugin.tsx`** — the presentation split, and
   the only non-trivial edit. Widen the module doc from "floating selection
   format toolbar" to "the selection format surface, in two presentations".

   - `update()` stops early-returning on `isCollapsed()`. It resolves a
     `presentation: { kind: "bar"; … } | { kind: "cue"; marks } | null`:
     - non-collapsed → today's branch, **byte-for-byte unchanged** (containment
       gate, `active`/`link`/`color`, above-preferring placement);
     - collapsed → `pending` from the same `selection.hasFormat` loop over
       `MARK_ORDER`, `surrounding` from `marksOfTextNode(anchor.getNode())` when
       it is a `TextNode` and `[]` otherwise (the same derivation
       `caret-geometry.ts` uses for `MarkBoundary.natural` — reuse the core
       export, do not re-derive, or the cue and the caret model can drift), then
       `caretFormatCue(pending, surrounding)`.
   - **Rect:** a collapsed caret's range rect has `width === 0` but a real
     height, so the existing all-zero bail passes it through. An **empty block**
     yields an all-zero rect — and Cmd+B on an empty line is a common flow — so
     the cue falls back to the editor root's rect, the same fallback
     `caretAnchor` makes for its empty-block case.
   - **Placement:** generalize the existing fit logic with a `prefer: "above" |
     "below"` argument. The bar keeps `"above"` (never covers the selection); the
     chip takes `"below"` (it must not cover the line above, and there is no
     selected text under it to hide). Both keep the horizontal viewport clamp.
   - The `pinnedRef` early return, the `blur` hide and the document
     `selectionchange` re-evaluation all stay and cover both presentations.

5. **`plugins/page/plugins/editor/CLAUDE.md`** — under *A mark boundary is a
   caret position*, replace the first *Known bounds* bullet ("The feature is
   currently invisible") with the affordance's own statement: the predicate, that
   it is derived from `selection.format` **as presentation only** while the store
   remains the sole source of edit semantics, that it deliberately says nothing
   about Backspace, and the code-chip finding above (so the structural question
   stays settled).

6. **`…/e2e/pending-marks-cue-verify.ts`** *(new)* — its own file rather than a
   phase of `mark-boundary-verify.ts`, which asserts **persisted rows** on
   purpose; this one asserts the **DOM**, and mixing the two subjects in one
   driver is how a DOM-only pass gets mistaken for a data claim. Built on the
   e2e harness + `e2e/support/blank-page.ts` (`openBlankPage`, `blockText`).

## Verification

`./equin build`, then:

```bash
./equin check
./equin test plugins/page/plugins/editor
bun plugins/page/plugins/editor/e2e/pending-marks-cue-verify.ts
bun plugins/page/plugins/editor/e2e/mark-boundary-verify.ts   # must stay green
```

`mark-boundary-verify.ts` and `inline-format-verify.ts` passing unchanged is the
real regression net: this touches the one file that listens to every selection
change in the editor, and neither suite's subject may move.

**e2e phases** (each: settle, then read the chip's text):

1. Type `` `zz` `` (autoformats to a `{code}` run) → chip reads **plain**
   immediately, with no keystroke — the autoformat-landing case.
2. Type one more character → chip gone (self-extinguishing).
3. `` `zz` `` then ArrowLeft (step back inside) → **no chip**; ArrowRight → chip
   reads **plain** again. The load-bearing pair: ArrowRight now paints something.
4. Plain text, Cmd+E → chip reads **code**; Cmd+B as well → **bold code**;
   Cmd+E again → **bold**.
5. `` a`zz` `` — ArrowRight into the run's start → chip reads **code** (the
   mirrored seam, the row a `left ∩ right` rule got wrong).
6. Click elsewhere in the block, then blur the editor → chip gone in both cases.
7. Ordinary typing across a plain paragraph → the chip never appears.

**Manual, in the browser** — what source cannot settle:

- **Key-repeat.** Hold ArrowRight across `a**bold**c`: the chip appears and
  clears at each boundary. Confirm it reads as a boundary marker, not a flicker.
- **Empty block.** Cmd+B on an empty line → chip reads **bold** (this is the
  root-rect fallback earning its place); type → gone, text is bold.
- **Autoformat flash.** Every `**b**` now flashes **plain** until the next
  keystroke. Intended and correct, but confirm it is not distracting at typing
  speed — the one judgement call worth a second opinion before merging.
- **Placement.** At the top of the viewport, at the very end of a long wrapped
  line, and inside a callout/quote container: the chip stays clamped in view and
  covers no text the user is reading.
