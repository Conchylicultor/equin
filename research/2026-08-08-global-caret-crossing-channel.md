# A crossing is announced, not inferred — closing the mark-boundary arrival matrix

## Context

The page editor models an inline-mark boundary as a caret position that does not
exist in the document. It is synthesized, and the caret's state at it lives in a
side store (`web/internal/mark-depth.ts`) rather than in the text. Design:
[`research/2026-08-06-page-inline-mark-boundary-caret.md`](./2026-08-06-page-inline-mark-boundary-caret.md).

The consequence is that **every way a caret can ARRIVE at a boundary needs its own
patch**, and they keep being found one at a time:

1. a character move within a block — a rung in `resolveKeystroke`;
2. a crossing from an adjacent block — a `crossing` flag threaded through
   `landCaret` → `focusBoundary` → `markStepOnArrival`;
3. crossing an inline decorator — **not fixed**. A `` `code` `` run followed by a
   `[[link]]` chip, caret after the chip, one ArrowLeft lands INSIDE the code
   instead of at the boundary.

Three instances of one defect in three call sites, two of them in different
packages, with paste / find-and-replace / programmatic navigation / remote-cursor
placement all untested. The premise of the task was that the list has no reason to
be complete, and that if the position genuinely existed every arrival would
traverse it for free.

**That premise is right about the defect and wrong about the cure, and the
difference is a verified library fact rather than a judgement call.**

### The position cannot be made real while marks are format bits

Verified against `lexical@0.44.0` (`~/.bun/install/cache/lexical@0.44.0@@@1/Lexical.dev.mjs`
— `node_modules/` is not installed in this worktree; the published bundle is the
same artifact). Both candidate document-level addresses for the boundary's second
state are erased by Lexical itself:

- **`(rightLeaf, 0)` is rewritten to `(leftLeaf, len)`.**
  `resolveSelectionPointOnBoundary` (`:7669-7677`) — for a **collapsed** point at
  `offset === 0` whose previous sibling is a `TextNode`, `point.set(prevSibling.__key,
  prevSibling.getTextContent().length, 'text')`. No format check. It runs from
  `$normalizeSelectionPointsForBoundaries` (`:7701`) inside
  `$internalResolveSelectionPoints` (`:7743`), i.e. on **every** DOM→model
  resolution. And the fast-path bail `shouldSkipSelectionChange` (`:2203`) is
  `offset !== 0 && offset !== nodeValue.length` — it explicitly does **not** skip
  at leaf edges, which is exactly where boundaries are.
- **An element point at a paragraph edge is coerced to a text point.**
  `$internalResolveSelectionPoint` (`:7583-7604`): at `resolvedOffset ===
  childNodesLength` it takes the last child DOM, finds `$isTextNode`, and returns a
  text point at that node's end. Element points survive only when the child at that
  index is **not** a `TextNode` (a decorator, a `<br>`) — which is why
  `caret-geometry.ts:685` can use them and a mark boundary cannot.

The point can be *set* but not *held*: writing it via `$updateDOMSelection`
(`:8051`) provokes the `selectionchange` that undoes it.

Two corrections follow, both worth landing in the docs:

- `CLAUDE.md` and the 2026-08-06 doc attribute the left bias to Chromium
  ("**Measured**: Chromium resolves a text/text seam to the END of the left run").
  It is not Chromium — it is `resolveSelectionPointOnBoundary`. Same observable,
  but it is a deterministic, cross-browser, version-pinned **library invariant**,
  not a browser quirk that could flip. The e2e's phase-6a failure message
  ("Chromium now anchors the seam to the PLAIN node … the bias has flipped")
  describes something that cannot happen while that function exists.
- **The side store is not a workaround for a modelling mistake. It is the only
  place the second component of the caret position can live.** That is a stronger
  argument than the current "depth is STORED" prose, which rests on a list of
  empirical counter-examples.

### And the seam cannot live in the replicated document

Assessed independently; the prior doc's stated reason is **wrong** and its
conclusion is nonetheless right.

- **The CRDT convergence objection is refutable.** `Item.integrate`
  (`yjs/src/structs/Item.js:415-490`) is YATA: concurrent inserts at one origin are
  *ordered*, never merged — so two peers do mint two seams. But the predicted
  oscillation needs a peer-local dedup rule. A rule stated over converged state
  ("keep the document-first seam at this boundary, delete the rest") is a pure
  function of the merged document, both peers compute the same answer, and Yjs
  deletes are idempotent tombstones. It converges in one round. **Do not repeat the
  "two seams `coalesce` won't merge" argument — it is false.**
