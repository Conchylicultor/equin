# read-only-view

## Block types are matched GENERICALLY, or the boundary leaks

This renderer dispatches on handle METADATA (`marker`, `ordinalMarker`, `toggle`,
`textVariant`, `anchor`), on the contribution's `chrome`, and on the live
`Editor.BlockFrame` registry — not on block-type names. Exactly **one**
`node.type ===` comparison survives: the `PAGE_BLOCK_TYPE` sub-page chip.

The other two were real boundary violations, and both are gone. The callout's
icon + its duplicated colour map now come from the callout's own
`Editor.BlockFrame` contribution (`BlockFrameMeta.anchor`). The `quote`
left-border rail (and, for free, the prompt's raised box + glyph) now comes from
`BlockChrome` on the block's own `Editor.Block` contribution, rendered through the
SAME `TextBlockLayout` the editor uses — so `ReadOnlyBlocks` keeps the
contributions whole instead of mapping them down to handles, and its text arm
names zero block types.

The region props carry `pageId: null`, `isFocused: false` and — load-bearing —
**no `editor`**. That absence IS the read-only signal: a region degrades to a
static rendering (the prompt's glyph) or renders nothing (the prompt's footer,
which is live agent state, not document content, and whose hooks do not exist on
the public-site surface). Same contract as the anchor below.

`NodeView`'s arm ORDER is load-bearing. The generic anchored branch sits **before**
the `isTextLike && hasText` arm, because a void container's `data` carries no
`text` and would otherwise fall through to the "Unknown block" placeholder card —
exactly the trap `PAGE_BLOCK_TYPE` is already there to avoid. A new block type
that renders no text of its own must be placed above that arm too.

A text-less type that owns a static rendering says so on its own `Editor.Block`
registration (`view`), and `NodeView` renders it from there — in its own arm,
above the text-like one, naming no type. The slot binds the view to the handle's
`parse` at registration, so this surface hands it the stored `data` as it is and
never learns the type's shape. That is how the table renders here although
this plugin cannot import it (the table imports `RunsRenderer` from here).
Moving the hardcoded `MEDIA_TYPES` (divider, code-block, image) onto the same
seam is the natural follow-up.

`BlockEntry` is derived from `Editor.Block.useContributions()` rather than named
as the editor's `BlockContribution`: the read hook SEALS `component` (middleware
chain), so the written and the read shapes are not the same type.

The geometry of a container anchor falls out for free here. This surface has no
hover rail (it dispatches frames with `inset: 0`, so `C` is simply the renderer's
left edge) and it renders children recursively, already indented by one
`BLOCK_INDENT` — so a zero-height `relative` wrapper with the decoration pinned at
its left edge puts the glyph in exactly the column the editable surface puts it
in, with none of the control-collision the editor has to resolve. Children always
render expanded here, so only a genuinely childless container needs the one-line
fallback box.

The anchor contribution is dispatched with **no `editor` prop** — that absence IS
the read-only signal (`BlockAnchorProps.editor` is optional), and a contribution
is expected to degrade to a static glyph rather than render a dead control.

A container's FOOT — the strip of its own chrome at the bottom of its box —
renders here too, from the same registry, after the children wrapper. It falls
out for free for the same reason the anchor does: nesting here is a real wrapper
div, so the card's pads are already spent inside it and there is no closing-slot
arithmetic to redo. The foot's own div carries the card's child indent on the
left and the wrapper's own right and bottom pads, which leaves the wrapper's
`padding-bottom` standing as the gap between the card's last line and its foot —
the one the editable surface has to reserve explicitly.

It too is dispatched with **no `editor`**, and here that absence is load-bearing
rather than cosmetic: a foot whose content is LIVE state renders nothing on this
surface, which is the correct answer. A version-history preview of last Tuesday
must not show this morning's runs, and no snapshot can tell that it is being
lied to.

## Inline tokens are matched GENERICALLY too

`RunsRenderer` names no token family. It splits a run with `matchTokens` — the
same walk the editor's own runs→Lexical seed runs — over
`blockTextRenderableExtensions()`, the same registry the editor reads, and paints
each match with `renderToken` off the very registration that matched it.

It used to hardcode exactly two: it imported `PAGE_LINK_TOKEN_PATTERN` and
`INLINE_MATH_TOKEN_PATTERN`, defined a closed three-arm `Segment` union, and
raced the two regexes. So `[[date:…]]` — a third family, shipped later —
rendered as those literal characters on every read-only surface for as long as
it existed: page history, version diffs, the public site. Nothing failed, and
nothing could tell anyone. `renderToken` sits on the same discriminated arm of
`BlockTextExtension` as `node`, so that omission is now a tsc error at the
declaring plugin rather than a missing case here.

Three behaviours come out of sharing the walk rather than being restated here:

- a run carrying the **`code`** mark yields no tokens at all, so a token written
  as inline code stays code on read surfaces exactly as it does in the editor;
- a family whose `renderToken` answers `null` — its chip is not in this
  composition — falls back to the RAW TOKEN TEXT, which is what the Lexical
  decorator's own unclaimed arm does. Never nothing: that would silently delete
  a token the document still holds;
- a family not registered at all is not matched, so its token is plain text.
  That is the honest answer on a surface composed without it.

`PageLinkChip` moved out to `page/inline-page-link/web`, with the family that
declares the token. This plugin renders chips; it owns none.


<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Faithful, non-editable renderer for a page block forest, with optional per-block diff highlighting. Reuses the editor's block-handle metadata + rich-text runs model without mounting Lexical.
- Web:
  - Uses: 38 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `page/editor` ×18
    - `primitives/overlay/image-viewer` ×5
    - `primitives/css/spacing` ×3
    - `primitives/css/text` ×2
    - `infra/endpoints.useAssetSrc`
    - `primitives/css/inline.Inline`
    - `primitives/css/overlay.Overlay`
    - `primitives/css/pin.Pin`
    - `primitives/css/selection-indicator.CheckboxIndicator`
    - `primitives/css/surface.Surface`
    - `primitives/css/ui-kit.cn`
    - `primitives/syntax-highlight.HighlightedCode`
    - `primitives/text-editor/paste-images.attachmentUrl`
    - `ui/icons.Icon`
  - Exports (types):
    - `BlockDiffKind`
    - `ForestBlock`
    - `ReadOnlyBlocksProps`
    - `ReadOnlyNode`
    - `RunsRendererProps`
  - Exports (values):
    - `buildForest`
    - `ReadOnlyBlocks`
    - `RunsRenderer`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-medium`
  - Imported by:
    - `apps/pages/history`
    - `page/table`

<!-- AUTOGENERATED:END -->
