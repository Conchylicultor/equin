# control-panel

Rationale (why each rule is so, rejected alternatives): [DESIGN.md](DESIGN.md) — read before changing or removing a rule.

The vocabulary for a **data-control panel** — the body of a Filter / Sort popover,
a view-settings menu, a settings pane, a per-field editor. One compound namespace
(`ControlPanel` + `.Section` / `.Subhead` / `.Row` / `.Setting` / `.Block` /
`.Group` / `.RuleList` / `.RuleRow` / `.Field` / `.Footer` / `.Empty` / `.Stack`)
and three surfaces (`ControlPanelPopover`, `ControlPanelPane`, `ControlPanelCard`).

Four ways to be one field:

- `Row` — the row *is* the control.
- `Setting` — the row *holds* the control.
- `Block` — the control is wider than a row.
- `Group` — the field is other fields.

Plus the builder pair (`RuleList` / `RuleRow`), the boxes and bands, and
`Subhead` (names a *run* of rows).

## The five invariants

1. **One rail.** Every label in every panel starts at the same x.
2. **One row height**, always.
   - Sole exception: a row passing `description` (a visible wrapping second
     line) is two lines tall.
   - Opt-in, exclusive with `hint` (tooltip, no height); only for a choice that
     must be read before picking (the page-kind menu).
   - Everything else uses `hint`.
3. **One selection language per meaning** — check, radio, switch. No fourth; never
   mixed on one row (`RowProps` is a discriminated union).
4. **Footers are rows**, never ghost buttons in corners, and **a footer action
   takes a leading `icon`, on every panel.**
   - This is a convention, not construction: the glyph opens the icon column,
     so in a panel with ordinary rows it indents their labels by 26px.
   - Do not exempt footers from the track scan.
5. **Width is a role, not a measurement, and the CONTENT picks the role** — one of
   four buckets (see below). Nothing that opens a panel can name a width.

## The panel paints no surface

`ControlPanel` draws no background, border, shadow, radius, scroll, height clamp
or **width**.

The surface is the `OverlayPanel` of whatever contains it
(`ControlPanelPopover`, `DialogContent`, a pushed panel-stack entry):

- no double elevation;
- a sub-panel is a push, never a box re-deriving chrome.

The body **does** own geometry: content inset, rails, and **the hairline between
bands**. The container separates; an author never places a divider (a null
section leaves no orphan rule).

## The separator is a band's rule, cancelled by the panel — NEVER a sibling rule

`renderIsolated` wraps every contributed panel in `display: contents` lineage
spans, which are transparent to layout but opaque to selectors — so `> * + *`,
`:first-child`, `~` match nothing here. Never use adjacency selectors.

The separator is built from three pieces:

- **`cp-body`** — flex column + `gap` (spacing strictly *between* bands).
- **`cp-band`** (`Section` + `Footer` only) — draws the rule as a `::before` hung
  `--cp-panel-pad` above the band, adding no height.
- **`cp-body::after`** — paints `--chrome-mask` over the first band's rule (no
  selector can name that band).

One edit from wrong:

- The rule is **not** a `border-top` (real height can't be cancelled by ink).
- **`cp-panel` and `cp-body` stay on ONE element** — the mask's `top: 0` relies on
  it (unit-tested).
- **`::after`, not `::before`** — both paint at `z-index: auto` in tree order.
- **`ControlPanel.Stack` is `display: contents`** (no `className`) — one band
  container, one mask.
- `RuleList`, `Empty`, `Subhead` are **not** bands: they live inside a section, so
  a rule would cut through it.
- **`--border` is the right colour** — don't add a surface-relative separator var
  (`--popover` = `--card`, and `--border` is calibrated against `--card`).
  `e2e/hairline-verify.ts` measures rendered contrast.

## The panel is a rail region, and it has exactly one owner

An instance of the repo-wide rail contract — read
[`primitives/css/rail`](../rail/CLAUDE.md).

**One box opens the region — `cp-panel`, as its own padding. Every other
participant either inherits the rail or cancels it, never both.**

- **Inherits** — raw `<Input>`, a contributed `FieldRenderer`, a section label, any
  JSX dropped in a `Section`. Lands on the rail by doing nothing (no wrapper, no
  class). Never add your own content inset inside a panel.
- **Cancels** — only `cp-row` and `cp-rule` (deliberately not `rail-bleed`): they
  bleed out by `--cp-panel-pad` so the hover/selected fill spans the panel's inner
  edge, then re-apply `--cp-row-pad-x`, landing the leading cell back on the rail.
- `cp-panel` publishes an **asymmetric** `--rail-start` / `--rail-end` directly
  (custom-value case) and pays its own rail, so `--rail-owed-*` is `0px`.

**The rail is the ICON rail**: the panel's content edge is where every row's
icon, indicator and drag handle begins.

- A heading, a search field and a swatch grid share one left edge with rows'
  leading column.
- Only a row's LABEL indents past the icon column (when present).
- There is no `cp-rail-icon` utility and **no `--cp-rail-text`** — the text rail
  is interior to the row grid; never hand it to loose content.

**The handle-less case is declared on `cp-panel`, never at `:root`** — a custom
property is substituted where declared, so a root-declared rail freezes on the
root's `--cp-rail-icon`. Both declarations must land on the same element.

Exact cancellations:

- `cp-band`'s rule bleeds by the panel's **whole** inset (chrome pad + content
  inset); drop a term and every divider insets or overhangs.
- A row's negative margins are paid back in `width: calc(100% + start + end)`,
  never `width: auto` (a `<button>` host would shrink to content).

## The two leading tracks are derived from the panel's content

A track exists only when something in the **panel** occupies it:

- the gutter — by a drag handle (`data-cp-handle`);
- the icon column — by an icon, checkbox or radio mark (`data-cp-icon`). **Not
  by a switch** — its indicator lives in the trailing cell.

`cp-panel` turns the markers into one template for every row via `:has()`.
**Per panel, never per row** (per-row would break invariant #1).

- The marker is **declared from props, never derived from the rendered node** — an
  unchecked radio draws nothing but owns the column.
- `icon` is excluded from check/radio only; `icon` + `select="switch"` is legal
  (otherwise the glyph goes in the label cell and knocks text off the rail).
- `ControlPanel.Stack`'s `display: contents` doesn't block the scan.

One edit from wrong:

- **Each case is its own `grid-template-columns`, never a zeroed width** — a `0px`
  track keeps its column gap (rail lands 8px off).
- **The cell that lost its track is `display: none`d** — a row always renders four
  cells; an unhidden empty one auto-places into the wrong track.
- **The rules are nested inside the `@utility` blocks** — a `@layer base` rule
  loses to `cp-row`'s own template. `cp-rule` needs *two* handle-less templates
  (three-cell and `[data-span="field"]`).

## The four field members, and what each of them is not

- **`Setting` is a sibling of `RuleRow`**, not a `select` arm and not a promoted
  `Field`.
  - It is a non-interactive `<div>` box whose *cells* are interactive (a `Row`
    holding a dropdown would nest `<button>`s).
  - `Row` vs `Setting` differ on one axis — who is the click target — enforced
    by disjoint prop sets.
- **`Setting` has no `icon`, deliberately** — the track scan is per panel, so one
  contributed field's icon would indent every label in a panel its host doesn't
  own. Excluded at the type level.
- **`Setting` and `Group` take a drag `handle`, like `Row`** (bag:
  `ControlPanelHandleProps`).
  - A `Setting` / inline `Group` header has no gutter track, so the handle hangs
    absolutely at `--cp-row-pad-start` and stamps the same `data-cp-handle`.
  - A pushing `Group` forwards it to its drill row.
- **`fit` is required and sizes the CONTROL, not the track**:
  - `fit="inline"` sizes to itself (swatch, avatar, stepper);
  - `fit="field"` gets `--cp-value-col`, so every dropdown/input is the same
    box.
  - The value track's existence is derived per panel from `data-cp-value`.
- **A `Block` label is on the TEXT rail** (a field label, like `Row` / `Setting`
  labels), not the panel content edge.
  - `Block` is **not** a `Section`: no `cp-band`, so a run of blocks has no
    hairlines.
- **`Group` has no `mode`** — it reads `useControlPanelHost()`.
  - Its `actions` / `mark` / `note` work **only under `inline`**.
  - Under `push` (a drill-row `<button>`) it **throws** rather than silently
    dropping them.

## The three label rungs, and where each one starts

| rung | member | rail | paint |
|---|---|---|---|
| names a band | `Section` label | panel content edge | ui-kit `MENU_LABEL_PAINT` |
| names a run of rows in a band | `Subhead` | panel content edge (carries no class — inherits) | `MENU_LABEL_PAINT` |
| names one control | `Row` / `Setting` / `Block` label | text rail (row label cell) | — |

Use `Subhead`, not a `Section` (would rule a hairline under its heading) or a
field label (would indent it).

## Three surfaces, picked by what the thing IS

| surface | it is | sections draw | descriptions | width |
|---|---|---|---|---|
| `ControlPanelPopover` | a menu of choices (filter, sort, view settings) | the menu section label | `hint` | the showing page's need (`cp-surface`) |
| `ControlPanelPane` | a settings pane | the menu section label | on the band | the pane's |
| `ControlPanelCard` | a titled settings card under a gear (an app's own settings) | a **heading** over body prose | on the band | `settings` (density `popoverWidthSettings`) |

Never build an app's settings gear as a `ControlPanelPopover` (it comes out a
menu), and never add `headingStyle` / `width` knobs to the popover — use the
card.

`ControlPanelCard`:

- **requires `title`** — a title row with close button above the body (not the
  popover's sticky `header`), and the panel's accessible name;
- host policy `sections: "heading"` — `Section` label as heading, description as
  prose, via the overlay token group's `settingsTitle` / `settingsHeading` /
  `settingsProse` picks (`<Text pick>`);
- `cp-card` on the popup: `--cp-panel-pad` = density `settingsCardPad`;
- initial focus on the title row on pointer open (keyboard open → first control).

No surface takes `width`, `padding` or `className`. A `Section` outside any host
draws its plain label (`useSectionStyle`).

## The host owns the presentation, and throws when absent

```ts
interface ControlPanelHost {
  nesting: "push" | "inline";
  inlineDepth: number;
  descriptions: "band" | "hint";
  sections: "label" | "heading";
}
```

| surface | host |
| --- | --- |
| `ControlPanelPopover` | `{ push, 0, hint, label }` |
| `ControlPanelPane` | `{ inline, 1, band, label }` |
| `ControlPanelCard` | `{ inline, 1, band, heading }` |

- The pane and the card still wrap children in a `ControlPanel.Stack`, so depth
  ≥ 2 falls back to a push.
- `useControlPanelHost()` **throws** with no host (same as `usePanelStack()`).

**An inline group is a nested rail region** (`cp-group`) — never a margin, never
`border-l` + `pl-lg`.

- It republishes the rail as `panel-pad + rail-icon + step` (not the bare step)
  and redeclares `--cp-row-pad-start`, because a nested `cp-row` bleeds back by
  the chrome pad and re-applies its own leading padding.
- Gated by `group-nested-rail`.

## `ControlPanel.Row` is its own grid, not a composed `Row`

`css/row`'s `Row` is flex (label x depends on the icon; trailing slot is
hover-revealed/overlay-pinned), so the two stay separate and share **tokens**
(`--pad-row-x`, `--control-height-md`, hover fill), not code.

The look is ui-kit's shared menu-row paint — see ui-kit's "Menu rows share one
definition":

- `MENU_ROW_PAINT` + `MENU_ROW_CHECKED`, `hover:menu-row-lit`;
- `tone="danger"` → `data-variant="destructive"`;
- trailing cell `MENU_VALUE`.

Every trailing cluster (`RuleRow`, `Setting`, `Row`) composes `row-actions` at
`pin={null}` in a reserved track.

### The row has two constructions, and `actions` picks one

- **Without `actions`** — the inferred element IS the row box (`cp-row`, four
  cells as direct children). The trailing cell is presentational (no controls);
  `select="switch"` owns it.
- **With `actions`** — the box is a non-interactive `<div>`; the inferred element
  moves inside as the *selectable region*, a sibling of the action buttons.
  - The region is a **`subgrid`** (`grid-cols-subgrid col-[1/-2]`): sets **no
    `gap`** (inherits), spans are **end-relative** (`1/-2`, `-2/-1`) because
    `cp-row` has 2–4 tracks, and `self-stretch` fills row height.
  - **Focus ring**: `focus-ring-from` on the box + `data-focus-ring` on the region
    (direct child). Not `focus-ring-within` (would ring for action focus too).
  - **`disabled` scopes to the selection**, not the row — actions stay live (a
    stale preset can't be applied but can be deleted).
  - The track-dropping rules in `@utility cp-row` write out **both cell depths**
    (four selectors, not a descendant combinator).
- `actions` is excluded from `select="switch"` at the type level (switch owns the
  trailing cell).

Host element is **inferred, never authored**:

- `href` → `<a>`;
- `onSelect` / `disabled` → `<button>`;
- else `<div>`.

`ref` is always the row BOX (stable for dnd transforms).

### Row rules

- **Every row in a panel is a `ControlPanel.Row`**, never `css/row`'s `Row`
  (`control-panel/no-row-in-panel`).
  - Rows light with the menu highlight on hover and keyboard focus — no focus
    ring.
  - Beside a live caret (block menu) pass `keepFocus`.
- **Drill:** `ControlPanel.Row push={entry}` — never `onSelect` +
  `usePanelStack().push`; it draws the trailing `chevron-right`.
  - The filter builder's sub-pages still push via `useFilterPanelStack`, no
    chevron yet.
- **`selected`** (plain arm only) marks the CURRENT row of a single-choice list
  with the `--selected` fill + `aria-current`; excluded from check/radio/switch.
- **`indicator="trailing"`** on check/radio draws the mark after the value so the
  leading cell holds a real `icon`.
- A row with `description` reads as title (medium, strong) over prose; leading and
  trailing cells sit on the title line.

## Geometry: the `--cp-*` tokens

Declared at every theme-scope root in
[`ui-kit`'s `app.css`](../ui-kit/web/theme/app.css), not inside `@utility` (a
custom property reading a themed var freezes where declared).

Exception: `--rail-start` reads `--cp-rail-icon`, which `cp-panel` redeclares,
so both live on `cp-panel`.

| Token | Value | What it is |
| --- | --- | --- |
| `--cp-panel-pad` | `var(--panel-pad)` (density, default `var(--space-xs)`) | chrome pad — gap a row's fill keeps from the panel edge |
| `--cp-row-pad-x` | `var(--pad-row-x)` | inline padding inside a row / rule row |
| `--cp-gutter` | `var(--space-lg)` | drag-handle track (only if some row has a handle) |
| `--cp-icon-gap` | `var(--space-sm)` | **the** column gap, shared by `cp-row` and `cp-rule` |
| `--cp-icon-col` | `1.125rem` | icon / indicator track (only if some row has one) |
| `--cp-prefix-col` | `4rem` | builder prefix track ("Where", "And", "then by") |
| `--cp-remove-col` | `1.5rem` | min of the builder's trailing track |
| `--cp-row-h` | `var(--panel-row-h)` (density, default `var(--control-height-md)`) | row height (invariant #2) |
| `--cp-rule-h` | `var(--control-height-lg)` | builder-row height |
| `--cp-rail-icon` | `calc(row-pad-x + gutter + icon-gap)`, or `var(--cp-row-pad-x)` with no handle | THE rail — a row's leading-cell edge and the panel's content inset |

`--cp-icon-gap` is in the rail formula because the column gap follows the gutter
track; drop it and the rail is 8px off.

`cp-panel` publishes the shared rail pair — the **whole** padding, chrome pad
included:

- `--rail-start: calc(panel-pad + rail-icon)`
- `--rail-end: calc(panel-pad + row-pad-x)`

Utilities:

| utility | what it is |
| --- | --- |
| `cp-panel` | region owner; leading tracks derived here |
| `cp-body` + `cp-band` | separator |
| `cp-row` | gutter \| icon \| label \| trailing |
| `cp-rule` | six tracks; `[data-span="field"]` drops the operator track |
| `cp-setting` | label \| value \| status \| actions |
| `cp-group` | nested region |

- **`cp-setting` states its two leading tracks as PADDING, not tracks** (a
  `Setting` has no handle/icon), avoiding a 4× template blowup; `setting-rail`
  measures it against a real `cp-row`.
- Trailing tracks are `minmax(<token>, auto)` floors: **keep a panel's `status`
  and `actions` uniform, or the value column steps between rows.**

## `ControlPanelPopover` has no `width`, `size`, `padding` or `contentClassName`

That absence is the feature (a width prop let three toolbar panels end up 481,
384 and 256px wide). Never add one.

- `maxHeight` exists — a passthrough of `OverlayPanel`'s closed
  `PopoverMaxHeight` scale that can only make a panel shorter.
- No `tooltip` prop: the trigger owns it.

Children are wrapped in a `ControlPanel.Stack`, so `usePanelStack()` works in any
panel — a sub-panel is a push, never a popover from a popover.

The stack is published via **context** and throws when absent (custom-columns'
per-field editor reaches it with no prop path).

### The content declares its width; the surface collects it

Buckets — each a density token `popoverWidth*`:

| bucket | for |
| --- | --- |
| `menu` | baseline |
| `described` | choices with visible descriptions — a wrap width, can be narrower than menu |
| `picker` | a grid; 320px default |
| `builder` | six-track rule rows |

**The content chooses, never the opener** (`width-need.ts`):

- **Members state their own need**:
  - `RuleRow` stamps `data-cp-needs="builder"`;
  - a `Row` with `description` stamps `described`.
- **Opaque content declares it on its band**:
  - `ControlPanel.Section needs="picker"` around an icon / emoji / swatch grid
    or calendar;
  - `needs="builder"` on a builder page with no rule row yet (empty filter, Add
    filter, Add sort), so it doesn't widen under the pointer;
  - a slot whose contributions render sections carries the need in its
    contribution (`QuickTheme.Section`'s `needs`).
- **The surface collects**: the popup is `cp-surface` (`app.css`).
  - `:has()` rules in rank order menu < described < picker < builder pick the
    highest need on the **showing** level (`data-cp-showing`, set by
    `ControlPanelStack`; hidden levels don't count).
  - Rank, not `max()` of pixels. Pure CSS, right on first paint.

Don't move the declaration back to the opener (`size`, `PanelStackEntry.size`,
`"inherit"` were all tried and overflowed) — only the content knows.

### The measured backstop: `panel-overflow`

`overflow-guard.ts` runs on every panel inside a `cp-surface` (`ResizeObserver` +
subtree `MutationObserver`, once per frame). When content doesn't fit and the
surface isn't viewport-capped, it fails loudly.

- It measures both overflow past the PANEL edge and out of a grid CELL (tracks
  are `min-w-0`, so a builder row in a menu panel squeezes without widening the
  panel).
- A cell that clips doesn't count.
- It emits a `PanelOverflowFault` to `panelOverflowReportSink` (filed by
  `reports/panel-overflow`) and throws in dev.

## Enforcement

- **Geometry exhibits** (`exhibits/`), swept at 262 / 320 / 500 / 524 and
  measured by `./equin check layout-geometry`:
  - `rail-alignment`, `mixed-content`, `derived-tracks`, `row-height`,
    `rule-grid`, `long-label`, `setting-rail`, `block-label-rail`,
    `subhead-rail`, `group-nested-rail`;
  - plus the region exhibits `region` / `pane-region` (`regionExhibit`, filled
    from `REGION_CHILDREN`, so a new kit member re-gates the panel
    automatically).
- `useRailGuard` (`primitives/css/rail/web`) — same check in dev on the live DOM.
- The harness compares **widths only**:
  - invariant #2 rests on `--cp-row-h` + the unit test;
  - colour rests on `e2e/hairline-verify.ts` (manual; self-falsifying — paints
    `.cp-band::before` transparent and re-probes).
- `lint/no-adhoc-panel-body` flags hand-sectioned panel bodies:
  - a `DropdownMenuSeparator` outside `DropdownMenu*Content`;
  - a `<Separator>` in a floating surface;
  - an `h-px` + `bg-border` hairline.

  A divider-less hand-built body is invisible to it (burndown allowlist in
  `lint/index.ts`).
- `control-panel/no-row-in-panel` — see Row rules.
- No layout-lint exemption needed: covered by the `css/plugins/**` glob in
  `css/lint/index.ts`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The control-panel vocabulary: ControlPanel plus its closed set of members (Section, Subhead, Row, Setting, Block, Group, RuleList, RuleRow, Field, Footer, Empty, Stack, LabelMark) and its three surfaces: ControlPanelPopover (a menu of choices), ControlPanelPane (a settings pane) and ControlPanelCard (a titled settings card under a gear — sections drawn as headings over prose). The container draws the hairlines, the row is a grid so every label starts at one x, selection has one language per meaning, and width is a role rather than a measurement.
- Web:
  - Uses: 24 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×12
    - `primitives/row-actions` ×2
    - `primitives/css/fill.Fill`
    - `primitives/css/rail.useRailGuard`
    - `primitives/css/selection-indicator.CheckboxIndicator`
    - `primitives/css/spacing.Stack`
    - `primitives/css/switch.SwitchIndicator`
    - `primitives/css/text.Text`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useEventCallback`
    - `ui/icons.Icon`
  - Exports (types):
    - `ControlPanelBlockProps`
    - `ControlPanelCardProps`
    - `ControlPanelEmptyProps`
    - `ControlPanelFieldProps`
    - `ControlPanelFit`
    - `ControlPanelFooterProps`
    - `ControlPanelGroupProps`
    - `ControlPanelHandleProps`
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
    - `ControlPanelStackProps`
    - `ControlPanelSubheadProps`
    - `ControlPanelWidthNeed`
    - `PanelOverflowFault`
    - `PanelStackApi`
    - `PanelStackEntry`
  - Exports (values):
    - `ControlPanel`
    - `ControlPanelCard`
    - `ControlPanelPane`
    - `ControlPanelPopover`
    - `panelOverflowReportSink`
    - `useControlPanelHost`
    - `usePanelStack`
- Cross-plugin:
  - Uses tokens: 34 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×13
    - `ui/tokens/density` ×11
    - `ui/tokens/type-scale` ×7
    - `ui/tokens/shape` ×2
    - `ui/tokens/shadow --shadow`
  - Imported by: 46 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×16
    - `page` ×5
    - `primitives` ×4
    - `audience` ×3
    - `config_v2` ×3
    - `tasks` ×3
    - `fields` ×2
    - `hints` ×2
    - `ui` ×2
    - `apps-core/surface`
    - `conversations/conversation-view/dependencies`
    - `framework/cli/build/experimental-marks`
    - `fullscreen`
    - `reports/panel-overflow`
    - `shell/global-action-bar`
- Exemptions:
  - Exempts itself from:
    - `control-panel/no-adhoc-panel-body` — `web/internal/control-panel-popover.tsx` (sanctioned)
    - `control-panel/no-adhoc-panel-body` — `web/internal/control-panel-card.tsx` (sanctioned)
  - Exempted by: `primitives/css/control-panel` (0 debt)

<!-- AUTOGENERATED:END -->
