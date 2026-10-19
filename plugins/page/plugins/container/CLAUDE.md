# container

The **void container** shape, in one place. A void container is a block type that
owns no text at all: its row paints a single leading decoration and its displayed
content IS its children, which are ordinary blocks of any type that do not know
they are inside it.

```
Container          ← the anchor: appearance only, no line of its own
├── Heading
├── Text
└── Bulleted list
```

Three kinds exist today — `page/callout` (a solid tint led by an icon its author
chose), the four soft-washed [`page/annotations`](../annotations/CLAUDE.md) cards
(meta, addressed to or withheld from an agent, each NAMED in its own corner), and
`page/quote` (a bare left rule, a quoted passage) — and this plugin is everything they have in common. It contributes **nothing** itself: it is a library the
container plugins build their own block type out of.

## Why a primitive, and not "copy the callout"

`/context` shipped once as a text-bearing collapsible card and had to be
withdrawn. Both of its symptoms were the same mistake — one row playing container
identity, appearance AND the first line of content at once:

- its first line could never be a heading, because the title row was `text`-typed
  by construction;
- Enter in the title minted a second sibling card whenever
  `splitChildWhenExpanded`'s policy did not apply (caret at offset 0, or a
  collapsed card).

The callout had already solved this, but its solution lived in separate
`defineBlock` flags a second container had to know to copy. So the flags are no
longer copyable: `defineContainerBlock` **forces** them, and the shape is one
import rather than one convention.

A container IS collapsible — it folds to its borrowed line, so it needs no row of
its own to hang a chevron on. See *A container folds to its borrowed line* in
[`page/editor`](../editor/CLAUDE.md). The fold's **fallback**, for the cases the
borrowed line's single chevron slot cannot serve (nested containers share one
line; a first child whose own chevron is load-bearing keeps it), is a Collapse
item in that line's rail popover — not this plugin's code at all. See *The glyph
is appearance; the rail is structure* below.

## `defineContainerBlock` — the two facts are forced, because they are one fact

`core/define-container-block.ts` wraps `defineBlock` and supplies:

- **`anchor: true`** — the type renders no line. The surface collapses its row to
  zero height while it has visible children and paints its decoration in the
  `BLOCK_INDENT` column at the container's content edge `C`; the pure reducer
  reads the same fact (`BlockOpContext.anchorTypes`) for its split/merge refusals
  and the childless-anchor prune. Because the container owns no line, converting
  its first child to a heading cannot touch it, and Enter in a child is a plain
  sibling split. Empty-Enter leaves the box only from its last line, and no
  outdent ever splits it (see `page/editor`'s *An outdent never splits a
  container*).
- **`wrapOnConvert: true`** — `/<container>` on an existing block WRAPS it: the
  origin keeps its id, type, `data` and children and becomes the anchor's first
  child, both rows minted in ONE patch (one undo entry). A void type has nowhere
  to put a retyped block's text, so a swap would silently drop it; keeping the
  origin's id is what keeps the caret still (its content `Y.Doc`, its content
  owner and its registered focus handle are all keyed by block id); and
  it is what lets the container's first visible line be a heading, a to-do, an
  image or a code block.

They are forced together because each is load-bearing for the others — declaring
them piecemeal is exactly what produced the withdrawn `/context`.

### A text-bearing container is a compile error

`acceptsText` is *derived* from the schema (`"text" in schema.shape`), so
voidness is a fact of the payload rather than a flag that could disagree with it.
The factory restates that fact in the type system: its options are intersected
with `RejectTextBearing<S>`, which is `unknown` for a void schema and an
unsatisfiable object for one whose shape declares `text`. So `textBlockSchema({})`
— and a hand-rolled `z.object({ text })`, which carries no `TextBearingSchema`
brand and would slip past a brand-only check — both fail at the call site with
"Property `__void_container_schema_must_not_declare_text` is missing". Keying on
the *shape* rather than the brand is deliberate: the shape is what the runtime
derivation reads, so the two answers cannot drift.

It is a conditional intersection member rather than a constraint on `S` because
constraining `S` to `AnyZodObject & { shape: { text?: never } }` rejects
**every** schema: zod derives `keyof()._cache` from the shape, so narrowing the
shape to `{ text?: never }` makes `Set<"color" | …>` un-assignable to
`Set<never>`. (Measured, not assumed — that constraint was the first attempt.)

A runtime throw at module eval backs it up for a caller arriving through `any`
(a JS caller, a dynamically built schema): loud at boot beats a silently
text-bearing container. The type-level guard also fails CLOSED on `any` —
`keyof any` includes `"text"`.

