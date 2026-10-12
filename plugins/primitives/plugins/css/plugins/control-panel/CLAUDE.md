# control-panel

The vocabulary for a **data-control panel** — the body of a Filter popover, a
Sort popover, a view-settings menu, a settings pane, a per-field editor. One
compound namespace (`ControlPanel` plus `.Section` / `.Subhead` / `.Row` /
`.Setting` / `.Block` / `.Group` / `.RuleList` / `.RuleRow` / `.Field` /
`.Footer` / `.Empty` / `.Stack`) and two surfaces (`ControlPanelPopover`,
`ControlPanelPane`).

Read the members as a set: **four ways to be one field** — `Row` (the row *is*
the control), `Setting` (the row *holds* the control), `Block` (the control is
wider than a row), `Group` (the field is other fields) — plus the builder pair,
plus the boxes and bands, plus `Subhead`, which names a *run* of rows rather
than any one field.

## The five invariants

1. **One rail.** Every label in every panel starts at the same x.
2. **One row height**, in every panel, always — with ONE declared exception: a
   row passing `description` (a visible, wrapping second line under its label)
   is as tall as its two lines. It is opt-in per row and exclusive with `hint`
   (the tooltip, which costs no height), for a choice whose meaning must be read
   before it is picked — the page-kind menu. Everything else keeps `hint`.
3. **One selection language per meaning** — check, radio, switch. There is no
   fourth, and the three cannot be mixed on one row.
4. **Footers are rows**, never ghost buttons pinned to opposite corners — and
   **a footer action takes a leading `icon`, on every panel.** Uniformly: the
   alternative produced three treatments of one thing (a trailing upload glyph
   on one picker, no glyph at all on two others), and the approved prototype
   showed a leading one. A footer row is still a row, so the glyph does open the
   panel's icon column — but on the icon rail that costs only the ROW LABELS
   26px, not every block in the panel, and in a picker whose only row IS the
   footer it costs nothing at all. The one real price: in a panel that also has
   ordinary rows (quick-theme's six variant rows) a leading footer glyph still
   indents their labels by 26px. Exempting footers from the track scan would be
   a lie about the markup (this invariant says they ARE rows), so the uniformity
   is a convention — the only one in the vocabulary not held by construction.
5. **Width is a role, not a measurement.** A panel never resizes as its content
   changes.

They hold by construction, not by discipline: the row is a grid so #1 survives a
row with no icon, `RowProps` is a discriminated union so #3 is a type error, and
`ControlPanelPopover` has no width prop so #5 has nothing to override. The one
exception is the sentence added to #4, and it is marked as such.

## The panel paints no surface

`ControlPanel` draws no background, border, shadow, radius, scroll, height clamp
or **width**. The surface is always an `OverlayPanel` contributed by whatever
contains the body (a `ControlPanelPopover`, a `DialogContent`, a pushed
panel-stack entry). Three things follow, and together they are the reason:

- No double elevation — so the primitive needs no `no-adhoc-surface` exemption.
- A panel inside a panel is a popover opened from inside a popover, each with its
  own correctly-clamped surface, rather than an inner box re-deriving the outer
  one's chrome.
- Width can be a role: there is no width prop here to default, so the widest row
  cannot decide how wide the panel is.

What the body **does** own is geometry: the content inset, the rails, and
**the hairline between its bands**. That inversion is load-bearing — the
container separates, so an author never places a divider. A conditionally null
section leaves no orphan rule, a footer is separated because it is a band rather
than because it opted in, and the rhythm cannot go ragged one panel at a time.

## The separator is a band's rule, cancelled by the panel — NEVER a sibling rule

`display: contents` is transparent to **layout** and opaque to **selectors**, and
`renderIsolated` wraps every contributed panel in exactly such a lineage span (one
per contribution, nested). So a rule keyed on child adjacency — `> * + *`,
`:first-child`, `~` — sees one span and matches nothing. Do not reach for one
here; a `cp-body > * + * { border-top }` is where this vocabulary started and it
meant no panel in the app drew a single hairline. Key on layout participation
instead: a flex container lays the bands out as its own real items at any wrapper
depth.

- **`cp-body`** — flex column + `gap`. `gap` is the only spacing that exists
  strictly *between* items, so the first band is never handed a leading gap to
  take away again.
- **`cp-band`** (`Section` + `Footer` only) — draws the rule as a `::before` hung
  `--cp-panel-pad` **above** the band, so the band's box does not grow by it.
- **`cp-body::after`** — cancels the *first* band's rule (nothing above it to
  separate from). No selector can name that band, so the panel paints
  `--chrome-mask` over the one rule landing on its padding-box top edge.

Four things there are one edit from being wrong:

- **The rule may not be a `border-top`.** A first band carrying 1px + top padding
  as real height cannot be cancelled by ink, and the compensating panel padding
  works out to −1px.
- **`cp-panel` and `cp-body` stay on ONE element** — the mask's `top: 0` is right
  only because the same box insets by the same `--cp-panel-pad` the band hangs by.
  Asserted in the unit test.
- **`::after`, not `::before`** — rule and mask are both positioned at `z-index:
  auto`, so they paint in tree order; only `::after` follows the bands.
- **`ControlPanel.Stack` is `display: contents`** (and so has no `className`), so
  there is exactly one band container and one mask.

`RuleList`, `Empty` and `Subhead` are deliberately **not** bands: all three are
used *inside* a section, so marking any of them draws a rule through the middle
of one — and for a `Subhead`, that rule would land between a heading and the very
rows it names.

**`--border` is the right colour — do not add a surface-relative separator var.**
Measured on `--popover`: distance 46 in dark, ≈39 in light. `--popover` and
`--card` are the same value in both modes and `--border` is the token calibrated
against `--card`, so an invisible panel separator would mean invisible card
borders. `--hover-fill` exists because `--muted` genuinely collided with
`--sidebar`; there is no collision here, and `e2e/hairline-verify.ts` measures the
rendered contrast, so a preset that ever collides fails loudly.

## The panel is a rail region, and it has exactly one owner

This is where the repo-wide **rail contract** was worked out, and the panel is
now one instance of it rather than its own rule. Read
[`primitives/css/rail`](../rail/CLAUDE.md) for the model. In panel terms: **one
box opens the region — `cp-panel`, as its own padding. Every other participant
either inherits the rail or cancels it, never both.**

- **Inherits** — a raw `<Input>`, a contributed `FieldRenderer`, a section
  label, any JSX a caller drops into a `Section`. It lands on the rail by doing
  *nothing*: no wrapper, no rail class, no opt-in. That is the whole point —
  content that knows nothing about the vocabulary is still aligned with it.
- **Cancels** — `cp-row` and `cp-rule`, and only they, and deliberately not
  `rail-bleed`: they stop `--cp-panel-pad` *short* of the rail's origin (the
  chrome gap a row's fill keeps from the panel edge) so the row's box reaches
  the panel's inner edge — that full-width hover / selected fill is what makes a
  row read as a *row* — then re-apply their own `--cp-row-pad-x`, not the rail,
  landing the leading cell back on exactly the rail the panel published. Two
  terms written out with a reason, which the contract allows; what it forbids is
  reaching for half of `rail-bleed`.
- **`cp-panel` publishes an *asymmetric* pair** (`--rail-start` ≠ `--rail-end`,
  below) directly rather than taking a step off the `rail-<step>` ramp — the
  documented custom-value case. It pays its own rail, so `--rail-owed-*` is
  `0px` and a `rail-follow` band dropped in a panel insets itself no further.

**The rail is the ICON rail**, and that is v2's correction. It used to be the
*text* rail — an interior column of the row grid, after the gutter and the icon
column — which meant a search field, a swatch cluster or a card grid was indented
26px past everything, the section label alone escaped by hanging back through a
`cp-rail-icon` class, and the panel padded **62px left against 12px right**.
Worse, what opened the icon column was not the loose content's business: one
leading glyph on one footer row moved every block in the panel. Now the panel's
content box starts where every row's icon, indicator and drag handle begins, so a
heading, a search field and a swatch grid share ONE left edge with the rows'
leading column, and only a row's LABEL indents past the icon column that is
actually there. `cp-rail-icon` was deleted rather than defaulted: it hung a label
back by `rail-icon − rail-text`, and with the panel's content edge now ON the
icon rail there is nothing left to hang back from — so this change removes a
member rather than adding one.

**What that trades away, knowingly.** On the text rail the panel's content box
was exactly a row's **content band** — aligned on BOTH sides, starting where
every row label starts and ending where a row's trailing cell ends. That was a
real property and it was not wrong; it answered a different question, namely
"where does a loose control line up with the row *text* around it?". It bought
that right-side symmetry by handing loose content an interior column of the row
grid. We take the left-edge symmetry instead — the heading is the edge — and
keep the end rail exactly where it was, so the right side is unchanged.

**The handle-less case is declared on `cp-panel`, never at `:root`.** A custom
property is substituted where it is *declared*, so a rail published at the root
freezes on the root's `--cp-rail-icon` — and the derived-track rule below, which
moves `--cp-rail-icon` on `.cp-panel`, never reaches it. Measured: root-declared,
a handle-less panel pads 36px left against 12px right; declared on the panel,
12/12. Both declarations must land on the same element.

