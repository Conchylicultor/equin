# human-notes

A human card is a **void container** for the page author's own words, addressed
to *agents* rather than to whoever is reading the page — coding conventions,
"always run X first", a domain glossary, or a correction typed straight into an
agent's own note. It owns no text and no appearance: its payload is `{}`, and its
content IS its children, which are ordinary blocks of any type that do not know
they are inside it:

```
Human              ← the anchor: its name in the corner, no line of its own
├── Heading  "Repo conventions"
├── Bulleted list  "run ./singularity build after every change"
└── Code block
```

Inserted with `/human` — or `/context` and `/user`, which are aliases onto the
same card. The instruction words (`/instructions`, `/rules`, `/guidance`,
`/conventions`) belong to the sibling [`instructions`](../instructions/CLAUDE.md)
card, whose content is delivered to agents as standing instructions.

## What the card is FOR is not what it is NAMED for

It shipped as `/context`, and the name described its usual contents: standing
instructions an agent should read. That was accurate and not load-bearing. What
actually distinguishes this card from every other block on the page is **whose
words are in it** — the author's — and that is the fact the write policy needs:
an agent may read this card, and may never write it, not even when the card sits
inside the agent's own `<agent-note>`.

So the card declares both parties, and the second one is the rename's reason:

```ts
audience: "agent",   // an agent may RECEIVE this
author: "human",     // …and it is not an agent's to rewrite
```

Before `author` existed, this card was only *accidentally* unwritable — safe
because it usually sat in the page's prose, outside any `<agent-note>`, rather
than because anything said so. Nest it inside an agent's card and the next
`write_agent_note` overwrote it. The declaration is what closes that: the write
walk stops at the nearest row declaring anything, and this row declares CLOSED.
See [`page/annotations`](../../CLAUDE.md) for the matrix, and
[`agent-access`](../agent-access/CLAUDE.md) for the walk itself.

## The stored `type` is still `context`, deliberately

The directory, the symbol (`humanNotesBlock`), the label, the corner chip and the
markdown tag all say **human**. `handle.type` does not, and that is the one place
the rename stops. Three reasons, each sufficient on its own:

- **`BlockTag.name` exists precisely so a tag may differ from a type.** The
  markdown an agent reads is `<human>` because the tag says so, at zero cost.
- **The type is what page rows store.** Renaming it is a data migration over
  every page anybody has ever put a context card on, paid for a string no reader
  ever sees.
- **The `Editor.Block` contribution id IS the type**, and reorder's persisted
  per-slot directives are keyed by `<pluginId>:<contributionId>`. The directory
  move already changes the first half — `config/page/editor/block.jsonc` was
  repointed to `page.annotations.human-notes:context` by hand, or the card would
  have quietly fallen out of the palette's Annotations group. Renaming the type
  as well would have orphaned the same key twice, with no error either time.

`agent-notes` records the same type-vs-symbol split from the other direction
(there the SYMBOL kept the old spelling while the type went singular); this is
the family's second instance of the same rule, not an exception to it.

**Renaming a plugin directory is not a free operation**, and this is the
generalizable half: a plugin's id is derived from its path, so a move silently
re-keys every reorder directive that named it. Nothing fails; the contribution
just reappears wherever an unlisted one goes. Grep `config/` for the old id
before you move a plugin folder.

## It shipped once as a text-bearing card, and that was wrong

The first version was a collapsible card whose header row was an editable title.
Two symptoms, one cause — one row playing container identity, appearance AND the
first line of content at once:

- its first line could never be a heading, because the title row was `text`-typed
  by construction;
- Enter in the title minted a second sibling card whenever
  `splitChildWhenExpanded`'s policy did not apply (caret at offset 0, or a
  collapsed card): `keystroke-intent.ts` resolves
  `tailType = asChild ? childType : (siblingType ?? node.type)`.

The callout had already solved this by owning no text at all, and that is now the
shared shape: `core/human-notes-block.ts` calls **`defineAnnotationBlock`**
(`defineContainerBlock` plus the two declarations above — see
[`page/container`](../../../container/CLAUDE.md)), which forces `anchor: true`
and `wrapOnConvert: true` and rejects a text-bearing schema at the type level.
Neither symptom is expressible any more: the container has no
line to type into, and `/human` on an existing block **wraps** it — which is
also what lets the first visible line be a heading.

**It folds, and needed no header row to do it.** A human card holds standing
instructions a reader usually wants out of the way, so this is the point of the
block. It collapses to its BORROWED line — its first child's, the same line the
anchor already borrows for its own seat — so nothing moves, and the chevron
lives on that line's row rather than on a title row the void model exists to
avoid. See *A container folds to its borrowed line* in
[`page/editor`](../../../editor/CLAUDE.md).

## The void payload is enforced, not aspirational

`humanNotesDataSchema` is `z.object({})` — `divider` is the precedent for an empty
payload. The write boundary parses through `handle.schema.strict()`, so a stray
`text` key is a 400 rather than a quietly-stored field; that is what makes the
previous model's rows unwritable rather than merely unused.
`core/human-notes-block.test.ts` pins the rejection, the forced container facts,
the declared `author`, and the type-stays-`context` split.

There is no per-instance appearance either, and the decoration reflects that: the
card's **name** in the box's top-right corner, revealed only while the pointer is
inside it, with **no popover at all** — a plain answer on both surfaces. It used
to be a fixed glyph in the margin (`MdRule`, now `MdPerson`); the icon still names
the card in the slash menu, off the handle, it just stopped charging every card on
the page for a fact the tint already carries. It contributes neither `sections`
nor `BlockFrameMeta.menu` rather than inheriting a picker it has no field to write
to, and loses nothing by it: the structural actions (Collapse / Remove human /
Delete) come from the rail on the line it borrows, generically over
`BlockHandle.anchor`.