The return type carries both container facts past the boundary:
`BlockHandle<z.infer<S>> & { text?: undefined; anchor: true }`, not the bare
handle. Downstream needs each proof, and neither is decorative:

- `text?: undefined` — `Editor.Block`'s registration union admits a block naming
  its own `component` only on the text-less arm, so without it every container,
  void by construction, fails to register.
- `anchor: true` — that same union gives a CONTAINER its own arm, the one where
  `caret` is unspellable because an anchor renders no line for a caret to land
  on. The handle's own field is `anchor?: true`, i.e. `true | undefined`, which
  cannot tell a container from anything at all; `defineBlock` captures the
  literal in a type parameter so this factory — the only sanctioned way to make a
  container — can state it. "You went through this factory" stops being a
  convention a reader has to trust and becomes something a type can check.

Don't weaken either back to a bare `BlockHandle<…>`.

The declaration surface is also much smaller than `defineBlock`'s, and that is
the other half of "inconsistent is unrepresentable": everything an anchor cannot
coherently declare is simply absent — `placeholder`, `marker`, `textVariant`,
`splitInto` / `splitChildWhenExpanded` / `dataOnSplit`,
`resetToOnBackspaceAtStart` / `breakOutOnEmptyEnter`, `toggle`,
and `gutterFirstLineCenter` (the surface seats the decoration on the first
child's borrowed first line).

`typingPrefixes` **is** accepted (and `markdownPrefixes` is not): a container's
markdown syntax is its `<tag>`, so its prefix can only ever be a typing trigger.
`MarkdownShortcutPlugin` reads it and calls `convertTo`, which for a
`wrapOnConvert` type wraps — the line being typed becomes the container's first
child, prefix stripped. `page/annotations/todo`'s `TODO ` and `page/quote`'s `| `
are the two users today.

## Three web shells, one per structural half of a container

- **`ContainerNoRow`** — the `Editor.Block` renderer, which paints nothing.
  `BlockRow`'s anchored branch never dispatches that slot for an `anchor` type,
  so it is unreachable; the registration is NOT vestigial, because it is where
  the **handle** lives, and the handle is what the insert palette, the markdown
  pipeline, paste, the turn-into list and `useAnchorTypes()` all read. Shared
  rather than stubbed per container, for the same reason `BlockTextRenderer` is
  shared verbatim by every text type: two containers then resolve to the same
  renderer and reconcile in place.

- **`ContainerBackdrop`** — the frame's positioned box. The primitive owns the
  GEOMETRY and the consumer passes appearance classes only, which is what makes
  the documented frame rules (`BlockFrameProps`) true by construction: `absolute`
  insets filling the box the SURFACE measured — handed over whole as the frame's
  own props, never as a coordinate the consumer might add to — never `h-full` (an
  explicit height defeats the editor's grid stretch), and no horizontal offset of
  its own (the rows inside seat their hover controls against an edge the surface
  computed, so shifting the flow would strand them). The single
  `layout/no-adhoc-layout` escape for the whole family lives here.

  **That box is the container's own CONTENT box**, starting at `C + BLOCK_INSET`
  — the same box a code block's background and a place block's card already
  paint. It used to bleed to `C`, one `BLOCK_INSET` further left, which is what
  "the card looks shifted" was: its edge stood 12px left of every paragraph on
  the page and of every other decorated box.

  Its other three insets are the container's NESTING share of the card padding —
  one `FRAME_PAD` per frame enclosing this one, its OWN EXCLUDED — so a nested
  card closes one pad inside its parent, and starts one pad below it rather than
  on the same y (every anchor row is zero-height, so without the vertical share
  every box in a nest would share one top edge). The padding itself is reserved
  by the ROWS, which is the half a backdrop cannot do for itself: growing upward
  would overlap the block above rather than displace it. A container declares
  whether it wants any (`BlockFrameMeta.pad`) — see the editor's *A card's
  padding is declared, not left over*.

  The appearance channel is deliberately named `className`: the
  `no-adhoc-layout` / `no-adhoc-spacing` / `no-adhoc-radius` /
  `no-adhoc-surface` rules all scan a `className` attribute, so "appearance
  only" is enforced at the consumer's own call site rather than trusted.

- **`ContainerAnchor` / `ContainerCornerLabel`** — the decoration shells, one per
  SEAT, and **appearance only**. Both own the static-vs-interactive branch on
  `editor` presence, and both open the same popover — the trigger
  (`preventDefault`ed mousedown, because the click lands beside a live caret) and
  its open state live once in `internal/appearance-popover.tsx`, so the two seats
  cannot drift into different contracts. The consumer supplies the mark (a
  `glyph`, or a `name`) and optionally `sections` — its own appearance controls,
  handed `{ editor, close }` — with `triggerLabel` and the width typed as
  travelling WITH `sections`, so "a decoration with no appearance but a trigger
  label" is unrepresentable.

  **A container has exactly one decoration, and the field it is spelled in says
  what that decoration IS.** `anchor` is the GUTTER glyph: a mark in the box's own
  indent column, seated on the first visible child's borrowed line, always there,
  leading the text — what a callout's icon is, since its author chose it and it is
  part of what the card says. `cornerAnchor` is the card's NAME, pinned to the
  box's top-right corner and hidden until the pointer is inside the box — what an
  annotation's type is, since it answers a question the reader asks only
  occasionally and a permanent glyph charged every card for. `BlockFrameDecoration`
  is a union of the two, so "both" and "a seat with no component" are unspellable,
  and `page-editor:anchor-has-decoration` accepts either arm: what it pins is that
  a container asked for ONE, a container with none being invisible whichever seat
  it declined.

  The corner seat's reveal cannot be CSS. A frame is a grid SIBLING of the rows it
  spans, so a card has no ancestor for `group-hover` to travel up, and the frame's
  own wrapper is `pointer-events-none` under every row it covers — it can never be
  `:hover`ed itself. So the editor TRACKS it (`page/editor`'s
  `internal/frame-hover.ts`: a scoped store the rows write on pointer-enter, whose
  only subscribers are the decorations, so a pointer crossing a page re-renders no
  row), while `read-only-view` — whose nesting IS real wrapper elements — reveals
  with a plain `group/frame`. One component reads both.

  The width is one of TWO mutually exclusive props, and which one a consumer
  passes says what its sections ARE. `panel: true` means they are
  built from the control-panel vocabulary (`ControlPanel.Section` / `.Row` / …),
  which the shell then opens with a `ControlPanelPopover`: those members need a
  `cp-panel` ancestor to inherit their inset from and hang their hairlines off,
  and the body already owns its padding, so a `PopoverContent padding="sm"`
  around it would be a second inset. `width: PopoverWidth` is the other case —
  arbitrary content in an ordinary padded popover (the TODO card's launch form,
  the agent-notes authorship list). Neither is a default for the other: a panel
  has no measurement to pick, and a launch form has no band to separate.

  With no `sections` there is nothing to open, so the shell renders a plain
  non-interactive glyph on **both** surfaces (the context card's state). With
  sections, the branch on `editor` is still load-bearing beyond styling:
  `sections` is handed a definitely-present `BlockEditorAPI` and writes through
  it, so a read-only surface (blog renderer, version-history preview) has nothing
  honest to render but the mark.

  The surface owns the anchor's geometry — a `BLOCK_INDENT`-wide column at `C`,
  seated on the first visible child's borrowed first-line centre, and the drag
  listeners — so the shell must not position or size itself, nor establish flow
  height.

### A third thing a container may declare: a FOOT

Beside its one decoration and its rail-menu sections, a container's frame
registration may carry a **foot** (`BlockFrameMeta.foot`): a strip of the
container's own chrome at the bottom of the box, below the last visible child and
inside the card's padding. The TODO card's chips for the runs it has launched are
the one today.

It is not a third decoration seat, and the difference is what makes it a separate
field. A decoration answers *what is this box* — it floats over the content and
reserves no space, which is why a container has exactly one and why
`page-editor:anchor-has-decoration` can pin that. A foot is chrome the box makes
room for: its height is its own, the rows around it move for it, and the card's
bottom pad is pushed BELOW it. A card with a foot still owes its one decoration,
and a card with a name may have a foot as well.

The surface owns all four of its sides, exactly as it owns the anchor's column: a
foot aligns with the card's CHILDREN (so the chips line up under the text above
them, not with the box's edge), clears the box's right and bottom edges, and gets
one pad of gap above it. A contribution positions nothing, pads nothing, and is
as tall as its content. `editor` and `blockId` are optional and degrade the way
the anchor's do — a foot whose content is LIVE state renders nothing on a
read-only surface, rather than dressing today's state up as the snapshot's.

The geometry is `page/editor`'s `internal/frame-foot.ts`; the rule it exists for
(a frame closes on a SLOT, and a foot is one) is stated in the editor's *A card's
padding is declared, not left over*.

## The glyph is appearance; the rail is structure

Collapse / **Remove `<name>`** / Delete used to live in the glyph's popover, for
one stated reason: an anchor row renders no hover rail, so there was nowhere to
hang a block-actions menu. **There is now.** The rail on the line the container
BORROWS resolves the container as its owner (`RailSeat`, `page/editor`'s
`internal/rail-seat.ts`), so its `⠿` handle opens a menu whose container arm
carries exactly those actions — and this plugin contributes none of them:

- the arm is selected by the core fact `BlockHandle.anchor`, so a container with
  no appearance (context) still gets it;
- `Remove <name>` derives its wording from the handle's own `label`, which is why
  `ContainerAnchorProps.name` is gone rather than threaded through;
- **Remove and Delete stay two rows** — different intents. Remove dissolves the
  box and promotes the children into its slot (the `unwrap` op, the escape hatch
  that keeps the content, and what Backspace at the start of the first child
  resolves to); Delete takes the subtree with it.

Appearance is reachable from **both** the glyph and the rail — the consumer
registers the same component as `sections` and as `BlockFrameMeta.menu`. That is
the user's spec, not an oversight: the rail is where one looks for a block's
actions, the glyph is where one looks for the glyph.

## Selecting a container: cover its lines

Same shape as the rail: an anchor renders no line, so there is nothing for a
pointer to click. A drag, a Shift+click and a click-and-extend all reach the
lines INSIDE the box and never the box itself, and the editor's `rowAtPointer`
skips the zero-height row by an explicit height guard. So the selection rule
states the only thing a pointer can mean:

> A selection covering every line a container owns IS a selection of the
> container.

`page/editor`'s `withContainersSelected` closes over it and `blockSelectionRoots`
is the one resolver every bulk gesture goes through, so copy, cut, duplicate and
drag all carry the box. Coverage is measured against the visible lines, so a
COLLAPSED container is selected by its one borrowed line. See *Selecting every
line a container owns IS selecting the container* in
[`page/editor`](../editor/CLAUDE.md) — a container plugin writes nothing for it.

## What stays with each container

Everything with a per-instance payload behind it: the callout's colour swatches,
icon picker and Reset (driven by its `{icon, color}` data), and the
context card's fixed glyph and dashed look. A container with no appearance
contributes no `sections` and no `menu` — it does not inherit a picker it has no
field to write to, and it loses nothing structural by it.

The `Editor.Block` / `Editor.BlockFrame` **registrations** also stay with each
container, deliberately. Containerhood is derived from who actually paints a box
(`useFramedBlockTypes()`), and the anchor rides on that same registration
(`page-editor:anchor-has-decoration` pins the pair) — a primitive that registered
on a consumer's behalf would put those facts one indirection away from the plugin
they describe.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Void-container primitive for the page editor: the shared null row renderer, the frame backdrop that owns a container decoration's geometry, and the two decoration seats a container may ask for — a gutter glyph that leads its first line, or the card's own name in the box's top-right corner, revealed only while the pointer is inside it (both share the static/interactive branch and the appearance popover; the structural actions live on the rail of the line the container borrows). Contributes nothing itself — each container plugin registers its own block type through it.
- Web:
  - Uses:
    - `page/editor.BlockEditorAPI`
    - `page/editor.BlockFrameProps`
    - `page/editor.frameBoxLeft`
    - `page/editor.useFrameHovered`
    - `primitives/css/center.Center`
    - `primitives/css/control-panel.ControlPanelPopover`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.Popover`
    - `primitives/css/ui-kit.PopoverContent`
    - `primitives/css/ui-kit.PopoverTrigger`
    - `primitives/css/ui-kit.PopoverWidth`
  - Exports (types):
    - `ContainerAnchorProps`
    - `ContainerCornerLabelProps`
  - Exports (values):
    - `ContainerAnchor`
    - `ContainerBackdrop`
    - `ContainerCornerLabel`
    - `ContainerNoRow`
- Core:
  - Uses:
    - `page/editor.BlockHandle`
    - `page/editor.BlockMarkdown`
    - `page/editor.defineBlock`
  - Exports (types):
    - `ContainerBlockOptions`
    - `RejectTextBearing`
  - Exports (values): `defineContainerBlock`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --accent`
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --info`
    - `ui/tokens/color-palette --ring`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-2xs`
    - `ui/tokens/type-scale --font-weight-medium`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-2xs`
  - Imported by:
    - `page/annotations`
    - `page/annotations/agent-notes`
    - `page/annotations/human-notes`
    - `page/annotations/instructions`
    - `page/annotations/private-notes`
    - `page/annotations/todo`
    - `page/callout`
    - `page/quote`
    - `page/sub-page`

<!-- AUTOGENERATED:END -->