Two cancellations have to stay exact, and both are one edit away from being
wrong:

- `cp-band`'s rule bleeds by the panel's **whole** inset (chrome pad plus content
  inset). Drop a term and every divider in the app either insets or overhangs.
  There is no padding to restore — the rule is its own empty box, not a wrapper
  around the band's content.
- A row's negative margins are paid back in its `width`
  (`calc(100% + start + end)`), not left to `width: auto` — a `<button>` host
  sizes to its content, so `auto` would shrink the row instead of filling it.

## The two leading tracks are derived from the panel's content

A track is reserved only when something in the **panel** occupies it: the gutter
by a drag handle, the icon column by an icon, a checkbox or a radio mark. **Not
by a switch** — its indicator is drawn in the *trailing* cell, so its leading
cell is empty by construction, and a panel of switches (fx-toggle,
metronome-button) reserved 18px that painted nothing and indented every label in
it by 26px. Each row marks its own occupants — `data-cp-handle` on the gutter
cell, `data-cp-icon` on the leading cell when that cell is genuinely occupied —
and `cp-panel` turns that into one template for every row in it via `:has()`.

The marker is **not** derived from whether the leading cell rendered a node: an
unchecked radio draws nothing yet still owns the column (its mark is *state*, the
track is not), so reading the node would re-flow the whole panel the first time
someone ticked a row.

Which is also why `icon` is excluded from *two* of the three selections rather
than all three. Check and radio own the leading cell; a switch does not, so
`icon` + `select="switch"` is a legal row — and has to be, or a surface that
wants a glyph beside a toggle puts it in the LABEL cell and knocks that row's
text off the rail. `ControlPanelStack`'s `display: contents` does not block the
scan; the stack renders inside the same `.cp-panel`.

Per **panel**, never per row. Deriving it per row is exactly the conditional
leading cell invariant #1 exists to delete: a row with an icon would indent its
label past a row without one.

Three things about the mechanism are one edit from being wrong:

- **Each case is its own `grid-template-columns`, never a zeroed width.**
  Dropping a track must drop the column gap that follows it too; a `0px` track
  keeps its gap and lands the rail 8px right of the panel's own inset.
- **The cell that lost its track is `display: none`d.** A row always renders four
  cells; an unhidden empty one auto-places into the track that took its place and
  shoves the label a column over.
- **The rules are nested inside the `@utility` blocks.** Tailwind's utilities
  layer comes after base, so a `@layer base` rule loses to `cp-row`'s own
  template however specific it is. `cp-rule` needs *two* handle-less templates
  (three-cell and `[data-span="field"]`), because a panel-scoped selector
  out-specifies the bare `&[data-span="field"]`.

## The four field members, and what each of them is not

`Setting` is a **sibling of `RuleRow`**, not a fourth `select` arm and not a
promoted `Field`. `select` is the *selection-language* axis and invariant #3 says
there are three; a dropdown is not a fourth way to say "on", it is a control
inside a cell. And `Row`'s host is inferred from `onSelect`/`href`, so a `Row`
holding a dropdown would be a `<button>` inside a `<button>` — a `select="value"`
arm would type that as correct. `RuleRow` already established the construction a
value row needs: a non-interactive `<div>` box whose *cells* are interactive,
with `row-actions` composed at `pin={null}` in a reserved track. The two row
families then differ on exactly one honest axis — who is the click target —
enforced by disjoint prop sets.

**`Setting` has no `icon`, deliberately.** The leading-track `:has()` scan is per
*panel*, so one field carrying a type icon would indent **every label in that
panel**. A config field is contributed into panels its host does not own, so the
trigger would live in another plugin's descriptor: the quick-theme footer-glyph
failure documented under invariant #4, with a longer fuse. Excluded at the type
level, the same way `icon` is already excluded from the check/radio arm.

**`fit` is required, and it sizes the CONTROL, not the track.** Each row is its
own grid, so an `auto` value track is as wide as that row's own control — right
for `fit="inline"` (a swatch, an avatar, a stepper sizes to itself) and useless
for a field. So `fit="field"` gives the control `--cp-value-col`, and every
dropdown and input in the panel comes out the same box. Whether the value track
*exists* is derived per panel from `data-cp-value`, exactly as `data-cp-icon` and
`data-cp-handle` already work — declared from the prop, never sniffed from the
rendered node.

**A `Block` label is drawn in a row's label cell — on the TEXT rail, not the
panel's content edge.** Invariant #1 says every *label* starts at one x, and a
Block label is a field label, the same rung as a Setting label and a Row label. A
`Section` label names a band, a different rung, and keeps the panel's content
edge. In a panel with no icon track the two coincide, which is exactly why this
is gated by the `block-label-rail` fixture rather than by this paragraph. `Block`
is also **not** a `Section`: it carries no `cp-band`, so a run of blocks is one
visual group with no hairline between them — same reason `RuleList` and `Empty`
are not bands.