- **What actually kills it** is that a caret-addressable character is a real
  character in the browser's text layer. Find-in-page stops matching across it,
  double-click word selection and spellcheck segment on it, and single-line
  `Cmd+C` is *deliberately* handed to the browser (`web/internal/clipboard.ts:31`,
  `decidePaste`'s `{kind:"default"}` arm) so the seam reaches the system clipboard
  with no code of ours in the path. There is no CSS/ARIA/DOM answer to that.
- **Under-priced elsewhere**: the seam is a character in the *plain-text offset
  basis*, which is load-bearing far beyond `inline-format-surgery.ts` —
  `$linearCaretOffset`, `splitRuns`, `truncateAt`, `deleteRange`, and the
  **server-side** `plugins/page/plugins/markdown-apply/server/internal/runs-splice.ts`.
  The server splices a block's `Y.Doc` from seam-free runs, so every agent write
  would delete every seam in the block and every client would re-mint them.
- **A Lexical-only seam node, excluded from the Y doc, is not possible.**
  `CollabElementNode.syncChildrenFromYjs` (`@lexical/yjs@0.44.0`,
  `LexicalYjs.dev.mjs:529-540`) unconditionally `removeFromParent`s every Lexical
  child with no collab twin, on every remote sync. There is no exclusion seam:
  `excludedProperties` is property-level only (`:860`), the tag early-return
  (`:2595`) is whole-update, and `SKIP_COLLAB_TAG` is exported by `lexical`
  (`Lexical.dev.mjs:4414`) and **never read** by `@lexical/yjs`. Excluding a node
  means vendoring the whole of `CollabElementNode` plus its helpers — ~1,400 lines
  of a package this repo deliberately consumes unforked.

**There is exactly one door to a genuinely real position, and it is recorded below
as a costed alternative, not taken here.**

### So what the defect actually is

> A block's caret position is `(Lexical selection, stop ∈ {natural, virtual})`.
> Lexical owns the first component; this editor owns the second.
> **The second component is written by only SOME of the things that move the caret.**

That is an ownership bug, not a modelling bug. The enumeration of virtual positions
already exists and is pure and correct (`virtualStop` in `mark-boundary.ts`). What
is missing is a single arrival path.

---

## The invariant

> Every mover that relocates a caret **across** something announces the crossing on
> one channel, in the direction of travel. Every consumer of a virtual position
> observes that channel. **A crossing is declared by the mover that knows it
> happened — never inferred from a selection transition.**

Adding a virtual-position kind is one observer. Adding a mover is one call. The
matrix collapses from `movers × kinds` to `movers + kinds`.

The "never inferred" half is load-bearing and is exactly what `e2e` phase 10e
pins: a click that lands on the identical position must NOT arm the
Backspace-strips-the-mark gate. A transition-derived rule ("did the anchor cross a
boundary") cannot tell a one-character click from a one-character arrow step, and
`$placeCaretAtLinearOffset`'s merge landing looks like a unit step too. The
existing `caret-surface.ts` comment already states the rule for the block case —
"an explicit declaration by the one caller that knows a crossing happened, never an
inference from `edge`". This generalises it rather than replacing it.

---

## Design

### 1. The channel — a new leaf plugin

`plugins/primitives/plugins/text-editor/plugins/caret-motion/`, exporting from
`web/`:

```ts
/** A caret that has just been relocated ACROSS something, in the direction of travel. */
export interface CaretCrossing {
  direction: "left" | "right";
}

/** Consumers observe. Listeners return false so every observer runs. */
export const CARET_CROSSED_COMMAND: LexicalCommand<CaretCrossing>;

/** Producers announce. Safe inside or outside an editor.update(). */
export function announceCaretCrossing(
  editor: LexicalEditor,
  direction: "left" | "right",
): void;

/** The sanctioned producer form: perform the move and announce it as one act. */
export function crossCaret(
  editor: LexicalEditor,
  direction: "left" | "right",
  move: () => void,
): void;
```

`crossCaret` is the shape movers use, so "moved the caret without announcing" is
visibly wrong at the call site instead of an omission you have to notice.
`announceCaretCrossing` exists for the one producer whose move is not a callback
(the cross-block landing, which happens inside a `CaretSurface` that deliberately
does not expose its Lexical editor).

**The payload carries direction and nothing else** — no `cause: "decorator" |
"block"`. An observer branching on which contributor crossed would be the
abstraction leaking, against the repo's collection-consumer rule.

**Why a Lexical command and not a hand-rolled registry.** `triggerCommandListeners`
(`Lexical.dev.mjs:8909`) wraps each priority bucket in `updateEditorSync`, which
runs the callback **inline** when `activeEditor === editor`. So an announcement
made from inside a command listener (decorator-nav's arrow handler) reaches the
observer synchronously **within the same update**, seeing the pending selection the
crossing just produced — precisely the property `markStepOnArrival` needs and gets
today only by opening its own `editor.update()`. A command also gives per-editor
scope, automatic teardown, and an open consumer set for free.

**Why not a full "one owner of caret motion + virtual-position registry".**
Considered and rejected on three concrete grounds. (a) Owning motion means owning
`selection.modify` for every arrow press in every editor, re-implementing grapheme
clusters, RTL, IME and line logic that Lexical currently handles — to gain nothing,
because the only place a virtual position must be *inserted into* a movement is the
arrival, and arrivals are announceable. (b) "Is this press mine?" is asked *before*
the move and needs a lookahead over marks; "which state did I land on?" is asked
*after* and is generic. Merging them forces the mark lookahead into a primitive
where marks do not exist. (c) The lookahead cannot be generalised anyway:
`markArriveFor` works in the linear-offset basis where a decorator occupies
`tokenOf(node).length` characters (`block-text-extensions.ts:186`), so "one caret
step left" is not `offset - 1` beside a chip — `$resolveLinearOffset(off-1)` lands
inside the chip and correctly answers null. Announcement is the only mechanism that
works across a decorator, because only the mover knows where it landed.

### 2. Producers

- **`decorator-nav-plugin.tsx`** — wrap the crossing in
  `crossCaret(editor, isBackward ? "left" : "right", () => { … })`. Its documented
  KNOWN BOUND (a decorator first/last in its paragraph has no far-side position)
  stays true and unchanged.
- **`block-text-editor.tsx:311`** — `if (opts?.crossing) markStepOnArrival(ed, opts.crossing)`
  becomes `announceCaretCrossing(ed, opts.crossing)`. The named import of a *mark*
  module from the host component goes; the host now speaks only generic vocabulary.
- **`keyboard-plugin.tsx` `case "markArrive"`** — `placeCaretAtOffset(...)` then
  announce, instead of `markStep(..., true)`.

### 3. Consumer

`web/internal/mark-arrival.ts` — `markStepOnArrival(editor, dir)` becomes
`registerMarkArrival(editor): () => void`, a `CARET_CROSSED_COMMAND` listener at
`COMMAND_PRIORITY_LOW` returning `false`. The body is today's body minus its own
`editor.update()` wrapper (the listener already runs inside one): the read,
`virtualStop`, the `stop.direction === dir` guard, `$markStep(editor, stop.marks, true)`.
Mounted from `keyboard-plugin.tsx` beside `registerMarkDepth`, so both halves of the
caret's second component are registered in one place.

### 4. Also drop `markArrive`'s `marks` payload

The executor places the caret and announces; the observer computes the stop from the
live anchor. This leaves **exactly one** implementation of "which state does an
arrival land on". Safe by construction: `markArriveFor`'s lookahead uses
`$resolveLinearOffset`, the same resolver `$placeCaretAtLinearOffset` lands with, so
the observer reads the very anchor the lookahead described. `markArriveFor` itself
stays — it answers the different question, "is this press mine?".

### 5. Two bugs that ship with it

- **`decorator-nav-plugin.tsx:90` calls `adjacent.selectNext()` with no arguments.**
  `LexicalNode.selectNext` (`Lexical.dev.mjs:4289`) forwards them to
  `nextSibling.select(undefined, undefined)`, and `TextNode.select` defaults an
  undefined offset to `text.length`. **ArrowRight across a chip followed by text
  lands at the END of that whole run, skipping it.** `caret-geometry.ts:656`
  already passes `selectNext(0, 0)`; decorator-nav does not. `selectPrevious()` is
  correct by luck — its default *is* the end of the previous node.
  This is a precondition for the rightward mark fix: with `(nextLeaf, 0)` the
  anchor is **not** coerced (the previous sibling is a decorator, so the
  `$isTextNode(prevSibling)` arm at `:7674` does not fire), so `$readMarkBoundary`
  reads `left = []`, `right = natural`, and the announcement lands the caret
  outside a code run that follows a chip — mirroring the leftward fix exactly.
- **Backspace at a stop whose other side is a decorator** (`` `code`|[chip] ``) is
  exercised by nothing today. It needs no new code — the stop is `(codeLeaf, len)`,
  a text anchor, so `$scanMarkSpan` accepts it; `delimiterDeletion` gives
  `before={code}, after={}`; `$leafMarks` already answers `[]` for a decorator and
  `$stripMarkSpan` already stops at one — but it deserves an assertion.

### 6. Make "forgot to announce" a build error

A plugin-contributed ESLint rule at `caret-motion/lint/index.ts`, following the
`scroll-safety` shape (an allowlist naming the sanctioned homes):

> A file that registers `KEY_ARROW_LEFT_COMMAND` or `KEY_ARROW_RIGHT_COMMAND` must
> import from `@plugins/primitives/plugins/text-editor/plugins/caret-motion/web` —
> either `crossCaret`/`announceCaretCrossing` (it moves carets) or
> `CARET_CROSSED_COMMAND` (it observes them).

Today that is exactly two files, both of which satisfy it after this change. A
horizontal-arrow handler *is* a caret mover by definition, so the rule is precise.
This is the repo's stated response to a footgun: remove it, don't document it.

---

## Files

| File | Change |
|---|---|
| `plugins/primitives/plugins/text-editor/plugins/caret-motion/` | **new** leaf plugin — `package.json`, `web/index.ts` (barrel), `web/internal/caret-crossing.ts`, `CLAUDE.md`, `lint/index.ts`. No React, no components, no slot contributions: a protocol leaf. Imports nothing from `text-editor` or `decorator-nav`, so the graph stays a DAG (`decorator-nav → caret-motion`, `page/editor → caret-motion`, `text-editor → decorator-nav`) |
| `…/decorator-nav/web/components/decorator-nav-plugin.tsx` | wrap in `crossCaret`; fix `selectNext()` → `selectNext(0, 0)` |
| `page/editor/web/internal/mark-arrival.ts` | `markStepOnArrival` → `registerMarkArrival`, a channel listener; header generalises from "arriving in a block" to "arriving anywhere by a crossing" |
| `page/editor/web/components/keyboard-plugin.tsx` | register `registerMarkArrival`; `markArrive` executor announces |
| `page/editor/web/components/block-text-editor.tsx` | `announceCaretCrossing` replaces the mark-module import |
| `page/editor/web/internal/keystroke-intent.ts` | `markArrive` drops `marks`, gains `dir` |
| `page/editor/web/caret-surface.ts` | `crossing` **stays**; its doc becomes "the surface-level spelling of the generic announcement" |
| `page/editor/web/internal/mark-depth.ts` | no behaviour change; header gains the Lexical citations |
| `page/editor/CLAUDE.md` | the invariant; the channel replaces the `crossing`-flag paragraph; the two corrections above |

**Deleted, honestly: very little.** `markStepOnArrival` as an exported symbol,
`markArrive`'s `marks` payload, and the second copy of the stop computation.
`mark-boundary.ts` is pure, correct and *is* the model — nothing goes.
`mark-depth.ts` cannot go; the verification above is why.
`CaretLandOptions.crossing` stays: a `CaretSurface` deliberately has no Lexical
editor (the page title is a surface), and `focusHydratingAware`'s landing can be
async, so the declaration must cross the surface boundary as data. What changes is
that its consumer is generic.

`inline-format-surgery.ts` is **untouched**, and its byte-identity argument is
unaffected — this design changes no node, no offset and no text.

---

## The one door to a genuinely real position, recorded and not taken

**Marks as inline `ElementNode`s** (as `link` already is) is the only option whose
core claim survives scrutiny, and it should be recorded so the question is settled
rather than re-opened.

`resolveSelectionPointOnBoundary`'s collapsed arm (`Lexical.dev.mjs:7669-7677`) has
two branches: the inline-`ElementNode` branch is gated on `!isCollapsed` and so does
**not** fire for a caret, while the `$isTextNode(prevSibling)` branch does. So with
marks as elements, `(rightLeaf, 0)` **survives**, both boundary states become stable
Lexical addresses that round-trip the DOM, and the open-ended arrival-path problem
closes outright — after *any* arrival, `selection.anchor` says which side you are on.
`mark-depth.ts` and `mark-arrival.ts` both become unnecessary. Convergence is a
solved problem: `$createCollabNodeFromLexicalNode` (`LexicalYjs.dev.mjs:906`) maps an
ElementNode to a nested `Y.XmlText`, which `LinkNode` proves in production today.

It is not taken because it buys one property at the price of two:

- **There is no pending-mark channel for elements.** Lexical's only one is
  `RangeSelection.format`, an integer bitfield consumed by
  `$transferStartingElementPointToTextPoint` (`:6011-6014`). Cmd+B-then-type, the
  collapsed toolbar state and "which side" would all need a new side store — the
  thing this option exists to delete.
- **Nesting order becomes normative and observable**, which cap-at-1 deliberately
  dissolved. And remote applies commit with `skipTransforms: true`
  (`LexicalYjs.dev.mjs:2688`), so a normalizing transform would not run for them.
- Plus a hard CRDT cutover (every `page_block_docs` blob encodes `__format`; a
  mixed-version window converges in Yjs to a doc neither client renders correctly),
  partial-range toggling becoming tree surgery, and `$patchStyleText` /
  `FORMAT_TEXT_COMMAND` becoming unusable for marks.

Estimate: ~2 months, not 2 weeks. ProseMirror and Slate both keep marks as
set-valued properties on text for exactly reason 1.

---

## Verification

**0. Settle the load-bearing fact first, and keep it as a regression test.**
A jsdom vitest at `page/editor/web/__tests__/lexical-boundary-invariant.test.tsx`
using the exported `$createRangeSelectionFromDom` (`Lexical.dev.mjs:7778`, which
takes the DOM branch because `eventType === undefined`). Build a paragraph
`[{code:"zz"}, {plain:"abc"}]`, hand it an anchor of `(abcTextDOM, 0)`, read
`.anchor`. Expect `(codeLeaf, 2)`. Repeat with a `LinkNode` (a real inline element
already registered here) in place of the code run and expect `(abcLeaf, 0)`
unchanged. This pins the invariant the whole design rests on, and pins the
alternative's central claim at the same time. No browser, no build.

**1. Unit (`bun test`).** New tests in `caret-motion`: an announcement dispatches
once with the right direction; an observer returning `false` does not stop a second;
announcing into an editor with no observers is a no-op. `mark-boundary.test.ts` and
`mark-depth.test.ts` unchanged. `keystroke-intent.test.ts` — only the `markArrive`
payload and the traversal-simulation block change.

**2. E2E — `bun plugins/page/plugins/editor/e2e/mark-boundary-verify.ts` must pass
with its assertions unchanged in intent.**

- Phases 1, 2, 3, 5, 6a–c, 8, 9a–e (within-block) — same code path, byte-identical
  outcomes. Phases 8 and 9e (the traversal mirrors) are the regression gate for
  dropping `markArrive`'s `marks`: if the observer's recomputation ever disagreed
  with the lookahead, the two walks would stop being exact reverses.
- **Phase 4a/4b/4c — the safety gate.** Must pass with **no change to the test**.
  If any part of this plan is drifting toward deleting `mark-depth.ts`, phase 4 is
  what fails.
- Phase 10a/10b — the block crossing, now routed through the channel. Same
  assertions, different plumbing: this is what proves the channel is equivalent to
  the direct call.
- **Phase 10e — a click does not arm the gate.** Unchanged. This is the assertion
  that catches "announce on every selection change" if anyone is tempted to infer
  the crossing instead of declaring it.
- Phase 7 — convergence in a second browser context. Nothing new enters the
  `Y.XmlText`, so it must pass untouched; it is the gate on that constraint.

**3. New phase 11 — CROSSING AN INLINE DECORATOR.** Fixture via paste (a
two-line clipboard goes through `parseMarkdownToForest`, so the chip is
materialized; a single-line paste would leave a literal token):

```
`code`[[<pageId>]]
sentinel
```

- **11a** — caret to the end of the chip block, one ArrowLeft, settle past
  `FORMAT_WINDOW_MS`, type `X` → rows `[{code,["code"]}, {X,[]}]`. Pre-fix this
  yields `[{codeX,["code"]}]` — the reported defect, stated as data.
- **11b** — a second ArrowLeft then `X` lands *inside* the code run, proving the
  stop is one press and not a state the caret cannot leave.
- **11c** — the rightward mirror on `` [[<pageId>]]`code` ``, which also pins the
  `selectNext(0, 0)` fix: `X` lands **outside** the code run and **at its start**,
  not at the end of the run.
- **11d** — Backspace at the 11a stop strips the code mark and removes `<code>`
  from the DOM (the `$scanMarkSpan`-with-a-decorator-neighbour case).
- **11e** — traversal symmetry across the chip block (the phase 8 / 9e shape): the
  rightward and leftward offset walks must be exact reverses. This is what catches
  a stop skipped on exactly one approach, which is the shape the whole defect had.

**4. Manual.** `./equin build`, then in the **prompt editor** (the other
Lexical host) arrow across a pasted image chip both ways — confirming `crossCaret`
changes nothing where there are no observers, and confirming the `selectNext(0, 0)`
fix there too. Then `./equin check`.

---

## Risks not closed

1. **The second component is not restorable.** It lives outside the document, so it
   is lost on undo, reload and any remote edit. All of those degrade to
   `natural`/depth 0, which is the safe side — but "the caret was standing at a
   stop" is not a state the editor can restore. There is no address to restore it
   *to*; see the verification above.
2. **`markArriveFor`'s `offset ± 1` is a linear *character* step, not a caret step.**
   It is wrong for grapheme clusters — a seam right after an emoji or a combining
   mark would place the caret mid-surrogate. Pre-existing, not introduced, covered
   by no test. Worth a follow-up task, not this change.
3. **The lint rule keys on a proxy.** "Registers a horizontal arrow command" catches
   every mover that exists and every one I can imagine, but a mover relocating the
   caret from a `beforeinput`, paste or pointer handler slips through. Acceptable:
   those are not crossings, and landing `natural` is correct for them. Stated as a
   bound, not hidden.
4. **The stop is still invisible.** Depth 0 and depth 1 are pixel-identical
   (already in `CLAUDE.md` Known bounds); the decorator case makes it slightly
   worse, since a caret beside a chip is already hard to see.
5. **Announcement ordering with async landings.** `focusBoundary` is synchronous
   today, so announcing right after it is exact. If a future surface makes a
   *boundary* landing async the way `focus` already is, the announcement must move
   into the `onLanded` path. One sentence in `caret-surface.ts`.
6. `color` and `link` remain non-delimiters. Unchanged, already documented.

## Every arrival path, and which need code

| Path | Under this design | Code |
|---|---|---|
| Character move within a block | unchanged decision; arrival state comes from the channel | simplification only |
| Crossing from an adjacent block | announces instead of calling the mark module | 1 line |
| **Crossing an inline decorator** | `crossCaret`; the page editor's observer lands the stop | **the fix** |
| Buffered-arrow replay on block mount (`block-text-editor.tsx:170`) | runs only when both KeyboardPlugin and decorator-nav declined, so a seam destination was already consumed by the lookahead and a decorator destination now announces | **zero** |
| Paste | not a crossing → lands `natural`; and any paste dirties leaves, clearing the store | **zero** |
| Find-and-replace | does not exist client-side; server-side `markdown-apply` arrives as a CRDT update → dirty leaves → store cleared | **zero** |
| Programmatic nav (`placeCaretAtOffset`, jump-to-block, undo restore, `focusHydratingAware`, `appendRunsAtJoin`) | no announcement → `natural`, which is what phases 4c and 10e assert | **zero** |
| Remote cursor placement | does not exist — awareness is real but never broadcast (`collab-text-plugin.tsx:255`) | **zero** |
| A click | no announcement → `natural` (phase 10e) | **zero** |

That column is zero **by construction**, from one sentence — only an announced
crossing or an absorbed press sets the second component — rather than zero by
having checked nine cases.
