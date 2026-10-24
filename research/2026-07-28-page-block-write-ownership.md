# Page editor — one owner per fact: row writes, field-scoped patches, chrome-only type changes

## Context

Typing `/callout` (or `/quote`) and pressing Enter converts the block but leaves
the literal `/callout` text behind; on other attempts the text disappears but the
type doesn't change. Reproduced deterministically against `main` (3 runs, one
blank page each). The end state after one commit:

```
DOM / content doc:  "/callout"                    ← still there
page_blocks row:    type=callout, data.text=[]    ← converted, text cleared
```

The row and the block's CRDT content doc **permanently disagree about the same
fact**. Which symptom the user sees depends on which side wins a given render and
on whether the ~1 s projection debounce fired before Enter — i.e. the behaviour is
timer-dependent, which is itself the tell that no ordering invariant exists.

Three independent design faults produce it. All three are *regressions against the
architecture this codebase already chose* — the per-block CRDT plan
([`2026-07-07-page-per-block-crdt-plan-b.md`](./2026-07-07-page-per-block-crdt-plan-b.md))
states plainly that `page_blocks.data` holds **non-text** data, that `data.text`
"becomes a projection", and that `convert` "touches only rows". The types never
enforced any of it, so the invariants decayed silently.

**Fault 1 — a derived cache is writable like state.** `BlockEditorAPI.convertTo/update`
take a `data` blob whose type *includes* `text`, so "convert this block AND set its
text" is representable and reads as idiomatic. Five call sites do it
(`block-menu-plugin.tsx:138`, `markdown-shortcut-plugin.tsx:113`,
`keyboard-plugin.tsx:104`, and two incidental `{...data}` spread leaks in
`block-text-renderer.tsx:36` (to-do checkbox) and `callout-block.tsx:48` (callout
icon/color) that write the ~1 s-lagged row text back over the row). For a block
that already exists, carrying text through a type change is not merely wrong — it
is **unnecessary**: the content doc registry is keyed by `blockId` and survives a
type change, so the text is never at risk.