`Group` has **no `mode`**: how it presents is the host's answer, read from
`useControlPanelHost()`. Its `actions` / `mark` / `note` are honoured **only
under `inline`**, where the header is the same plain `<div>` a `Setting` is built
from. Under `push` the group is a drill row — a `<button>` — where an action
would be a nested interactive and a stripe would paint on a different box, so the
group **throws** rather than dropping them: a silently swallowed reset button is
a bug nobody finds, and the same policy `useControlPanelHost()` itself takes. A
host that pushes is a host that adorns nothing, so in practice this fires only
for a call site that has mixed the two up.

## The three label rungs, and where each one starts

A label either names the panel's **band** (`Section`'s label), a **run of rows
inside one band** (`Subhead`) — both the shared menu section label (ui-kit
`MENU_LABEL_PAINT`: faint caption, semibold, sentence case, the same a dropdown
section wears) on the panel's content edge — or **one control** (a `Row` / `Setting` /
`Block` label — drawn in a row's label cell, on the text rail). Invariant #1's
split is band-and-run versus field, not "heading versus body".

`Subhead` is the middle rung, and it exists because the outer two are both wrong
for it: a `Section` would rule a hairline between the heading and its own rows,
and a field label would indent it an icon column past the band label above it. It
reaches its rail by carrying no class at all — the *inherit* half of the rail
contract — so it is equally correct in a region that is not a panel. Gated by
`subhead-rail` (a panel with an icon column, where the two rails are genuinely
apart).

## The host owns the presentation, and throws when absent

```ts
interface ControlPanelHost {
  nesting: "push" | "inline";
  inlineDepth: number;
  descriptions: "band" | "hint";
}
```

`ControlPanelPopover` publishes `{ push, 0, hint }` — a popover passes field
subsets precisely because it wants short labels rather than prose, and
`usePanelStack().push` replacing the whole body is right there. `ControlPanelPane`
publishes `{ inline, 1, band }` **and still wraps its children in a
`ControlPanel.Stack`**, so depth ≥ 2 falls back to a push rather than collapsing
into nothing.

`useControlPanelHost()` throws when there is no host, the same policy as
`usePanelStack()` and for the same reason: a `Group` cannot render correctly in a
host that has not said whether to push or to inline, and a silent default shows
up as a dead click at depth 2.

**An inline group is a nested rail region** (`cp-group`), never a margin and
never a `border-l` + `pl-lg`. Nesting is shadowing: the group re-declares the
rail one step deeper and pays it as its own padding, so a nested row's bleed
reaches the group's edge and everything inside behaves as it does at panel level,
one step in. The published rail is *not* the bare step — it is
`panel-pad + rail-icon + step`, because a nested `cp-row` bleeds back by the
chrome pad and then re-applies **its own** leading padding. That padding is
`--cp-row-pad-start`, which the group redeclares: the two row grids read a
region-relative number rather than naming the group. Publish the bare step
instead and nested loose content lands 12px left of a nested row's leading cell
(Comfortable) — invariant #1 broken *inside* the group, which reads as fine in a
screenshot. Gated by `group-nested-rail`, which was falsified against exactly
that mutation.

## `ControlPanel.Row` is its own grid, not a composed `Row`

`css/row`'s `Row` is a `<Line>`-based **flex** row whose `icon` is a leading flex
child — so the label's x depends on whether that row happens to have an icon, and
flex has no track that occupies width when empty. That dependency *is* the
misalignment this vocabulary exists to remove. `Row`'s trailing slot is also
hover-revealed and overlay-pinned; a panel row's trailing cell is in-flow and
presentational by contract.

Adding a grid mode plus a panel-only geometry axis to a primitive with 50+ call
sites costs more than eight lines of duplicated element inference, so the two
stay separate and share **tokens** (`--pad-row-x`, `--control-height-md`, the
hover fill) rather than code.

Nor is the row's **look**: it wears the shared menu-row paint from ui-kit
(`MENU_ROW_PAINT` + `MENU_ROW_CHECKED`, and `hover:menu-row-lit` for its
highlight; `tone="danger"` stamps `data-variant="destructive"`, the dropdown's
own tone attribute), so a panel row and a dropdown item are the same row in two
geometries. Its trailing cell is `MENU_VALUE` and `Subhead` is
`MENU_LABEL_PAINT`. See ui-kit's "Menu rows share one definition"; only the
`cp-row` subgrid and the indicator placement are this vocabulary's own.

