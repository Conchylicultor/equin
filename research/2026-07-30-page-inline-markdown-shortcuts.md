# Inline markdown formatting shortcuts in the Page editor

## Context

Typing `**xxx**` in a page block should bold `xxx` and drop the delimiters, the
way Notion and every markdown-aware editor behaves. Today it does not: the
literal asterisks stay in the text. Same for `*italic*`, `~~strike~~`, `` `code` ``.

This is a **gap in the inline layer only**. Everything around it exists already:

- **Block-level** markdown prefixes work, generically. Each block type declares
  `markdownPrefixes` on its `BlockHandle` and
  `web/components/markdown-shortcut-plugin.tsx` reads them off the `Editor.Block`
  slot without naming a type. Shipping today: `# ## ###`, `* - +`, `1. `,
  `[] [ ] `, `> ` (toggle), ` ``` `, `$$`, `---`.
- **Inline marks** are already a real rich-text model, not plain text:
  `Mark = "bold"|"italic"|"underline"|"strikethrough"|"code"`, stored as
  `TextRun {text, marks?, color?, link?}` in `data.text` (`core/rich-text.ts`).
  A floating toolbar (`format-toolbar-plugin.tsx`) and Cmd+B/I/U/E/Shift+X
  (`format-shortcuts-plugin.tsx`) already apply them.

So this is one new Lexical plugin plus a pure matcher — not a new formatting model.

The second requirement is the load-bearing one. **Ctrl+Z immediately after an
auto-format must revert only the formatting, restoring the literal `**xxx**`**, so
a user who wanted real asterisks keeps them. That is not free: page text history
lives in a per-block `Y.UndoManager` whose `captureTimeout` is 500 ms
(`web/internal/use-collab-block-doc.ts`), which folds a whole typing run into ONE
undo item. A naive transform lands inside that item, so Ctrl+Z would delete
`**xxx**` entirely instead of un-bolding it.

## Scope

**In:** the delimiter-wrapping marks, one uniform mechanism.

| Typed | Result |
| --- | --- |
| `**x**`, `__x__` | bold |
| `*x*`, `_x_` | italic |
| `***x***`, `___x___` | bold + italic |
| `~~x~~` | strikethrough |
| `` `x` `` | inline code |

**Out, deliberately:**

- **Underline** — markdown has no underline syntax. Stays Cmd+U. It declares no
  delimiter, which is the proof the table is data.
- **`[text](url)` → link** — standard, but a different matcher shape (a link is
  `run.link`, not a `Mark`, and needs URL validation). Follow-up, so this change
  stays one mechanism.
- **Block prefixes** — untouched. Quote deliberately has none (`> ` went to toggle).
- **Clipboard markdown** — pasting external `**bold**` still lands literal and
  copying a bold run still emits plain text. `core/markdown.ts`'s
  `MdSerializeCtx.plain` says so explicitly ("Marks are dropped today; a future
  `ctx.md(runs)` adds `**`/`_`/`` ` ``/`[]()` rendering"). Out of scope — but the
  delimiter table below is placed so that work reuses it instead of writing a
  second copy that could drift.

## Design

### 1. The delimiter table is plain data in `core/`, not a slot

`MarkdownShortcutPlugin` reads block prefixes off a slot because **block types are
an open set** — any plugin may contribute one. `Mark` is the opposite: a **closed,
persisted `z.enum`** with a fixed `MARK_ORDER`, already enumerated in `core/`
(`MarkSchema`, `runs-lexical.ts`). A sixth mark is a core edit plus a migration,
not a contribution. The project rule applies directly — *"For a closed list both
runtimes need … prefer plain data in `core/` rather than introducing a slot"*.

Three further reasons not to hang this off the `Editor.FormatAction` toolbar slot:

- **The server will need it.** `core/markdown.ts` already declares the intent
  above, and it is a leaf both runtimes call. A table on a web render slot is
  unreachable from there, so clipboard export would grow a second copy.
- **The affordance must not depend on chrome.** `**x**` must bold whether or not
  the bold *button* is registered, reordered, or hidden.
- **Testability** — the matcher must be `bun:test`-able with no React/Lexical/slot
  bootstrap.

New file `core/inline-markdown.ts` (named to match this plugin's existing
`markdown-shortcut-plugin` / `markdownPrefixes` vocabulary). It is a syntax layer
*above* the persisted model, so it imports `Mark`/`MARK_ORDER`/`sortMarks` from
`./rich-text` rather than being appended to it.