## The frame is appearance only

`web/components/human-notes-frame.tsx` paints the soft wash over the card's own
(zero-height) anchor row plus its whole visible subtree. A block renderer cannot
do this itself: both surfaces render the forest as a flat list of sibling rows, so
a block's children are not its DOM children — `Editor.BlockFrame` is the seam for
the other half.

Contributing that frame is also what *makes* this a container: the framed-type set
is derived from the slot's own registered matches (`useFramedBlockTypes()`), so
there is no second "I am a container" flag to drift from who actually paints a
box. The anchor rides on the same registration, so `anchor: true` can never claim
a decoration nothing supplies (`./singularity check page-editor:anchor-has-decoration`).

The box's geometry belongs to `ContainerBackdrop`; this file declares only the
look. A soft tint and NOTHING else — no border, no icon. `muted` is the family's
neutral, and it stayed through the rename for the reason it was picked: this card
is the page's own voice, and every other semantic hue in the family carries a
status the voice does not have. It also has to stay legible nested inside
`agent-note`'s `bg-info/10` — which the write rule turns from an oddity into an
ordinary arrangement, a human answering an agent inside the agent's own card.
What separates it from a callout is no longer a dashed edge but that a callout is
DRAWN (an icon its author chose) while an annotation is NAMED, and only when
pointed at. See *The family is NAMED, where a callout is DRAWN* in
[`page/annotations`](../../CLAUDE.md).

## Markdown: `<human>`, and it carries the card's row id

```
<human id="block-8c1e…">
  - run ./singularity build after every change
</human>
```

A void container has no text of its own, so the mapping is the generic TAG: the
children go inside it and it comes BACK as a card. That replaced a one-way
`**[Agent context]**` marker, which could only ever dissolve into its contents on
the way back. Still no `parseLine` prefix: a tag is explicit, so it can never
convert real prose on paste.

`name: "human"` is what makes the tag differ from the stored type. Beside
`<agent-note>` in the same document it also reads as the opposition it is — an
agent looking at a page can tell at a glance which lines are its own and which
are the author's.

`identified: true` puts the card's ROW id on the tag, and this card needs it for
a sharper reason than `<agent-note>` does. An agent rewriting a card that
CONTAINS one of these must reproduce it exactly; omitting it plans a delete,
which the write policy refuses with nothing written. The pin is what makes
"echoed it back" an exact, checkable act — a void card's content key is
`type ␀ {}`, byte-identical for every human card on the page, so an aligner
inferring identity from content could not tell two of them apart. The id lands on
`SerializedBlock.ref`, never in `data`, which is still `z.object({})`. On the
CLIPBOARD there is no row id to emit, so a copied card serializes bare and
pasting it mints a fresh one — an id-less forest omits the attribute and is not
an error (`BlockTag.identified`).

## What is deliberately NOT here

No card-specific keystroke handling, and that is the point. Enter in a child is
an ordinary sibling split; Tab / Shift+Tab nest and un-nest generically; arrow
navigation skips the anchor because it registers no focus handle; converting a
child's type can never reach the container. The one container-shaped rung in the
generic ladder is `unwrap` — Backspace at the start of the first child — and it is
the editor's, not this plugin's.

Also absent: `typingPrefixes` (the `/` palette is the only entry point; every
short prefix worth claiming is taken, and one that matched real prose would
convert paragraphs nobody asked to convert) and any `Editor.Block` renderer of
its own — an anchor renders no row, so it registers the primitive's shared
`ContainerNoRow`. The registration still matters: it is where the handle lives,
and the handle is what the insert palette, markdown, paste, the turn-into list
and the reducer's `anchorTypes` all read.

One consequence of the anchor model worth knowing: `pruneEmptyAnchors` is a
forest-wide post-pass on every reducer op, so a **childless** human card
dissolves on the next structural keystroke anywhere on the page. Cards are never
born childless (the wrap mints the anchor and its first child in one patch), and
the surface renders a childless one as a real one-line box in the meantime rather
than an invisible ghost.

The card's original delivery question — feeding a page's standing instructions to
a launched agent — is answered by `agent-access`'s `read_page` rather than by a
second rendering path here (the step deferred in
[`research/2026-07-29-page-context-block.md`](../../../../../../research/2026-07-29-page-context-block.md)).
<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Human block type: a void CONTAINER whose soft-tinted box wraps blocks of any type nested inside it, holding the page author's own words addressed to agents rather than to the reader — and, being the author's, the one an agent may read but never write. Human block type: registers its (empty) `data` schema at the server write boundary, rejecting stray keys like an injected `text`.
- Web:
  - Contributes:
    - `Editor.Block` "context" → `ContainerNoRow`
    - `Editor.BlockFrame` "context" → `HumanNotesFrame`
  - Uses:
    - `page/container.ContainerBackdrop`
    - `page/container.ContainerCornerLabel`
    - `page/container.ContainerNoRow`
    - `page/editor.Editor`
  - Exports (values): `humanNotesBlock`
- Server:
  - Contributes: `page.block-data` "context"
  - Uses: `page/editor.Editor`
- Core:
  - Uses:
    - `page/annotations.defineAnnotationBlock`
    - `ui/icons.symbol`
  - Exports (values):
    - `humanNotesBlock`
    - `humanNotesDataSchema`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --info`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/shape --radius`

<!-- AUTOGENERATED:END -->