What is *not* duplicated is the hover-reveal machinery: every trailing cluster in
this vocabulary — `RuleRow`'s, `Setting`'s and `Row`'s — composes `row-actions`
at `pin={null}`, in-flow inside a track that already reserves the space,
borrowing that primitive's reveal coupling and xs density instead of restating
them.

### The row has two constructions, and `actions` picks one

**Without `actions`** the inferred element IS the row box: one node carrying
`cp-row`, the four cells as its direct children. The trailing cell is then
presentational by contract — the row is the click target, so a control there
would be a nested interactive — and `select="switch"` owns that cell outright
rather than sharing it. This is what ~50 call sites render, and it is unchanged
byte for byte.

**With `actions`** the row splits, exactly as `css/row`'s `Row` splits when it is
handed both a click target and an action cluster: the box becomes a
non-interactive `<div>`, and the element the props inferred moves inside it as
the *selectable region*, a sibling of the action buttons rather than their
ancestor. That sibling relationship is the whole point — it is the only
arrangement in which "apply this preset" and "delete this preset" are both legal
DOM on one row.

Three things make the split invisible from the outside:

- **The selectable region is a CSS `subgrid`** (`grid-cols-subgrid col-[1/-2]`),
  so the panel's own tracks pass straight through it and the gutter, icon and
  label cells land on exactly the rails they land on in the other construction.
  Invariant #1 never learns that this row is built differently. It sets **no
  `gap`** — a subgrid inherits the parent's column gap, and restating it is how
  the leading cells drift off the rail — and its span is written end-relative
  (`1/-2`, `-2/-1` for the trailing cell) because `cp-row` is a 2-, 3- or
  4-track grid depending on what the panel occupies, and only the end-relative
  line is the same line in all three. It also takes `self-stretch` against the
  row's `align-items: center`, so the click target fills the full row height
  instead of only its content's.
- **The focus ring is painted by the box, from the region's focus.**
  `focus-ring-from` on the row box plus `data-focus-ring` on the region: the
  utility is `:has(> [data-focus-ring]:focus-visible)` and the region is a direct
  child, so keyboard focus on the selection rings the whole row, while focus on
  an action button rings only that button. `focus-ring-within` would light both
  at once — two indicators for one focus.
- **`disabled` scopes to the SELECTION, not the row.** With actions it dims and
  deadens the inner region only; the box stays live so the actions still work.
  That is the honest meaning of the prop and it is the case that occurs: a saved
  preset whose fields have all left the schema cannot be applied, and is exactly
  the one you want to delete. Without actions the two are the same thing and it
  reads as it always has.