```ts
export interface InlineSyntax {
  readonly tag: string;                 // delimiter, identical both sides
  readonly marks: readonly Mark[];      // applied together (`***` → bold+italic)
  readonly intraword: boolean;          // false for the `_` family (CommonMark)
}

/** Closed table, LONGEST TAG FIRST — the order `matchInlineFormat` tries rows in. */
export const INLINE_SYNTAXES: readonly InlineSyntax[];
```

| tag | marks | intraword |
| --- | --- | --- |
| `***` / `___` | bold, italic | true / **false** |
| `**` / `__` | bold | true / **false** |
| `~~` | strikethrough | true |
| `` ` `` | code | true |
| `*` / `_` | italic | true / **false** |

### 2. A pure, Lexical-free matcher

```ts
export function matchInlineFormat(
  textBefore: string,                    // the line up to AND INCLUDING the typed char
  ctx?: { charBefore?: string; charAfter?: string },
): InlineFormatMatch | null;             // { openStart, closeStart, tagLength, marks }
```

`null` means "this keystroke closed nothing" — the dominant legitimate outcome, the
same shape as the existing `scanTrigger`/`findTrigger` precedent in `caret-trigger`,
so it is not absorbed failure.

Rules, in evaluation order. Each one earns its place:

1. Rows are tried **longest tag first**, so `***x***` never resolves as `**` + `*x*`.
2. The text must **end with** the row's tag (the typed char closed it), with at
   least one char before it.
3. **No whitespace before the closer**; and for `intraword: false`, `charAfter`
   must be punctuation-or-space.
4. **Find the opener** by scanning backwards for the nearest occurrence of the tag
   whose following char is not whitespace ("space after the opener cancels"). A
   position rejected for that reason does not abort the row — the scan continues
   to earlier positions.
5. **Non-empty content** (strict). This is what makes `**` typable at all *and*
   what keeps ` `` ` from stealing the third backtick, so the block-level
   ` ``` ` code-fence prefix stays reachable.
6. **Repeating-char rule**: reject when the char before the opener equals the
   closing char. This is what makes `**b*` inert while typing toward `**b**`, and
   stops `**` stealing `***`.
7. **`intraword: false` → boundary before the opener** — so `snake_case_name`
   never italicizes.
8. **Code-span precedence** (CommonMark): unless the row is the code row, reject
   when an odd number of `` ` `` chars precede the opener — we are inside an
   unclosed code span, so `` `a*b*c` `` stays literal.

`core/inline-markdown.test.ts` (bun:test) covers positives with full match
equality (each row; `hello **world**`; `a*b*` intraword-star, which CommonMark
*does* emphasize; `` `a*b*` `` resolving to code over the inner italic) and the
negatives: `**`, `****`, `** x**`, `**x **`, `**b*`, `snake_case_`, `a__b__`,
`_x_` with `charAfter: "y"`, `` `a**b** ``, `==x==`, and a `\n`-spanning input.

Three **decision pins** on the table itself: rows are in non-increasing tag-length
order; every row's marks are a canonically-sorted non-empty subset of `MARK_ORDER`;
and the union of all rows' marks is exactly `MARK_ORDER` minus `"underline"` — so
adding a sixth `Mark` fails the suite until someone decides its syntax.

### 3. Applying the mark — `web/internal/inline-format-surgery.ts`

