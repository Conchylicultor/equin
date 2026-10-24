# dom-selection

The single sanctioned home for reading the **document's** selection — the
browser's own caret and highlight. Web-only, and a true leaf: it imports
nothing, not React, not Lexical, not the floating-surface primitive.

## API

- `selectionRange()` → `Range | null` — the live selection's range, or `null`
  when there is none to read.
- `selectionRect()` → `DOMRect | null` — that range's bounding rect, gated on
  `hasBox`, or `null` when there is no selection or it carries no box.
- `hasBox(rect)` → `boolean` — `rect.width !== 0 || rect.height !== 0`.
- `selectionIsCollapsed()` → `boolean` — whether the user has nothing
  highlighted right now (no selection, no range, or a collapsed one).

## The three-part guard is why this exists

Reading the selection looks like a one-liner and is not. Three things can go
wrong, in order:

1. **There is no selection object.** `window.getSelection()` returns `null`.
2. **The selection carries no range.** `rangeCount === 0` — the ordinary state
   of a document nobody has clicked into.
3. **`getRangeAt(0)` throws anyway.** It raises `IndexSizeError` (a
   `DOMException`) when the range is invalidated between the count check and
   the index read. This is the part everyone forgets, because it never fires
   while you are testing by hand.

Four hand-rolled copies of this read existed before the primitive and exactly
**one** — `caret-trigger`'s `liveCaretRect`, inside `caretAnchor` — had all
three. `page/editor`'s `caret-geometry.ts` and `primitives/diff-view`'s copy
handler each had the first two and not the third. Each of them was correct
against the cases its author could produce by hand, and each carried the same
latent throw.

The `catch` here is narrowed to `DOMException` and **rethrows** anything else,
per the repo's fail-loudly rule: it absorbs exactly the one failure it can
answer for.

## Why `dom-selection`, not `selection-rect`

Two reasons, and the second is the load-bearing one:

- It owns the **range** read, not only the geometry. `diff-view`'s copy handler
  wants the range to work out which cells the user selected — content, not a
  box. A primitive named for the rect would have pushed that consumer back to a
  raw `getRangeAt`, which is precisely the copy the rule below exists to stop.
- The name distinguishes it from Lexical's model `$getSelection`, which answers
  about the editor's node tree and can disagree with the DOM at any instant.
  `page/editor`'s `format-toolbar-plugin` holds both in one file and juggles the
  distinction line by line; a helper called `selectionRect` would read as either
  one.

## `selectionIsCollapsed` — a clipboard handler cannot ask Lexical

The section above says the model "can disagree with the DOM at any instant". For
one consumer it cannot even find out, and a handler that guesses wrong ships a
bug that looks like it lives somewhere else entirely.

**During a `copy` or a `cut`, Lexical never looks at the document.**
`$internalCreateRangeSelection` re-derives the model from the DOM only for an
allow-listed event set — `selectionchange`, `beforeinput`, the composition
events, a triple `click`, `drop` — and returns `lastSelection.clone()` for
everything else. `copy` and `cut` are everything else. So a clipboard handler
reads the model as it was last synced, and has no way to recover if that is out
of date.

**And it goes out of date under rapid input.** The model is synced on
`selectionchange`, which the browser fires in a LATER task than the keystroke
that moved the selection, so until it lands the model describes the caret as it
was BEFORE the gesture. (The page editor's e2e harness already documents that
lag, from the opposite side, in `e2e/support/caret.ts`.)

The damaging shape is a gesture that goes from a caret to a full selection in
**one step** — `Shift+Home`, `Shift+End`, `⌘A`, a drag, a triple-click — because
then "stale" means COLLAPSED: the document plainly has a highlight while
`isCollapsed()` says nothing is selected. Only the FIRST step of a gesture has
that shape; from the second `Shift+Arrow` on the model is merely one character
behind, so the check comes out right. That asymmetry is why the page editor's
whole-line `⌘C` bug read as "only whole selections are wrong" — and why it read
as a *paste* bug, though the paste was faithfully doing what the copy had put on
the clipboard.

