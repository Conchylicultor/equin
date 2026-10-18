# go

`<go>…</go>` marks a part of the agent's answer the user can pick as their
reply — an option, a next step, a follow-up. The agent answers normally and
wraps only the quotable part. The text stays where the agent wrote it, drawn
as ONE tinted unit, `[text | ▶]` (`web/components/go-cap.tsx`): **▶** sends it
as a turn, **clicking the text** puts it in the draft to edit. A block is a
tinted card with the actions as a rail on its right edge, **✎** over **▶** —
a checklist has no text to click. Outside a conversation pane there is no
prompt to reach, so only the tint renders.

## One look in three places

The reply, the draft and the sent message draw a Go the same way. An inline
Go wears `GO_INLINE_BOX`: the prompt templates' chip colours (the outline
button's `outline-fill` / `outline-border` palette tokens) at inline `code`'s
padding, so it reads as the same control as the template chips, at the height
of the `code` spans beside it — and, where there is an action, a cap closing
the unit on the right (▶ in the reply, ✕ in the draft). A block is a card in
`GO_TINT` (`bg-primary/5`) with its words in their normal colour. The cap is an INLINE span, never an inline-block button: an
inline box with the text's own font size is exactly as tall as the tinted text
it closes, so the two halves line up and wrap together. Checklists keep their
boxes everywhere: pickable rows in the reply, ticked lines in the draft and in
the sent message.

**One shape rule, one item syntax.** Card or chip is decided on all three
surfaces by active-data's `isBlockForm` (`@plugins/active-data/core`) over the
text between the tags — a line break inside them, i.e. `<go>` ending its line,
makes a card, even around one item: the reply's segmenter calls it, the sent
message's `GoEcho` calls it on the region's body, and the draft's region scan
(`go-regions.ts`) calls it on the region's text read off the editor. A
checklist line is read through `parseGoItem`, and the draft's pick token
pattern (`GO_PICK_RE`) is built from the same bullet spelling in
`parse-go.ts`, so a new spelling reaches all three at once.

## The language

**Inline** — one line, wherever it is written (beside prose or on its own line):

```
I've done the change. Should I <go>implement it</go>? Or <go>file a task</go>?
```

**Block** — a multi-line `<go>`: the open tag ends its line (prose before it
on that line, `Want me to file any of these? <go>`, renders as its own
paragraph above the card). A `- [ ]` checklist
inside becomes pickable rows; `- [x]` pre-picks the ones the agent recommends:

```
Possible follow-ups:

<go>
- [ ] The tab bar flickers when a tab is torn off
- [x] Improve popover ignores ⌘↵ with a chip attached
</go>
```

**Table** — when each item carries columns (a review, an audit, a comparison),
the table IS the choice: a Markdown table inside `<go>` whose rows each start
their first cell with the checklist's mark. Don't follow a table with a
checklist repeating its row names.

```
<go>
| Item | Problem | Proposed |
|---|---|---|
| [x] **Themes** | "wear" | Each app can have its own theme, … |
| [ ] **Music** | Too much detail | A piano app and a chord ear trainer, … |
</go>
```

A table is a pick table only with a header, its `|---|` rule, and a mark
leading EVERY row's first cell; any other table in a Go is prose. One set of
items per Go: a checklist after a pick table (or a table after a checklist) is
prose too. In the reply (`GoTable`) the whole row is the target, an unpicked
row is dimmed, and the header's box checks or clears every row. Cells — like
every item's words, on every surface — render as inline markdown
(`GoItemText`: `<Markdown inline>`).

## What is sent back

Picking it sends it back **wrapped in `<go>`**, so the agent reads the part of
its own answer the user picked, rather than a question from the user (`goWire` in
`web/internal/parse-go.ts`):

- one line → `<go>implement it</go>`
- a checklist → ONLY the picked lines, as `- [x]` — any other text in the
  block and the declined items are dropped (the agent wrote them; they are in
  its history):

  ```
  <go>
  - [x] Improve popover ignores ⌘↵ with a chip attached
  </go>
  ```

- a table → the same checklist: each picked row as a `- [x]` line of its
  FIRST cell. The other columns are the agent's own words, in its history, so
  the draft and the sent message hold just the item names.