Sibling of `collab-text-surgery.ts`, same doctrine ("drive it through Lexical so
the binding syncs it") and the same `discrete: true` contract.

```ts
export function $scanInlineFormat(): InlineFormatPlan | null;          // inside a read
export function applyInlineFormat(editor, plan): boolean;              // one discrete update
export const INLINE_FORMAT_TAG = "inline-markdown-format";
```

**Scope restriction, deliberate:** the whole match must live inside the caret's own
`TextNode`. A contiguously typed `**xxx**` always is one. It buys away every
cross-node offset hazard — in particular `$placeCaretAtLinearOffset`'s documented
`<=` bias — and makes the decorator token nodes (`[[pageId]]`, `[[date:iso]]`,
`\(latex\)`) structurally untouchable, since they are separate leaves. Cost:
`**see [[page]] here**` does not auto-bold (Cmd+B still does). Documented in the
file comment.

The mutation, inside one `editor.update(fn, { discrete: true })`:

1. Abort unless the plan still matches live state (same node key, same full text,
   caret still collapsed at the recorded offset). Stricter than the block plugin's
   "recompute the remainder", because a stale offset here corrupts text rather
   than mis-typing a block.
2. Snapshot the caret's pending typing style (`selection.format` / `.style`).
3. **One `setTextContent`** removing both delimiters at once — no intermediate state.
4. `node.splitText(contentStart, contentEnd)` to isolate the content node.
5. `for (const mark of marks) if (!contentNode.hasFormat(mark)) contentNode.toggleFormat(mark)`.
   **Node-level, `hasFormat`-guarded** — byte-identically what `runs-lexical.ts:81`
   does when materializing runs, which is why the round-trip is correct by
   construction: the serializer's `marksOf` (`runs-lexical.ts:206`) reads back
   exactly these bits. Guarding on `hasFormat` is what makes `` `code` `` typed
   inside a bold run *add* code and keep bold, where a bare toggle would remove a
   mark the run already had. Not `FORMAT_TEXT_COMMAND` (a command dispatch pulls
   in other listeners for no gain) and not `RangeSelection.formatText` (a fresh
   selection has `format === 0`, making toggle-vs-set implicit over a partially
   formatted range).
6. Collapse the caret after the content, then **restore the snapshotted format**
   rather than hard-zeroing it — in the ordinary case that means the mark is OFF
   for text typed next (standard behavior), while an already-active italic/color
   context survives.
7. `$addUpdateTag(INLINE_FORMAT_TAG)` as our own re-entrancy marker. Deliberately
   no `SKIP_DOM_SELECTION_TAG` (this caret placement *must* reach the DOM, unlike
   split's background truncation) and no `HISTORY_PUSH_TAG` (there is no Lexical
   `HistoryPlugin`).

### 4. The undo boundary — the crux

New `web/components/inline-markdown-plugin.tsx`, mounted in `block-text-editor.tsx`
right after `<MarkdownShortcutPlugin>`. Because only `BlockTextEditor` mounts these
and `page/code-block` renders its own textarea over a shiki underlay instead,
inline autoformat is absent from code blocks **by construction** — no opt-out flag.

A single `registerUpdateListener`, mirroring the block-level plugin's shape:

```ts
if (tags.has(HISTORIC_TAG) || tags.has(COLLABORATION_TAG) || tags.has(PASTE_TAG)) return;
if (tags.has(INLINE_FORMAT_TAG)) return;            // our own transform
if (editor.isComposing() || !editor.isEditable()) return;
// …selection guards…
const plan = editorState.read($scanInlineFormat);
if (!plan) return;
queueMicrotask(() => recordDocEdit(blockId, "Format text", () => applyInlineFormat(editor, plan)));
```

**Selection guards.** Collapsed `RangeSelection` differing from the previous one,
anchor is a `TextNode` in `dirtyLeaves`, and **exactly one char was typed**:
`offset === prevOffset + 1` on the same anchor key, or `offset === 1` on a fresh
one. This last is deliberately stricter than `@lexical/markdown`'s own predicate,
which also admits a *decreasing* offset and therefore fires on **Backspace** —
delete the `y` from `**x**y` in Lexical's own plugin and it auto-bolds. Ours cannot.

**`queueMicrotask` is mandatory, not stylistic.** Verified against Lexical 0.44's
source: update listeners run with `editor._updating === true`, so an
`editor.update()` issued inside one is *enqueued* and only begins at
`$triggerEnqueuedUpdates` — after `captureBlockDocEdit` would already have closed
its window and reset `suppressUndoCapture`. In the microtask `_updating` is false,
so with `discrete: true` the commit runs synchronously and the binding's Yjs
transaction lands **inside** the capture window. This is the same hazard
`editor/CLAUDE.md` records for split ("defers its capture one microtask because it
runs from a Lexical command handler").

**The recorder.** Two small additions to `web/block-editor-context.tsx`, keeping
all undo recording at the documented chokepoint next to
`recordStructuralWithDocEdit` rather than importing `captureBlockDocEdit` into a
component:

```ts
recordTextEdit: (blockId, edit, label?) => void;                      // widened, default "Edit text"
recordDocEdit: (blockId, label, edit: () => void) => void;            // 4-line body:
//   const captured = captureBlockDocEdit(blockId, edit);
//   if (captured) recordTextEdit(blockId, captured, label);
```

`captureBlockDocEdit` (`use-collab-block-doc.ts:324`) already does everything
needed — **no new seam in that file**. It calls `um.stopCapturing()` on *both*
sides, suppresses the `onUndoableEdit` mirror, and returns the exact `{undo, redo}`
pair, or `null` when nothing changed.

**Why the requirement is met:**

| Step | `Y.UndoManager` | shared stack |
| --- | --- | --- |
| user types `**x*` | one open typing item | `[Edit text]` |
| final `*` typed | merged into that item | `[Edit text]` |
| microtask: leading `stopCapturing()` | typing item **closed** | |
| `applyInlineFormat` (discrete) | NEW item; mirror suppressed | |
| trailing `stopCapturing()` | format item **closed** | |
| `recordTextEdit(…, "Format text")` | | `[Edit text, Format text]` |

- **Ctrl+Z #1** pops `Format text` → `um.undo()` → `**xxx**` literal is back. The
  apply arrives tagged `HISTORIC_TAG`, which the first guard drops — **no re-fire,
  guaranteed by tag, not by heuristics**. The +1-char rule is an independent
  second line of defence.
- **Ctrl+Z #2** removes the typing run. Normal.
- **Ctrl+Shift+Z** re-applies, again `HISTORIC_TAG`, again no re-fire.
- **Typing straight after** starts a fresh item, thanks to the *trailing*
  `stopCapturing()` — so a later Ctrl+Z removes only the new typing, never the
  format. Met by the existing seam; nothing new.
- 1:1 LIFO correspondence holds (each entry pops exactly one item), so no
  `coalesceKey` — same reasoning as `recordTextEdit` today. Cmd+Z is **not**
  rebound; it stays the single per-tab binding in `apps-core/tab-surface`.

### 5. Why not `@lexical/markdown`

It is already in the lockfile (transitive via `@lexical/react`) and exports
ready-made transformers plus `registerMarkdownShortcuts`, whose listener already
carries the `historic`/`collaboration` guards. It was the preferred option and is
rejected on two grounds:

- **No seam for the capture boundary.** It owns its `editor.update()` internally
  and does not export its transform internals. An external boundary would need a
  `setTimeout(0)` after its deferred commit plus reliance on the mirror instead of
  the app's explicit window — a *second*, weaker undo-fencing mechanism beside the
  one already load-bearing for split/merge.
- **Two matchers that must agree, forever.** Requirement 2 puts a tested matcher in
  `core/` regardless. With the library that matcher becomes a *predictor* of its
  private transform, and any divergence is a silent bug in exactly the thing the
  hard requirement is about — predict-no/fires-yes merges the format into the
  typing item; predict-yes/fires-no plants a spurious undo boundary mid-run.
  Neither is unit-testable.

Secondary: its `HIGHLIGHT` (`==x==`) maps to no `Mark` in our closed enum, and its
opening-tag search walks previous siblings into text that here can neighbour
decorator tokens. We keep the *good* half by copying its guard set as reference —
tags, `isComposing`, the collapsed-and-changed selection test, `dirtyLeaves`, the
`!hasFormat("code")` gate, and the `PUNCTUATION_OR_SPACE` class. `@lexical/markdown`
stays an unimported transitive dep; no `package.json` change.

### 6. Known interactions

- **A live caret-trigger query** (`/`, `[[`, `@`, `$$`). An earlier draft of this
  plan guarded on the caret-trigger arbiter's `getOwner()`. **Dropped** — candidacy
  is published whenever the trigger string is found before the caret, *dismissed or
  not*, so one literal `[[` left in a line would silently disable markdown
  autoformat for the rest of that node: a worse, more confusing failure than the
  one it prevents. The `intraword: false` rule already neutralizes the realistic
  LaTeX case (`x_1 y_2` rejects — the char before the opener is `x`). Residual: an
  in-flight `$$a*b*` math query can still italicize, since `*` is intraword-legal.
  Accepted and documented; the correct long-term fix is the reverse direction (the
  trigger owner consuming the keystroke), not a guard here. **This drops the
  caret-trigger plugin from the change set entirely.**
- **Our transform can create a block prefix** — `~~- foo~~` strikes, leaving `- foo`,
  whose transition the block plugin converts to a bullet. Fixed by the companion
  below rather than accepted, because that fix also closes a **pre-existing latent
  bug**: `markdown-shortcut-plugin.tsx` reads text transitions with *no tag filter
  at all*, so today a remote peer's edit or a Ctrl+Z can already trip a block-type
  conversion. Adding the tag guard (advancing `prevText` before returning) fixes
  both at the source.
- **No collision otherwise**: every block prefix but `---` ends in a space, and
  `---`/` ``` ` share no char with our delimiters.

### 7. Unaffected (verified)

- **Read-only rendering** already maps all five marks
  (`read-only-view/web/components/runs-renderer.tsx:103-130`).
- **In-memory mode** (`persist={false}`, the website editor demo) is identical:
  `acquireCollabDoc` builds the `Y.UndoManager` and `captureBlockDocEdit` per
  registry entry regardless of `serverSync`; only the provider differs.
- **Committed inline tokens** are `DecoratorNode`s whose `getTextContent()` is
  `""`, and none of their delimiters use `*`, `_` or `` ` ``.
- **The ~1 s `doc → data.text` projection** carries the marks through unchanged and
  is `record: false`, so it adds no undo entry.
- **Multi-tab / remote peers**: remote applies carry `COLLABORATION_TAG` → guarded.

## Files

**New**

| File | Contents |
| --- | --- |
| `core/inline-markdown.ts` | `InlineSyntax`, `INLINE_SYNTAXES`, `matchInlineFormat` |
| `core/inline-markdown.test.ts` | bun:test — positives, negatives, decision pins |
| `web/internal/inline-format-surgery.ts` | `$scanInlineFormat`, `applyInlineFormat`, `INLINE_FORMAT_TAG` |
| `web/components/inline-markdown-plugin.tsx` | the guarded listener + microtask capture |
| `e2e/inline-format-verify.ts` | behavioral spec (below) |

**Modified** — `core/index.ts` (export the new surface);
`web/block-editor-context.tsx` (`recordTextEdit` label + `recordDocEdit`);
`web/components/block-text-editor.tsx` (mount);
`web/components/markdown-shortcut-plugin.tsx` (companion tag guard, §6);
`plugins/page/plugins/editor/CLAUDE.md` (a short subsection under the CRDT-undo
section stating the three invariants: single-`TextNode` scope, `queueMicrotask` +
`discrete: true` capture, tag-guarded no-re-fire).

Reused, not rebuilt: `captureBlockDocEdit`, `recordTextEdit`, `Mark`/`MARK_ORDER`/
`sortMarks`, `node.toggleFormat`/`hasFormat`, `e2e/support/blank-page.ts`.

**Sequencing** — 1→2 (matcher green in isolation, carries all the delimiter risk)
→ 3 (all the Lexical risk) → recorder → plugin → mount → manual smoke → e2e →
companion guard → docs.

## Verification

1. `bun test plugins/page/plugins/editor/core/inline-markdown.test.ts`.
2. `./equin build` — regenerates the registry + docs (`plugins-doc-in-sync`,
   `plugins-registry-in-sync` both need it after a new `core/` export and new files).
3. `./equin check` — `type-check`, `plugin-boundaries`, the in-sync checks.
4. `bun plugins/page/plugins/editor/e2e/inline-format-verify.ts`, following the
   `crdt-undo-verify.ts` idiom (`openBlankPage`, `report()`, `snap`). It asserts
   against the **persisted rows** via `GET /api/pages/:pageId/blocks`, not just the
   DOM — that proves the marks went Lexical → Yjs → projection:
   - every syntax row transforms, no delimiter char survives, marks canonically
     sorted (`["bold","italic"]` for `***`); plus `<strong>`/`<em>` in the DOM to
     prove the `theme.text` mapping;
   - typing ` tail` after a transform yields `[{text:"b",marks:["bold"]},{text:" tail"}]`
     — mark OFF for new text, caret landed correctly;
   - **the undo requirement**: type `**again**`, Ctrl+Z → text is exactly
     `**again**` with no `<strong>`; wait and re-assert (**no re-fire**); Ctrl+Z
     again → empty; Ctrl+Shift+Z twice → bold restored, still exactly one `<strong>`;
   - no merge into the format item: `**x**` then ` more`, Ctrl+Z → `x` still bold;
   - negatives stay literal (`snake_case_name`, `a ** b **`, `**`);
   - ` ``` ` still converts to a code block (rule 5 didn't steal the third backtick);
   - convergence: a second browser context cold-loads the page and sees the marks.
5. Manually at `http://<worktree>.localhost:9000` — type each row, then Ctrl+Z.