The document's own selection has neither problem: it IS what the native copy is
about to act on. When a handler needs both facts — "is the caret in MY editor"
(model) and "did the user select something" (document) — it asks each of the
right one and acts only when they agree.

## `hasBox` — a rect with no box is not an anchor

A collapsed caret is zero-**wide** but never zero-tall, so it passes. A range
that resolved to nothing paintable — an empty block, or a collapsed caret beside
an inline `contenteditable=false` chip — yields an all-zero rect and does not.
That distinction matters because an all-zero rect does not fail: it places the
surface at the viewport origin instead of at the caret, visibly wrong and
silently so, and callers need to know to fall back to a containing box.

This was previously spelled three ways: `caret-anchor`'s all-four-zero test,
`caret-geometry`'s private `usable()`, and `format-toolbar`'s `isEmptyRect()`.
The two `width || height` versions are correct; the all-four-zero one is the
outlier, since a rect with a position but no box is still nothing to anchor to.
`hasBox` takes the `width || height` form — strictly stricter than the outlier,
and in practice inert, because a rect with a nonzero position and an all-zero
box does not arise from the reads that produced it.

## Don't hand-roll `getRangeAt`

Enforced by the `dom-selection-safety` lint rule
([`no-raw-selection-range`](../../../../../framework/plugins/tooling/plugins/lint/plugins/dom-selection-safety/lint/no-raw-selection-range.ts)),
whose only exemption is: this plugin's
`web/internal/dom-selection.ts`. Every caller was migrated rather than
exempted — a rule that needs an allowlist entry for a *correct* use is
enforcing less than it looks.

Bare `getSelection()` stays legal. `.toString()`, `.anchorNode`,
`.isCollapsed` and `.removeAllRanges()` are widely and legitimately used and
need no guard; `getRangeAt` is the one read that does.

## What this is NOT

- **It does not own `caretAnchor`.** That is a live virtual element for one
  specific primitive's `anchor` prop — `FloatingSurface`'s — with exactly one
  consumer. It stays plugin-private in
  [`text-editor/caret-trigger`](../../../text-editor/plugins/caret-trigger/CLAUDE.md),
  rebuilt on `selectionRect()`. Promote it when a second consumer appears, not
  before.
- **It does not own line-box geometry.** `page/editor`'s `caret-geometry.ts`
  builds a richer answer on top of `selectionRange()`: where the caret's own
  visual LINE is, which is what you want when the collapsed range itself paints
  nothing. That is editor knowledge — soft line breaks, decorator chips — and
  belongs with the editor, not here.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The one sanctioned home for the guarded document-selection read: selectionRange() states the three-part guard (no selection → rangeCount 0 → getRangeAt(0) throwing IndexSizeError) that four hand-rolled copies each remembered a different subset of, selectionRect() is that range's bounding rect, hasBox(rect) is the one statement of 'a rect with no box is not an anchor', and selectionIsCollapsed() answers 'does the user have anything highlighted right now' — the question Lexical's model gets wrong for a whole task after a one-step selection gesture. Named for the DOM selection to keep it apart from Lexical's model $getSelection; owns the range read too, since a copy handler wants the range for its content, not its geometry.
- Cross-plugin:
  - Imported by:
    - `conversations/conversation-view/selection-actions`
    - `page/editor`
    - `primitives/diff-view`
    - `primitives/dom/copy-source-text`
    - `primitives/text-editor/caret-trigger`
- Exemptions:
  - Exempts itself from: `dom-selection-safety/no-raw-selection-range` — `web/internal/dom-selection.ts` (sanctioned)
- Web:
  - Exports (values):
    - `hasBox`
    - `selectionIsCollapsed`
    - `selectionRange`
    - `selectionRect`

<!-- AUTOGENERATED:END -->
