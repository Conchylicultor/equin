# callout

A callout is a **void container**. Its payload is `{icon, color}` —
`icon` a saved Material Symbols name, drawn as a runtime symbol — and nothing else — no `text`. Its content IS its children, which are ordinary
blocks of any type that do not know they are inside it:

```
Callout            ← the anchor: appearance only, no line of its own
├── Text  "first line"
├── Heading
└── Bulleted list
```

That is the whole design, and every reported bug was a symptom of the previous
model, in which one row played container identity, appearance AND the first line
of content at once. Enter made a second callout (making another content line
meant making another container); converting the line to a heading destroyed the
box (the line's type *was* the container's identity). Neither is expressible now.

## The container shape is not declared here

`core/callout-block.ts` calls **`defineContainerBlock`**
([`page/container`](../container/CLAUDE.md)), not `defineBlock`. That factory
forces the two facts that are only correct together — `anchor: true`,
`wrapOnConvert: true` — and constrains its schema to a
shape without `text`, so a text-bearing callout is a compile error rather than a
runtime surprise. `acceptsText` is still *derived* from the schema
(`"text" in schema.shape`), so voidness is a fact of the payload and the write
boundary's strict parse rejects a stray `text` outright.

Read that plugin's doc for what each flag buys and why they cannot be declared
piecemeal. This file therefore declares nothing but the callout's identity and
its `{icon, color}` appearance payload — and the two shells it
composes:

- **The frame** (`web/components/callout-frame.tsx`) paints the tint, over the
  anchor's row plus its whole visible subtree. A block renderer cannot do this
  itself: both surfaces render the forest as a flat list of sibling rows so a
  structural move only reorders keyed elements, which means a block's children are
  not its DOM children. `Editor.BlockFrame` is the seam for the other half — see
  `page/editor`'s `internal/block-frames.ts`. Contributing one is also what *makes*
  the callout a container: the framed-type set is derived from that slot's
  registered matches (`useFramedBlockTypes()`), so there is no second "I am a
  container" flag to drift from who actually paints a box.

  The frame declares the **tint and nothing else** — `ContainerBackdrop` owns the
  box's geometry (the box the surface measured, handed over whole; never
  `h-full`, no horizontal offset of its own), which is why a stray padding or
  left border can no longer strand the enclosed rows' hover controls.

  That box is the callout's own CONTENT box, so the tint starts on the same x as
  the first letter of the paragraph above it. It used to bleed one `BLOCK_INSET`
  further left, to the decoration origin `C` — recorded here for a while as the
  right answer, and it was not: every OTHER decorated block (a code background, a
  place card) paints the content box, so the callout was the one thing on the
  page whose edge did not line up. Measured, then fixed; see
  `page/container`'s `ContainerBackdrop`.

