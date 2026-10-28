# control-panel — design

Why the rules in [CLAUDE.md](CLAUDE.md) are what they are. Read before changing or removing one.

## The five invariants

They hold by construction, not by discipline:

- #1 — the row is a grid, so the rail survives a row with no icon.
- #3 — `RowProps` is a discriminated union, so mixing languages is a type error.
- #5 — nothing that opens a panel can name a width, so there is nothing to
  override.

The one exception is #4's footer glyph.

**Why a leading footer `icon`, uniformly.** Without the rule, one thing got
three treatments: a trailing upload glyph on one picker, no glyph on two others.
The approved prototype showed a leading one.

- On the icon rail the glyph costs only the ROW LABELS 26px, not every block in
  the panel.
- In a picker whose only row is the footer, it costs nothing.
- Limit: in a panel that also has ordinary rows (quick-theme's variant rows),
  their labels indent by 26px.
- Rejected: exempting footers from the track scan. It would be a lie about the
  markup — the invariant says footers ARE rows. So the uniformity stays a
  convention, the only one in the vocabulary not held by construction.

## The panel paints no surface

The body painting nothing buys three things:

- No double elevation, so the primitive needs no `no-adhoc-surface` exemption.
- A panel inside a panel gets its own correctly-clamped surface, instead of an
  inner box re-deriving the outer one's chrome.
- Width can be a role: with no width prop to default, the widest row cannot
  decide how wide the panel is.

Why the container owns the hairline: a footer is separated because it is a band,
not because it opted in, and the rhythm cannot go ragged one panel at a time.

## The separator is a band's rule, cancelled by the panel — NEVER a sibling rule

**Failure mode of adjacency selectors.** A `cp-body > * + * { border-top }` sees
only the one `display: contents` lineage span `renderIsolated` adds per
contribution, so it matched nothing: no panel in the app drew a single hairline.
A flex container instead lays the bands out as its own items at any wrapper
depth, so the mechanism keys on layout participation.

- **Why `gap`:** it is the only spacing that exists strictly between items, so
  the first band is never handed a leading gap to take away again.
- **Why not `border-top`:** a first band carrying 1px + top padding as real
  height cannot be cancelled by ink; the compensating panel padding works out
  to −1px.
- **Why `Subhead` is not a band:** the rule would land between a heading and the
  very rows it names.

**Why `--border` and not a surface-relative separator var.**

- Measured on `--popover`: distance 46 in dark, ≈39 in light.
- `--popover` and `--card` are the same value in both modes, and `--border` is
  calibrated against `--card` — an invisible panel separator would mean
  invisible card borders.
- Contrast with `--hover-fill`, which exists because `--muted` genuinely
  collided with `--sidebar`. There is no collision here.
- A preset that ever collides fails `e2e/hairline-verify.ts` loudly.

## The panel is a rail region, and it has exactly one owner

**Why the cancellers don't use `rail-bleed`.** They stop `--cp-panel-pad` short
of the rail's origin so the row's fill reaches the panel's inner edge — that
full-width hover / selected fill is what makes a row read as a row. Two terms
written out with a reason are allowed by the [rail contract](../rail/CLAUDE.md);
reaching for half of `rail-bleed` is not.

**Why the ICON rail, not the text rail.** Rejected: the panel content edge on
the text rail (after the gutter and icon column). Failure modes:

- A search field, a swatch cluster or a card grid indents 26px past everything.
- The section label needs a hang-back class (`cp-rail-icon`) to escape.
- The panel pads 62px left against 12px right.
- Opening the icon column is not loose content's business, yet one leading glyph
  on one footer row moves every block in the panel.

On the icon rail there is nothing to hang back from, so `cp-rail-icon` has no
reason to exist.

**Trade-off, taken knowingly.** On the text rail the content box is exactly a
row's content band — aligned on both sides with row labels and trailing cells.
That answers "where does a loose control line up with the row *text*?", and buys
right-side symmetry by handing loose content an interior column of the row grid.
The icon rail takes left-edge symmetry instead (the heading is the edge) and
keeps the end rail where it was, so the right side is unchanged.

**Handle-less case on `:root` — measured failure.** Root-declared, a handle-less
panel pads 36px left against 12px right; declared on the panel, 12/12. The
derived-track rule moves `--cp-rail-icon` on `.cp-panel`, which never reaches a
value frozen at the root.

**Why `cp-band`'s rule needs no padding restore:** the rule is its own empty
box, not a wrapper around the band's content.

## The two leading tracks are derived from the panel's content

**Why a switch does not occupy the icon column.** Its indicator is drawn in the
trailing cell, so its leading cell is empty by construction. Counting it, a
panel of switches (fx-toggle, metronome-button) reserves 18px that paints
nothing and indents every label by 26px.

**Why declared, not sniffed from the node.** An unchecked radio draws nothing yet
owns the column (its mark is state, the track is not). Reading the node would
re-flow the whole panel the first time someone ticks a row.

**Why per panel.** Per row is exactly the conditional leading cell invariant #1
exists to delete: a row with an icon would indent its label past a row without
one.

**Why `cp-rule` needs two handle-less templates.** A panel-scoped selector
out-specifies the bare `&[data-span="field"]`, so the field-span case must be
restated under the panel scope too. Tailwind's utilities layer comes after base,
which is why none of this can live in `@layer base`.

## The four field members, and what each of them is not

**Why `Setting` is not a `select="value"` arm.** `select` is the
selection-language axis and invariant #3 says there are three; a dropdown is not
a fourth way to say "on", it is a control inside a cell. And `Row`'s host is
inferred from `onSelect` / `href`, so a `Row` holding a dropdown would be a
`<button>` inside a `<button>` — which a `select="value"` arm would type as
correct. `RuleRow` already had the construction a value row needs.

**Why `Setting` has no `icon`.** A config field is contributed into panels its
host does not own, so the trigger would live in another plugin's descriptor —
the same failure as the footer glyph (invariant #4), with a longer fuse.

**Why `fit` sizes the control.** Each row is its own grid, so an `auto` value
track is only as wide as that row's own control: right for `fit="inline"`,
useless for a field, where dropdowns and inputs would all come out different
widths.

**Why a `Block` label is on the text rail.** Invariant #1 is about *field*
labels, and a Block label is the same rung as a Setting or Row label; a
`Section` label names a band, a different rung. In a panel with no icon track
the two rails coincide, so the rule is gated by the `block-label-rail` fixture
(a panel with an icon column), not trusted to prose.

**Why `Group` throws under `push` instead of dropping adornments.** A drill row
is a `<button>`: an action would be a nested interactive, and a stripe would
paint on a different box. A silently swallowed reset button is a bug nobody
finds. In practice a host that pushes adorns nothing, so the throw fires only for
a call site that has mixed the two up.

## The three label rungs, and where each one starts

Invariant #1's split is band-and-run versus field, not "heading versus body".

`Subhead` reaches its rail by carrying no class at all (the *inherit* half of
the rail contract), so it is equally correct in a region that is not a panel.
`subhead-rail` gates it in a panel with an icon column, where the two rails are
genuinely apart.

## Three surfaces, picked by what the thing IS

**Why the card exists.** An app's settings gear built as a `ControlPanelPopover`
comes out a menu: a faint caption label, the 280px `described` wrap, caption
prose, no title, focus ringing the first row's trash button. Every one of those
is the popover doing its job — the missing piece is a ROLE.

Rejected: `headingStyle` / `width` knobs on the popover. They reopen exactly the
escapes this vocabulary removed, and the next author still picks wrong. So the
card owns everything that makes it a card, and a call site writes the same
`<ControlPanel.Section label description>` it writes anywhere.

**Why focus lands on the title row on pointer open:** so no row action opens
ringed.

## The host owns the presentation, and throws when absent

**Why the popover pushes.** A popover passes field subsets precisely because it
wants short labels rather than prose, and `usePanelStack().push` replacing the
whole body is right there.

**Why `useControlPanelHost()` throws.** A `Group` cannot render correctly in a
host that has not said whether to push or inline; a silent default shows up as a
dead click at depth 2.

**Why the nested rail is not the bare step.** Publish the bare step and nested
loose content lands 12px left of a nested row's leading cell (Comfortable) —
invariant #1 broken *inside* the group, which reads as fine in a screenshot.
`group-nested-rail` is falsified against exactly that mutation. Redeclaring
`--cp-row-pad-start` lets both row grids read a region-relative number rather
than naming the group.

## `ControlPanel.Row` is its own grid, not a composed `Row`

**Why not reuse `css/row`'s `Row`.** It is a `<Line>`-based flex row whose
`icon` is a leading flex child, so the label's x depends on whether that row has
an icon — and flex has no track that occupies width when empty. That dependency
*is* the misalignment this vocabulary exists to remove. Its trailing slot is
also hover-revealed and overlay-pinned, while a panel row's trailing cell is
in-flow and presentational.

Rejected: a grid mode plus a panel-only geometry axis on `Row`. On a primitive
with 50+ call sites that costs more than eight lines of duplicated element
inference.

Sharing the menu-row paint means a panel row and a dropdown item are the same
row in two geometries. Composing `row-actions` borrows its reveal coupling and
xs density instead of restating them.

### The row has two constructions, and `actions` picks one

**Why split the box.** The selectable region as a *sibling* of the action
buttons, not their ancestor, is the only arrangement where "apply this preset"
and "delete this preset" are both legal DOM on one row.

- **Why no `gap` on the subgrid:** a subgrid inherits the parent's column gap;
  restating it is how the leading cells drift off the rail.
- **Why end-relative spans:** `cp-row` is a 2-, 3- or 4-track grid depending on
  what the panel occupies; only the end-relative line is the same line in all
  three.
- **Why not `focus-ring-within`:** it would light the row and the action button
  at once — two indicators for one focus.
- **Why `disabled` scopes to the selection:** the case that occurs is a saved
  preset whose fields have all left the schema — it cannot be applied, and is
  exactly the one you want to delete.
- **Why both depths, not a descendant combinator:** a descendant combinator
  would also reach inside a row's label. The panel-level
  `:has([data-cp-icon])` scan is already a descendant scan, so nothing else
  needs to know about the second depth.
- **Why `ref` is always the box:** a ref that changed node the day a row grew an
  action would hand a dnd transform a box that leaves the trailing cell behind.

### Row rules

- **Why `push={entry}`:** one spelling for a drill, so a drill row without its
  chevron is unspellable.
- **Why `selected` excludes the mark arms:** a row is current by fill or by
  mark, never both. The `--selected` tier is set apart from `--hover-fill` by the
  theme, so "current" and "hovered" stay two looks.

## Geometry: the `--cp-*` tokens

**Why the rail is the whole padding.** A rail means *where a child that does
nothing lands*, and a bare `<Input>` lands past both terms. Publishing only the
content half would advertise a rail 4px short of the real one; the two
cancellers recover the chrome pad on purpose.

**Why so few new numbers.** `--cp-icon-col` and `--cp-prefix-col` are column
widths, which the spacing ramp does not model. Everything else binds to the
density ramp so panels tighten under Compact. Row height binds to
`--control-height-md` so a panel row lines up with every Button, Input and
ToggleChip in the app.

**Why `cp-setting` uses padding for its leading tracks.** Those cells could only
ever be empty spacers, and a spacer is padding. As tracks they would multiply the
three trailing cases by 4 (32 templates); as padding it is one extra declaration,
since `--cp-rail-icon` already carries the gutter case. The leading cell sits at
`--cp-rail-icon`, the label one icon column and one gap further.

## `ControlPanelPopover` has no `width`, `size`, `padding` or `contentClassName`

**Why `maxHeight` is not the same escape.** It passes through `OverlayPanel`'s
closed `PopoverMaxHeight` scale, invariant #5 is about width, and fitting the
viewport plus scrolling is already unconditional — so it can only make a panel
SHORTER (a long Turn-into list that would otherwise open as a viewport-tall
wall). The width failure has no height analogue.

**Why the stack is published through context.** One consumer, custom-columns'
per-field editor, is a nested contribution with no prop path back to the chrome
hosting the panel.

### The content declares its width; the surface collects it

**Why not the opener.** The opener only knows a width by convention. Failure
mode: the view-settings menu's Fold rows page renders the whole filter builder,
declares nothing, and draws its rule rows overflowing a menu-wide panel. Making
the field required only moves the guess — `"inherit"` type-checks and still
overflows.

**Why rank, not `max()` of pixels.** `described` is a wrap width, not a minimum:
the default theme draws it narrower than a menu, the Pages theme wider.

**Why `picker` is a bucket.** The avatar picker, the page icon button and the
change-cover popover arrived at 320px independently. One panel at a width is a
measurement; three unrelated ones is a role.

### The measured backstop: `panel-overflow`

**Why measure cells, not just the panel.** Row-grid tracks are `min-w-0`, so a
builder row in a menu-wide panel does not push the panel at all: its tracks
squeeze and each control spills over its neighbour. Measured, the panel-level
check alone reads 0px there.

**Why clipping cells don't count:** a cell that clips is truncating on purpose.

The declarations choose the width; the measurement verifies them.

## Enforcement

- **Why region exhibits.** Rows were the one child kind the gate drew, and
  geometry bugs in other children shipped past it. A region fixture has nowhere
  to say what its children are, so "render something other than a `Row`" is a
  mechanism rather than a request.
- **`long-label` is falsified:** it re-renders the `absolute right-2` +
  reserved-padding construct and asserts the overlap check genuinely fails on
  it.
- **Why the hairline check is pixel-based and self-falsifying.** The harness
  oracle compares widths only (`rigidIntegrity` pins a row's box, not its
  height), so it is blind to colour. `hairline-verify.ts` repaints the rule
  transparent and requires the same strips to report nothing, so a probe aimed
  at the wrong y cannot pass forever. It reads the background off the render
  (the strip's modal colour), not a token, so a wrong `--chrome-mask` is caught
  too.
- **Limit of `no-adhoc-panel-body`:** it closes the drift signals, not the whole
  class — a body built from `Stack` + `SectionLabel` + `Button` with no divider is
  invisible to it.
