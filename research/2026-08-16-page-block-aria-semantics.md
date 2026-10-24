# A block type declares its ARIA identity

## Context

A page's `heading-1` / `heading-2` / `heading-3` blocks render as ordinary
editable lines. Nothing in the DOM says "heading": no `role="heading"`, no
`aria-level`, and no `<h1>`/`<h2>`/`<h3>` element on either surface. A screen
reader therefore cannot tell a heading from a paragraph, and **heading-jump —
the primary way a screen-reader user skims a document — does nothing on a
page**.

This was masked until recently: the block list declared `role="listbox"`, which
flattened the whole subtree and hid every block's semantics wholesale
(`research/2026-08-15-page-block-list-accessible-selection.md`). That role is
gone, so what each block's own DOM says is now what reaches assistive tech — and
the headings say nothing. The editor's `CLAUDE.md` records this as the known
bound of that work, and points at the right home: the **block-type presentation
API**, not the selection surface.

The constraint that makes it non-trivial: each block's editable line is its own
Lexical `contenteditable`, and `components/text-block-layout.tsx` is a **fixed
element skeleton** — the chain of element *types* from its root down to
`<LexicalComposer>` must be constant across block types, because a changed
element type at a position remounts Lexical and drops the caret. So a heading
cannot become an `<h2>` element, and cannot be wrapped in one.

**Intended outcome:** a heading is a heading in the accessibility tree, on both
the editable and the read-only surface, declared once by the block type; and the
reason the *other* structural types (lists, quote) cannot follow is recorded as a
property of the type system rather than as a comment nobody reads.

## The decision

> A block type declares **what its line IS** (`semantics`), separately from what
> the line looks like (`textVariant`) and what glyph precedes it (`marker`). The
> shared skeleton turns that declaration into ARIA attributes on the one element
> whose content is exactly the text.

Three parts, each load-bearing.

### 1. `semantics` is a fact of the TYPE, so it lives on the handle

`BlockHandle` (`plugins/page/plugins/editor/core/define-block.ts`) already holds
everything a type *is*: its `label`, its `markdownPrefixes`, its `splitInto`, its
`textVariant`. `semantics` joins them. It is deliberately **not** a `BlockChrome`
field: `chrome` is styling plus sibling regions (its `boxClassName` is documented
"PAINT ONLY"), and an accessibility role is neither. Core placement also means
one declaration serves both surfaces — the editable renderer and
`read-only-view` each already read the handle.

It is **not derived** from anything. In particular not from `textVariant`:
`textVariant` is a font-size/weight selector (`title` / `heading` / `subheading`
→ `doc-text-*` classes), and deriving heading level from visual size is exactly
the anti-pattern that makes "big text" announce as a heading. A heading declares
that it is a heading.

### 2. The union is CLOSED, on the rule that makes it safe

```ts
export type BlockSemantics = { role: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 };
```

One arm today, and the type is the enforcement, not a doc comment. Two rules
decide what may ever be added:

- **The role's ARIA required context must be nothing.** The editor renders the
  forest FLAT — a structural move must only reorder keyed siblings — so no
  element spans a run of blocks and no element wraps a subtree. `listitem`
  requires an owning `list`; a `blockquote` would have to contain the passage.
  Neither has anywhere honest to live, so neither is an arm. Adding them is not
  a new arm: it is a new mechanism on the surface that owns runs (below).
- **The role must not have presentational children.** The line hosts a
  `contenteditable`; a `button`/`option`/`tab`/`img`/`math` role would flatten
  the editing host into a label — the precise failure the block list's
  `role="listbox"` produced. `heading` is safe: it computes its name from its
  contents but does **not** make them presentational.

`aria-level` is inseparable from `role="heading"` because they are one arm — you
cannot declare a level without a heading, or a heading without a level.

### 3. Declaring it on a type that has no line is a compile error

`defineBlock` already brands text-bearing schemas (`TextBearingSchema`, from
`textBlockSchema`) and keys the typed `text` lens off it. `semantics` keys off
the same brand:

```ts
type SemanticsFor<S extends AnyZodObject> = S extends TextBearingSchema
  ? BlockSemantics
  : { __semantics_requires_a_text_bearing_schema: never };
```

— the shape `defineContainerBlock`'s `RejectTextBearing` already uses. A void
type (divider, image) or a container declaring `semantics` fails to typecheck
instead of silently doing nothing. Containers get it for free: their options
type never had the field.

### The carrier: the leaf cell, on both surfaces

`TextBlockLayout`'s **leaf cell** — `<div className="relative min-w-0 flex-1">`,
the element whose children are the Lexical composer (editable) or the
`RunsRenderer` (read-only) — is the one skeleton element whose content is exactly
the block's text. Everything that would pollute a name-from-content role sits
outside it: the marker gutter (already `aria-hidden`), the four chrome regions,
the rail, and the row's `sr-only` "Selected. " marker.

It stays a `div` and only gains attributes, so the fixed-skeleton rules hold
unchanged: no element type varies, no children-array length varies, nothing keys
on `block.type`.

Rejected carriers, for the record:

- **The `<ContentEditable>` itself** (overriding Lexical's default
  `role="textbox"`, `LexicalContentEditable.dev.mjs:84`). It would make the
  editing host the heading — but it loses the textbox role that tells a screen
  reader this is editable, and the read-only surface has no ContentEditable at
  all, so it would need a second mechanism. The nesting we get instead —
  `heading` containing `textbox` — is what `<h2 contenteditable>` produces
  natively, and accname resolves the heading's name to the embedded control's
  value.