- **The anchor** (`web/components/callout-anchor.tsx`) is the icon, and it rides
  on the *same* `Editor.BlockFrame` registration (`BlockFrameMeta.anchor`) so a
  type cannot claim anchorhood without actually registering as a container.
  `./singularity check page-editor:anchor-has-decoration` pins the two halves
  together — a handle declaring `anchor: true` whose plugin supplies no component
  is an invisible container, not a cosmetic gap.

  It supplies a `glyph` and `sections` to `ContainerAnchor` — the GUTTER seat,
  deliberately, where the annotation cards take the corner one: a callout's icon
  is a mark its author CHOSE and part of what the card says, so it leads the
  text and is always there, while a card whose decoration is merely its type name
  charges nothing at rest and says it in the corner when asked. The shell owns
  the static-vs-interactive branch, the trigger and the popover, and the surface owns
  the geometry (a `BLOCK_INDENT`-wide column at `C`, seated on the first visible
  child's borrowed first-line centre, plus the drag listeners).

## The icon popover is APPEARANCE; the rail carries the block actions

It used to carry the whole block-actions menu, for one stated reason: an anchor
row renders no hover rail, so there was nowhere to hang a `BlockActionsMenu`.
**There is now** — the rail on the line the callout BORROWS resolves the callout
as its owner, so its `⠿` handle opens Collapse / Remove callout / Delete
generically (`page/container`'s *The glyph is appearance; the rail is structure*).
The callout contributes none of that: "Remove callout" derives from the handle's
own `label`.

What is left here is what only exists by virtue of the `{icon, color}`
payload — colour, icon, Reset, in
`web/components/callout-appearance.tsx`. It renders in **both** places, by
design: as the `sections` handed `ContainerAnchor` and as the
`BlockFrameMeta.menu` on the same `Editor.BlockFrame` registration. Both go
through `CalloutAppearanceFor`, the one binding of `data → controls →
api.update`, so the duplication is in the SURFACES, never in the wiring.

The popover's open state belongs to whoever hosts it, so the sections dismiss
through the `close()` they are given rather than holding a second copy; the
swatches deliberately do not close (picking colours in a row is a comparison, not
a commit). The trigger `preventDefault`s its mousedown (the click lands beside a
live caret), and the structural commits in `BlockActionsMenu` fire on
`onMouseDown` for the same reason.

The sections are a **control panel**: colour, icon and Reset are three
`ControlPanel.Section` bands, so the rule between them is the container's rather
than the `h-px bg-border` div this file used to place, and the panel's own inset
is the only one — the swatch cluster and the picker land on the same left edge
as the band labels by doing nothing. Reset is a band and NOT a `Footer`, because
these sections also render as the top half of the rail's block-actions panel,
where a sticky footer in the middle would pin over the structural actions below
it. `panel` says its sections are a control panel; the icon grid's section
declares `needs="picker"` (320px — what this popover already measured as
`xl`), so the rail's block-actions menu widens to it too.

## What is deliberately NOT here

There is no callout-specific keystroke handling, and that is the point. Enter in
a child is an ordinary sibling split; Tab / Shift+Tab nest and un-nest with no
callout logic; arrow navigation skips the anchor because it registers no focus
handle; converting a child's type can never reach the container. The single
callout-shaped rung in the generic ladder is `unwrap` — Backspace at the start of
an anchor's first child — and it exists because the generic `isIndented` → outdent
rung would pop that child out *and adopt the remaining siblings as its children*,
silently re-nesting content nobody asked to nest.

The `Editor.Block` contribution is kept with the primitive's shared **null
renderer** (`ContainerNoRow`). `BlockRow`'s anchored branch never dispatches that
slot for an `anchor` type, so it is unreachable — but the registration is where
the HANDLE lives, and the handle is what the insert palette, markdown, paste, the
turn-into list and the reducer's `anchorTypes` all read.

The two e2e scripts are this plugin's real spec, and they are the regression
proof for any change to the container primitive:
`e2e/callout-container-verify.ts` (zero-height row with visible children, a
visible one-line box when childless, the icon's clickable box inside the
`[C, C+BLOCK_INDENT]` column, its centre within ~2px of the first child's
first-line centre, Enter yielding a sibling inside the tint, `/h1` on a child
leaving the container untouched, Tab in/out preserving the caret, Backspace at
the first child's start unwrapping) and `e2e/callout-wrap-verify.ts` (`/callout`
keeps the origin's id and caret; the wrap is ONE undo entry).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Callout block type: a void CONTAINER whose tinted box wraps blocks of any type nested inside it, with a changeable leading icon and semantic color, for notes/tips/warnings. Callout block type: registers its `data` schema (icon + semantic color) at the server write boundary.
- Web:
  - Contributes:
    - `Editor.Block` "callout" → `ContainerNoRow`
    - `Editor.BlockFrame` "callout" → `CalloutFrame`
  - Uses:
    - `page/container.ContainerAnchor`
    - `page/container.ContainerBackdrop`
    - `page/container.ContainerNoRow`
    - `page/editor.Editor`
    - `primitives/css/control-panel.ControlPanel`
    - `primitives/css/spacing.Stack`
    - `primitives/css/ui-kit.cn`
    - `primitives/icon-picker.IconPicker`
    - `ui/icons.Icon`
  - Exports (values): `calloutBlock`
- Server:
  - Contributes: `page.block-data` "callout"
  - Uses:
    - `database.db`
    - `database/sql-projection.nullable`
    - `database/sql-projection.parsed`
    - `page/editor._blocks`
    - `page/editor.Editor`
    - `page/editor.liveBlocks`
    - `ui/icons/saved-sources.defineSavedIconSource`
- Core:
  - Uses:
    - `page/container.defineContainerBlock`
    - `ui/icons.symbol`
    - `ui/icons/saved-names.SavedSymbolNameSchema`
  - Exports (types): `CalloutColor`
  - Exports (values):
    - `CALLOUT_COLORS`
    - `calloutBlock`
    - `calloutDataSchema`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --info`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --ring`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`

<!-- AUTOGENERATED:END -->