**Fault 2 — patches are full-row replacements built from a lagging snapshot.**
`commitRow` (`block-editor-context.tsx:675`) reads `rowsRef.current` (an
effect-lagged copy — the file's own comment at :452 documents the lag), transforms
one field, and `patchesFromDiff` emits a **whole `Block`**. The server writer
(`handle-patch-blocks.ts:176-189`) then blindly overwrites `pageId, parentId, type,
data, rank, expanded`. A text-only writer authors `type`. Related: `isPatchReflected`
(`optimistic-block-ops.ts:105`) compares only `parentId|type|rank|expanded` and
**never `data`**, so a data-only patch confirms vacuously as soon as the row exists.

**Fault 3 — block type is part of the text editor's identity.** `Editor.Block`
dispatches a component per `block.type`. `text`/`bulleted-list`/`numbered-list`/
`heading-1..3`/`to-do`/`toggle` all share `BlockTextRenderer`, so conversions among
them reconcile in place. `quote` (`QuoteBlock`) and `callout` (`CalloutBlock`) own
their own components — so converting into them unmounts the `LexicalComposer` and
the Yjs↔Lexical binding. **That is exactly why the bug is reported for `/callout`
and `/quote` and no other type.** `markdown-shortcut-plugin.tsx`'s header comment
still asserts the invariant this broke: *"because every text-like block type shares
one renderer, the conversion reconciles in place: the same editor keeps focus."*

**Outcome intended:** the slash menu, the markdown shortcuts and the keystroke
ladders all converge a block's type in place, with the block's text untouched in
its one owner; a single-field writer becomes structurally incapable of clobbering a
concurrently-changed field; and a text block's type change stops destroying the
caret.

## The mental model this restores

1. **One owner per fact.** Text → the block's `Y.Doc`. Structure/type/non-text data
   → the `page_blocks` row. `data.text` is a *cache* with exactly one writer
   (`projectText`) and one reader (the doc-init seed). Row text is writable only at
   **block creation** (a brand-new id has no doc to seed from) — never as an edit.
2. **Writes name the fields they change.** Restating a whole row asserts authority
   over fields you don't own.
3. **Type is chrome, not identity.** Changing a text block's type must not tear
   down the thing holding the caret.

## Stage 1 — text is doc-owned (fixes the reported bug)

**1a. Content surgery gets the missing verb.** `web/internal/collab-text-surgery.ts`
already owns this seam (`$truncateFromLinearOffset` / `truncateBlockTextFrom` /
`appendRunsAtJoin`) with its load-bearing `discrete: true` + `SKIP_DOM_SELECTION_TAG`
details. Add the sibling `$deleteLinearRange(from, to)` + `deleteBlockTextRange(editor,
from, to)`, and expose `deleteRange?(from, to)` on `BlockFocusHandle`
(`block-editor-context.tsx:143`), registered in `block-text-editor.tsx` alongside
`truncateAt`. The slash menu currently bypasses this seam entirely and pokes
`node.setTextContent()` in a *nested, deferred* update.

**1b. One "strip then convert" primitive, three callers.** Add
`convertStrippingText({ blockId, from, to, type, data })` to the block-editor
context. Order is the whole point: strip through the focus handle **synchronously,
against the doc, before** the type write. Callers:
`block-menu-plugin.tsx:83-141` (slash + gutter-`+` draft),
`markdown-shortcut-plugin.tsx:105-115` (`* `, `> `, `# ` …),
`keyboard-plugin.tsx:104-106` (Backspace-at-start reset / empty-Enter break-out —
strips nothing, so it calls plain `convertTo`). Today these are three hand-rolled
copies of the same operation with three different orderings.

**1c. Make the illegal write a type error.** In `web/types.ts`:

```ts
/** Row data minus the projection-owned `text` key — what a row-writing API accepts. */
export type RowData = Record<string, unknown> & { text?: never };
```

`BlockEditorAPI.update(data: RowData)` and `convertTo(type: string, data: RowData, …)`.
`insertAfter`/`split`/`BlockOp.insert.data`/`split.tailData` keep accepting text —
those create a *new* id, and the row is that doc's only seed
(`use-collab-block-doc.ts:191-207`). `{ text?: never }` turns any object literal
carrying `text` into a compile error while leaving text-free payloads untouched.

`convertTo` must then **preserve** the row's existing `data.text` rather than drop
it: `commitRow(blockId, b => ({ ...b, type, data: preserveText(b.data, next) }))`.
That is the single place in the row pipeline permitted to mention `text`.

`BlockHandle.empty()` returns `{ text: [] }` for text-bearing types
(`define-block.ts:89`), which is correct for creation. Add a derived
`emptyRowData()` (= `empty()` minus `text`) in `define-block.ts` for the convert
path, so no call site hand-strips.

**Fixed for free:** the to-do checkbox and callout icon/color leaks — flipping
`checked` while typing can currently write lagged text back over the row.

## Stage 2 — field-scoped patches

Replace the full-row upsert with an explicit create/update split in
`core/block-diff.ts`:

```ts
type BlockFieldChanges = Partial<Pick<Block, "parentId" | "type" | "data" | "rank" | "expanded">>;
interface BlockPatch {
  creates: Block[];                                   // full rows — a new row has no prior state
  updates: { id: string; changes: BlockFieldChanges }[];
  deleteIds: string[];
}
```

`updateOnly` disappears: an update naming a missing id is a skip *by definition*,
which is precisely what that flag was approximating.

- `diffBlocks`/`patchesFromDiff` emit only changed fields; the undo patch inverts
  exactly those fields (creates ↔ deletes swap as today).
- `applyPatch` (`web/internal/optimistic-block-ops.ts:137`) merges fields instead of
  swapping rows.
- Both patch predicates check **every field the patch names**, over one shared
  comparator. (Superseded on rebase: `main` had meanwhile split the predicate in
  two — `isPatchAbsorbed` counts `data`, `isPatchReflected` deliberately does not,
  since server truth legitimately differs. The field scope is what landed; the
  "confirmation should compare `data`" half did not.)
- `handle-patch-blocks.ts` writes only the named columns. Care: `parseBlockData`
  validates against the *effective* type, so a `data`-only change must validate
  against the stored type; the three-way partition becomes two-way
  (`creates` may untrash, `updates` never create) and the page-type transition
  guard keys off `changes.type`.
- `web/internal/composition.ts` (`groupPatchByOwnerPage:269`,
  `translatePatchForStore:308`) resolves the owner page from current rows rather
  than from `upsert.pageId`, which an update no longer carries.
- `commitRow` reads `liveRowsRef` (render-fresh) instead of `rowsRef`; with
  field-scoped changes, staleness of *untouched* fields stops mattering at all —
  that is the structural half of the fix, the fresher read is belt-and-braces.
- Endpoint contract `patchBlocks` (`core/endpoints.ts:169`) + `BlockPatchSchema`
  follow. `useMemoryBlockStore` reuses `applyPatch`, so it follows for free.
  `replacePageContent` does not use `BlockPatch` and is unaffected.

## Stage 3 — a text block's type change is chrome-only

Give the handle a declarative chrome facet so **one** component renders every
text-bearing type, keeping the React element tree stable across a conversion (only
class names and the marker node change):

```ts
// define-block.ts — method syntax, per the existing bivariance note (:48-53)
chrome?(data: T, editor: BlockEditorAPI): {
  containerClassName?: string;   // quote: "border-l-2 border-muted-foreground/30 italic"
  containerPadding?: SpacingProps; // callout: Inset x=BLOCK_INSET y="xs"
  inset?: boolean;               // callout: false (its box already insets)
  marker?: ReactNode;            // callout: <CalloutIcon …/>
  contentClassName?: string;
};
```

- `BlockTextRenderer` (which already resolves marker / ordinalMarker / toggle /
  textVariant generically off the handle) applies `chrome` onto a **fixed** element
  tree. Both of today's wrapper components are expressible: quote is border classes;
  callout is background classes + an interactive marker + `inset: false`.
- Delete `QuoteBlock` and `CalloutBlock` as dispatch components (keep `CalloutIcon`
  as the marker). All ten text-bearing types then dispatch the same component.
- **Make the regression unrepresentable:** a text-bearing contribution must not be
  able to supply its own `component`. Type `BlockContribution` (`web/slots.ts:24`)
  as a union — `{ block: TextBearingHandle }` (component supplied by the slot) |
  `{ block: VoidHandle; component }`. If the union proves awkward against
  `defineOrderedDispatchSlot`, fall back to a plugin-contributed check
  (`plugins/page/plugins/editor/check/index.ts` is the precedent) asserting
  `acceptsText ⇒ shared renderer`.
- Bonus, same declaration: `read-only-view`'s `TextLikeBlock`
  (`read-only-blocks.tsx:101-222`) hardcodes `handle.type === "callout"` and
  `=== "quote"` branches; it can consume `chrome` and drop them.

Out of scope: `code-block` (a `<textarea>` + `useEditableField`, `acceptsText: false`,
no Lexical) and the void media types keep their own components — converting text →
divider *should* destroy the editor.

## Verification

```bash
./equin build
bun test plugins/page/plugins/editor/core          # block-diff, block-ops, define-block
bun run test:dom plugins/page/plugins/editor
./equin check
```

New `plugins/page/plugins/editor/e2e/convert-in-place-verify.ts` (reuse
`openBlankPage`/`blockText`/`caretState` from `./support/blank-page`, and read
authoritative rows via `GET /api/pages/:pageId/blocks` — the repro harness that
found this). For each of `/callout`, `/quote`, `/h1` and the `> ` markdown
shortcut, assert:

1. the block's `type` changed;
2. the `/query` (or `> `) marker is gone from the **DOM** *and* from `data.text`;
3. `data.text` ≡ the DOM text — the divergence check that fails today;
4. the block id is unchanged and the caret is still collapsed inside it;
5. typing immediately after commit lands in that same block;
6. a second browser context loading the page converges to the same text.

Regression: the existing `crdt-*-verify.ts`, `enter-at-start-verify.ts`,
`indent-caret-verify.ts` suite. Plus one targeted case for the Stage-1 leak —
toggle a to-do checkbox mid-typing and assert the text does not revert.

## Suggested landing order

Three commits, each independently shippable and each leaving the tree green:
**Stage 1** (fixes the reported bug and the two spread leaks), **Stage 2** (removes
the clobber hazard and the vacuous confirmation), **Stage 3** (removes the remount,
and the class of caret/focus loss on convert).