▶ is disabled until an item is picked; ✎ with none picked hands every item
over to trim. Once the picks differ from the agent's own (`- [x]`), **Reset**
beside the count puts them back.

**In the draft** (✎, or a click on an inline Go's text) the same text is inserted, the close tag moved onto
the last line (`goDraft`) so the caret lands below the region. `<go>` and
`</go>` become marker tokens (`web/internal/marker-node.tsx`): the opening one
draws nothing, the closing one the ✕ that drops the whole region
(`$removeGoRegion` in `web/internal/go-regions.ts`) — a cap on one line, a
rail on a box's right edge (placed where the region plugin measured it,
`web/internal/go-rails.ts`), and the words between stay
ordinary editable text — so the draft's markdown is exactly what is sent, with no
serializer of its own. A picked line's `- [x] ` prefix is a token too, drawn as
the checked box the agent's checklist rows use (`pick-node.tsx`). `GoRegionPlugin` paints each region: one line tinted in
place, several as a rounded box — a background layer on the editor root,
measured from the markers, since the root scrolls its content and Lexical owns
its children (an insert puts line breaks inside ONE paragraph, so there is no
line element to box). It also turns a marker whose partner was deleted back
into literal text, so a region never leaves an invisible half behind. Only the
picked items are in the draft: a line is dropped by deleting it.

**In the sent message** an `InlineText` walker (`web/internal/go-walker.tsx`,
order -1 so it sees the raw string) renders each `<go>` region in full, in the
same tint (`GoEcho`): inline or a card by the shape rule above, a card's
`- [x]` lines read as checked boxes.

Rules for agents are in the root `CLAUDE.md`.

## How the reply renders

The tag is an `ActiveData.Tag` block contribution with an `inline` renderer.
active-data extracts an occurrence in block form (`isBlockForm`), wherever it
sits on its line, as a block (`GoBlock`); everything else stays in the markdown, where
active-data's remark pass pairs `<go>` / `</go>` into one element rendered by
`GoInline` (see `active-data/web/internal/remark-inline-tags.ts`).

The caps are `select-none` and a checklist row copies as its `- [ ] …` line,
so copying a reply yields the text the agent wrote, without action glyphs.

Picks persist per occurrence through active-data's `useActiveDataBinding`
(`{ picked: boolean[] }`), so they survive a transcript reload; a stored list
of another length (the content changed) is ignored. A legacy log without a
message id keeps them in component state only. Reset stores the agent's picks
back the same way.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Renders <go>…</go> in an agent's reply — a part of the answer the user can pick as their reply — as one tinted unit, [text | ▶]: ▶ sends it back as <go>…</go> (the agent reads the part of its answer the user picked), clicking the text puts it in the draft as an editable tinted region closed by a ✕. One line is inline wherever it is written; a multi-line block is a card with a ✎ / ▶ rail, its `- [ ]` lines pickable rows, or a table whose rows lead with `[ ]` / `[x]` a pickable table (only the picked items are sent — a row as a `- [x]` line of its first cell — and Reset restores the agent's picks). The user's sent message shows the accepted <go> in full, in the same tint.
- Web:
  - Contributes:
    - `ActiveData.Tag` "go" → `GoBlock`
    - `InlineTextWalkerSlot`
    - `TextEditorSlots.Plugin` → `GoRegionPlugin`
  - Uses: 30 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/inline-text` ×5
    - `active-data` ×3
    - `primitives/css/ui-kit` ×3
    - `primitives/css/clip` ×2
    - `primitives/text-editor` ×2
    - `conversations/conversation-view.usePromptComposer`
    - `primitives/css/center.Center`
    - `primitives/css/coords.Placed`
    - `primitives/css/fill.Fill`
    - `primitives/css/grow.growClass`
    - `primitives/css/inline.Inline`
    - `primitives/css/selection-indicator.CheckboxIndicator`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/dom/copy-source-text.copiesAsText`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/loading.Loading`
    - `primitives/markdown.Markdown`
    - `ui/icons.Icon`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --outline-border`
    - `ui/tokens/color-palette --outline-fill`
    - `ui/tokens/color-palette --outline-hover`
    - `ui/tokens/color-palette --outline-hover-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/density --pad-code-x`
    - `ui/tokens/density --pad-code-y`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --radius-code`
    - `ui/tokens/shape --spacing`

<!-- AUTOGENERATED:END -->