- **Real `<h1>`/`<h2>` elements.** Forbidden on the editable surface by the fixed
  skeleton. Emitting them on the read-only surface *only* would either diverge
  the two surfaces or double the heading in the a11y tree.

### One correctness fix that comes with it

`block-text-editor.tsx`'s placeholder (`"Heading 1"`, shown while the block is
empty and focused) renders inside the leaf cell and is not hidden, so an empty
focused heading would be *named* by its own placeholder. It gets `aria-hidden` —
which is also what Lexical does to its own built-in placeholder
(`LexicalContentEditable.dev.mjs:235`).

## What this does NOT fix, and why

Both gaps are the same gap: **a role that needs an owning element, on a surface
that has no element to own it.** Both are follow-up tasks, not omissions.

- **`bulleted-list` / `numbered-list` / `to-do` are not list items.** `listitem`
  requires a `list` ancestor, and consecutive same-type siblings have no shared
  DOM element — introducing one would change a block's DOM parent whenever it
  enters or leaves the run, remounting its Lexical instance. The mechanism that
  *would* work is `aria-owns`: a zero-height `role="list"` element per run,
  grid-placed exactly the way container `frameSpans` already are, owning the run
  by row id. That is a design on the run-owning surface (and its read-only
  twin), with real risk — a11y-tree re-parenting churn over `contenteditable`
  descendants — so it is its own task.
- **`quote` / `callout` / annotation cards are not blockquotes or notes.** A
  container's decoration is a `BlockFrameProps` frame: an inert
  `pointer-events-none` backdrop painted *behind* the rows, deliberately not a
  wrapper (same remount argument). It contains nothing, so it cannot carry
  `role="blockquote"`. Same `aria-owns`-shaped answer, same follow-up.
- **`code-block` needs nothing here.** It is not text-bearing and renders its own
  component: the editable surface is a real `<textarea>` (named by its
  `placeholder="Code…"`) over an `aria-hidden` highlighted `<pre>`, and
  `read-only-view` renders `<HighlightedCode>` → a real `<pre><code>`. A
  `role="code"` on the textarea would destroy the editing semantics; the honest
  answer is the one already in place.

## Work

**`plugins/page/plugins/editor/core/block-semantics.ts`** (new)
- `BlockSemantics` (the closed union above) with the two-rule doc comment.
- `semanticsAttrs(semantics)` — the pure, exhaustive arm → DOM-attribute mapping
  (`{ role, "aria-level" }`), so the switch exists once and both surfaces spread
  the same result. Exported from `core/index.ts`.

**`plugins/page/plugins/editor/core/define-block.ts`**
- `semantics?: SemanticsFor<S>` on `defineBlock`'s options and
  `semantics?: BlockSemantics` on `BlockHandle`; passed straight through.

**`plugins/page/plugins/editor/web/components/text-block-layout.tsx`**
- New `semantics?: BlockSemantics` prop; `{...semanticsAttrs(semantics)}` on the
  leaf cell, with a comment naming the two invariants it must not break.

**`plugins/page/plugins/editor/web/components/block-text-renderer.tsx`** and
**`plugins/page/plugins/read-only-view/web/components/read-only-blocks.tsx`**
(`TextLikeBlock`) — pass `semantics={handle?.semantics}`.

**`plugins/page/plugins/editor/web/components/block-text-editor.tsx`** —
`aria-hidden` on the placeholder div.

**`plugins/page/plugins/heading/plugins/heading-{1,2,3}/core/*-block.ts`** —
`semantics: { role: "heading", level: N }`, next to `markdownPrefixes` (the two
must agree: `# ` ⇔ level 1).

**Specs**
- `core/block-semantics.test.ts` (`bun:test`) — each arm's attributes; a heading
  arm always carries a level.
- `core/define-block.test.ts` — a text-bearing type round-trips `semantics`.
- `web/__tests__/block-semantics.test.tsx` (`vitest`) — render the editor with
  h1/h2/h3 + a paragraph and assert `getByRole("heading", { level: n, name })`
  resolves and the paragraph is not a heading. This is the behavioural spec: it
  exercises the real accessible-name computation over the embedded editing host.
- `e2e/block-semantics-verify.ts` — the same three assertions in a real browser
  (`getByRole("heading", { level })`), plus: converting a paragraph into a
  heading and back keeps the caret (the fixed-skeleton guarantee) while the role
  appears and disappears.

**Docs**
- `plugins/page/plugins/editor/CLAUDE.md` — a new subsection under *A text
  block's presentation is styling plus sibling regions*, and the "Known bound"
  paragraph of *The block list is a document, not a listbox* rewritten to point
  at it and to state the two remaining gaps.

## Verification

1. `./equin build` (background) — `eslint` + `type-check` must pass.
2. `./equin test plugins/page/plugins/editor`.
3. `bun plugins/page/plugins/editor/e2e/block-semantics-verify.ts` and
   `bun plugins/page/plugins/editor/e2e/block-selection-a11y-verify.ts`
   (the second must still pass — the container's `role="group"` is untouched).
4. Manual: open a page, add H1/H2/H3, and confirm in devtools' accessibility
   pane that each line is `heading` with the right level and the text as its
   name; confirm an empty focused heading is not named by its placeholder.