The CSS pays one price, in the two track-dropping rules inside `@utility cp-row`:
a row's cells are direct children in one construction and one level deeper in the
other, so **both depths are written out** (four selectors, not a descendant
combinator that would also reach inside a row's label). Nothing else in that
utility learns about the second depth — the panel-level `:has([data-cp-icon])`
scan is already a descendant scan, so it finds an occupancy mark wherever the row
puts it.

`actions` is excluded from the `select="switch"` arm at the type level, the same
way `icon` is excluded from check/radio: the switch is drawn IN the trailing
cell, so a cluster there would be a second occupant of a cell that already has an
owner.

Host element is **inferred, never authored**: `href` → `<a>`,
`onSelect`/`disabled` → `<button>`, else `<div>`. Same rule as `Row`, and the
same rule on both constructions — it just decides a different node in each.
`ref` is the row BOX on both paths, deliberately: a ref that changed node the day
a row grew an action would hand a dnd transform a box that leaves the trailing
cell behind.

## Geometry: the `--cp-*` tokens

Declared at every theme-scope root in [`ui-kit`'s `app.css`](../ui-kit/web/theme/app.css)
— not inside the `@utility` block, because a custom property that reads a themed
var freezes its computed value wherever it is declared. The published
`--rail-start` is the one exception, and for the same reason read the other way:
it reads `--cp-rail-icon`, which `cp-panel` itself redeclares, so the two must be
declared on the same box or the rail freezes on the root's value.

| Token | Value | What it is |
| --- | --- | --- |
| `--cp-panel-pad` | `var(--panel-pad)` (density token, default `var(--space-xs)`) | the chrome pad — the gap a row's fill keeps from the panel's edge |
| `--cp-row-pad-x` | `var(--pad-row-x)` | inline padding inside a row or rule row |
| `--cp-gutter` | `var(--space-lg)` | leading track that hangs the drag handle — present only in a panel where some row has one |
| `--cp-icon-gap` | `var(--space-sm)` | **the** column gap — shared by `cp-row` and `cp-rule`, which is what puts a rule's prefix cell on the same rail as a row's icon cell |
| `--cp-icon-col` | `1.125rem` | the icon / selection-indicator track — present only in a panel where some row has one |
| `--cp-prefix-col` | `4rem` | the builder's prefix track ("Where", "And", "then by") |
| `--cp-remove-col` | `1.5rem` | minimum of the builder's trailing track |
| `--cp-row-h` | `var(--panel-row-h)` (density token, default `var(--control-height-md)`) | one row height (invariant #2) |
| `--cp-rule-h` | `var(--control-height-lg)` | one builder-row height |
| `--cp-rail-icon` | `calc(row-pad-x + gutter + icon-gap)`, or `var(--cp-row-pad-x)` in a panel with no handle | THE rail — the left edge of a row's leading cell, and the panel's own content inset |

The formula includes `--cp-icon-gap` because the grid's column gap *follows* the
track it names: the icon cell begins one gap after the gutter track ends.
Dropping that term is the easy way to get a rail that is 8px wrong.

`cp-panel` then publishes that as the **shared** rail — the repo-wide pair, not
a panel-private one:

| Published | Value | |
| --- | --- | --- |
| `--rail-start` | `calc(panel-pad + rail-icon)` | where loose content lands, chrome pad included |
| `--rail-end` | `calc(panel-pad + row-pad-x)` | so the content box ends where a row's trailing cell does |

The rail is the **whole** padding, not just the content half: a rail means *where
a child that does nothing lands*, and a bare `<Input>` here lands past both terms.
Publishing only the content half would advertise a rail 4px short of the real one.
The chrome pad is recovered by the two cancellers, which stop short of the panel's
inner edge on purpose.

**There is no `--cp-rail-text`.** The text rail — where a row's label starts — is
an interior column of the row grid, reached by the row's own tracks, and nothing
outside a row has any business naming it; handing it to loose content is the
defect v2 removed.

`--cp-icon-col` and `--cp-prefix-col` are the only genuinely new numbers — they
are column widths, which the spacing ramp does not model. Everything else binds
to the density ramp, so panels tighten under the Compact preset. Row height binds
to `--control-height-md` so a panel row lines up with every Button, Input and
ToggleChip in the app, extending the rail past the panel's own edge.

Seven utilities carry them: `cp-panel` (the region owner, and the box the two
leading tracks are derived on), `cp-body` + `cp-band` (the separator — one
mechanism, above), `cp-row` (gutter | icon | label | trailing, the first two
derived), `cp-rule` (six tracks, with `[data-span="field"]` collapsing the
operator track for a builder that has none and the gutter derived the same way
as a row's), `cp-setting` (label | value | status | actions, the last three
derived) and `cp-group` (the nested region). There is no `cp-rail-icon` utility:
the panel's own rail IS the icon rail, so content reaches it by doing nothing.

**`cp-setting` states its two leading tracks as PADDING, not as tracks**, and
that is the one thing to know about it. A `Setting` has no `handle` and no `icon`
in its type, so those cells could only ever be empty spacers — and a spacer is
padding. Saying so collapses what would otherwise be a 4× multiplier over the
three trailing cases (32 templates) into ONE extra declaration, because
`--cp-rail-icon` already carries the gutter case. The arithmetic is `cp-row`'s
label x written out: the leading *cell* sits at `--cp-rail-icon`, and the label
one icon column and one gap further on. Four panel shapes, two declarations, and
`setting-rail` measures the pair against a real `cp-row` rather than trusting
this paragraph.

The three trailing tracks are floors (`minmax(<token>, auto)`) with the same
caveat `cp-rule` records for its own trailing track: **keep a panel's `status`
and `actions` uniform, or the value column steps between rows.**

## `ControlPanelPopover` has no `width`, `padding` or `contentClassName`

That absence is the feature — those are exactly the props that let three panels
in one toolbar end up 481, 384 and 256px wide, each set by whatever was widest
inside it. `size` maps to a width **role** (`menu` = a list of choices,
`described` = choices that each carry a visible description line, `builder` = a
six-track rule row, `picker` = a panel whose body is a grid — each a density
token, `popoverWidth*`, so a theme sizes them), the padding is the body's, and
there is nowhere to smuggle a measurement through.

**The width is the SHOWING page's role.** A page pushed onto the stack may
declare its own `size` (`PanelStackEntry.size`): a menu whose Filter row opens
the filter builder is drawn menu-wide, and widens to `builder` only while that
page shows. The popover owns the stack's state (`usePanelStackState`) for
exactly this — the width is the surface's, so the showing page's role has to
reach `PopoverContent` in the same render that shows the page — and returns to
the root once the panel has finished closing. A pane ignores the field.

`maxHeight` **is** here, and is not that escape reopened: it is a passthrough of
`OverlayPanel`'s closed `PopoverMaxHeight` scale, invariant #5 is about *width*,
and fitting the viewport plus scrolling is already unconditional — so the prop
can only ever make a panel SHORTER than the space it has (a long Turn-into list
that would otherwise open as a viewport-tall wall). The three-panels-at-481/384/256px
failure a `width` prop caused has no height analogue.
`picker` (320px) exists because three shipped panels — the avatar picker, the
page icon button, the change-cover popover — arrived at that width
independently; one panel at a width is a measurement, three unrelated ones is a
role. Invariant #5 is enforceable because the
escape is absent from the type, not defaulted in it.

No `tooltip` prop either: the caller's trigger (typically an `IconButton`)
already owns its tooltip.

A row pushes a page with `ControlPanel.Row push={entry}` — never `onSelect` +
`usePanelStack().push` — and draws the trailing `chevron-right` that says it
drills, after its value. One spelling, so a drill row without its chevron is
unspellable. (The filter builder's own sub-pages still push through
`useFilterPanelStack`, which re-enters a filter scope around the page; they do
not have the chevron yet.)

**Every row in a panel is a `ControlPanel.Row`** — never the generic `css/row`
`Row`, which has its own height, gap and highlight (`control-panel/no-row-in-panel`
rejects one drawn inside a panel element in the same component). A row lights
with the shared menu highlight on hover AND on keyboard focus, exactly like a
dropdown row under the arrow keys — no focus ring. A panel opened beside a live
caret (the page editor's block menu) passes `keepFocus`: the row selects on
press without taking focus, and Enter / Space still select.

`Row selected` (the plain arm only — no `select`) marks the CURRENT row of a
single-choice list with a persistent fill instead of a mark: the `--selected`
tier `css/row`'s `selected` paints (`bg-selected text-accent-foreground`,
`aria-current`), which a theme sets apart from `--hover-fill`, so "current"
and "hovered" stay two looks. It is excluded from the check / radio / switch
arms at the type level — a row is current by fill or by mark, never both.

One more opt-in shape, default unchanged: `Row indicator="trailing"` on a check / radio row
draws the mark after the value so the leading cell holds a real `icon` — role
and `aria-checked` unchanged. A row with a visible `description` reads as a
title (medium, strong) over its prose, and its leading and trailing cells sit on
the title line.

Children are wrapped in a `ControlPanel.Stack`, so `usePanelStack()` works inside
any panel opened this way — a sub-panel is a push, never a popover opened from
inside a popover. The stack is published through **context** (and throws rather
than no-ops when absent) because one of its three consumers, custom-columns'
per-field editor, is a nested contribution with no prop path back to the chrome
hosting the panel.

## Enforcement

`exhibits/` contributes geometry-gated exhibits to the exhibit catalog,
swept at every width role (262 / 320 / 500 / 524 — the three popover roles plus
the config settings PANE, whose geometry was untested until it was added) and
measured in a real browser by
`./singularity check layout-geometry`: `rail-alignment` (invariant #1, across a
mixed row set — the panel's own inset against the row grid's leading cell, and
every row's label against a rail one of them computed), `mixed-content` (the same
rail, for content that is NOT a row — a bare `<Input>` and a `<Button>` measured
against a row's leading cell), `derived-tracks` (a panel with neither leading
track and a panel with only the gutter, so nothing is indented past a column
nothing paints in), `row-height`, `rule-grid` (both shapes), and `long-label` —
whose falsification re-renders the historical `absolute right-2` +
reserved-padding construct and asserts the overlap check genuinely fails on it.

Plus `setting-rail` (the two row grids' labels on one text rail, and the value
rail across a panel mixing `Row`, `Setting fit="field"`, `Setting fit="inline"`
and `Block` — the pair that can actually drift), `block-label-rail` and
`subhead-rail` (the two sides of the label-rung split above — a field label on
the text rail, a sub-head on the band label's — each gated in a panel with an icon
column so the two rails are genuinely apart) and `group-nested-rail` (a nested
group's republished rail against its children).

Plus `region` and `pane-region` — two **region exhibits** (`regionExhibit`), which say only
"`ControlPanel` / `ControlPanelPane` opens a region" and lets the harness fill it from `REGION_CHILDREN` (bare input, bare
button, bare prose, a `display: contents` contribution, a `rail-follow` band, a
`rail-bleed` row). This file used to ask authors to "render something other than
a `Row`", because rows were the one child kind the gate ever drew and three
geometry bugs shipped past it; a region fixture has nowhere to say what its
children are, so the request is now a mechanism. Adding a member to the kit
re-gates this panel with no edit here.

`useRailGuard` (`primitives/css/rail/web`) is the same check in dev, on the real
DOM: it names any child of a live panel whose content does not start on the
published rail.

> The harness oracle compares **widths only**. `rigidIntegrity` on a row pins the
> row's box, not its height, so invariant #2 rests on `--cp-row-h` plus the unit
> test — the oracle has no height invariant to express it with. It is likewise
> structurally blind to COLOUR, which is why the separator needs its own check:

`e2e/hairline-verify.ts` (manual; drives the deployed Tasks toolbar) reads the
composited pixels in the blank gap between each pair of bands and asserts exactly
one row there differs from the panel's own rendered background by ≥10 per channel
— plus none above the first band. It is **self-falsifying**: it then paints
`.cp-band::before` transparent and re-probes, requiring the same strips to report
nothing, so a probe aimed at the wrong y cannot pass forever. The background is
read off the render (the strip's modal colour), not resolved from a token, so a
wrong `--chrome-mask` is caught as well.

`lint/no-adhoc-panel-body` flags the three ways a panel body sections itself by
hand: a `DropdownMenuSeparator` with no `DropdownMenu*Content` ancestor, a
`<Separator>` inside a floating panel surface, and an `h-px` + `bg-border`
hairline. It closes the *drift* signals, not the whole class — a body built from
`Stack` + `SectionLabel` + `Button` with no divider is invisible to it, which is
what the burndown allowlist in `lint/index.ts` is for.

The primitive needs **no** new lint exemptions: it inherits the
`plugins/primitives/plugins/css/plugins/**` layout glob already in
`css/lint/index.ts` and stays clean against everything else.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The control-panel vocabulary: ControlPanel plus its closed set of members (Section, Subhead, Row, Setting, Block, Group, RuleList, RuleRow, Field, Footer, Empty, Stack) and its two surfaces, ControlPanelPopover and ControlPanelPane. The container draws the hairlines, the row is a grid so every label starts at one x, selection has one language per meaning, and width is a role rather than a measurement.
- Web:
  - Uses:
    - `primitives/css/rail.useRailGuard`
    - `primitives/css/selection-indicator.CheckboxIndicator`
    - `primitives/css/spacing.Stack`
    - `primitives/css/switch.SwitchIndicator`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.MENU_LABEL_PAINT`
    - `primitives/css/ui-kit.MENU_ROW_CHECKED`
    - `primitives/css/ui-kit.MENU_ROW_PAINT`
    - `primitives/css/ui-kit.MENU_VALUE`
    - `primitives/css/ui-kit.Popover`
    - `primitives/css/ui-kit.PopoverContent`
    - `primitives/css/ui-kit.PopoverMaxHeight`
    - `primitives/css/ui-kit.PopoverTrigger`
    - `primitives/icon-button.IconButton`
    - `primitives/overlay/tooltip.WithTooltip`
    - `primitives/row-actions.RowActions`
    - `primitives/row-actions.rowActionsAnchor`
    - `ui/icons.Icon`
  - Exports (types):
    - `ControlPanelBlockProps`
    - `ControlPanelEmptyProps`
    - `ControlPanelFieldProps`
    - `ControlPanelFit`
    - `ControlPanelFooterProps`
    - `ControlPanelGroupProps`
    - `ControlPanelHost`
    - `ControlPanelMark`
    - `ControlPanelPaneProps`
    - `ControlPanelPopoverProps`
    - `ControlPanelProps`
    - `ControlPanelRowIndicator`
    - `ControlPanelRowProps`
    - `ControlPanelRowSelect`
    - `ControlPanelRowTone`
    - `ControlPanelRuleListProps`
    - `ControlPanelRuleRowProps`
    - `ControlPanelSectionProps`
    - `ControlPanelSettingProps`
    - `ControlPanelSize`
    - `ControlPanelStackProps`
    - `ControlPanelSubheadProps`
    - `PanelStackApi`
    - `PanelStackEntry`
  - Exports (values):
    - `ControlPanel`
    - `ControlPanelPane`
    - `ControlPanelPopover`
    - `useControlPanelHost`
    - `usePanelStack`
- Cross-plugin:
  - Imported by: 33 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×11
    - `page` ×5
    - `primitives` ×4
    - `tasks` ×3
    - `config_v2` ×2
    - `fields` ×2
    - `ui` ×2
    - `apps-core/surface`
    - `fullscreen`
    - `reorder/edit-mode`
    - `shell/global-action-bar`
- Exemptions:
  - Exempts itself from: `control-panel/no-adhoc-panel-body` — `web/internal/control-panel-popover.tsx` (sanctioned)
  - Exempted by: `primitives/css/control-panel` (0 debt)

<!-- AUTOGENERATED:END -->
