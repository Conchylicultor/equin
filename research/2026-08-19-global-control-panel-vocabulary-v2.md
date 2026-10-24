# Control-panel vocabulary v2 — one edge for loose content, derived tracks, and the migration

Supersedes the geometry half of [`2026-08-16-global-control-panel-vocabulary.md`](./2026-08-16-global-control-panel-vocabulary.md).
That doc's five invariants, member set, and lint rule stand; this one changes where the
panel's content inset sits, makes the two leading tracks conditional, and burns down the
hand-rolled panels.

## Context

The vocabulary shipped and DataView's control panels moved onto it. Reviewing the migrated
surfaces against the panels they replace turned up three complaints that are all one defect:

- the quick-theme panel's search field and cards no longer line up with the `THEME` heading
- the avatar picker, which was clean hand-rolled, came out visibly messier than before
- the icon picker lost density

Everything below was measured in the `control-panel-studies` prototype
(`~/.singularity/prototypes/control-panel-studies/`, 11 studies), whose `cp-*` block is a
verbatim port of `app.css` and is held to it by a drift checker — so a number here is a
number the app produces, not a mock's approximation.

**The defect.** `--cp-inset-start` is `--cp-rail-text` — the x where a *row's label* lands,
after the row's icon column. But the text rail is an interior column of the row grid, not an
edge of the panel. Handing it to loose content (a search field, a swatch cluster, a card
grid) indents that content 26px past everything, and the section label alone escapes by
hanging back through `cp-rail-icon`. Measured on the pickers deck: **three left edges in one
panel — 4px, 12px, 38px — and padding of 38px left against 12px right.**

Worse, what opens the icon column is not the loose content's business: **one leading glyph on
one footer row reserves it for the whole panel.** The `✕` beside `Clear` moves the search
field 26px right. Measured: glyph leading → 38/12px padding; glyph trailing or absent →
12/12px.

**The outcome.** Loose content and section labels share one edge by construction, panel
padding is symmetric, and a footer glyph can no longer move anything above it.

## What changes

### 1. The content inset is the icon rail

`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`

In the `--cp-*` block inside `:root, [data-theme-scope]`:

- delete `--cp-rail-text` (after this change nothing reads it)
- delete `--cp-inset-start: var(--cp-rail-text)` from the root block

In `@utility cp-panel`, declare the inset **on the panel itself**:

```css
@utility cp-panel {
  --cp-inset-start: var(--cp-rail-icon);
  padding-block: var(--cp-panel-pad);
  padding-inline: calc(var(--cp-panel-pad) + var(--cp-inset-start))
    calc(var(--cp-panel-pad) + var(--cp-inset-end));
}
```

**This placement is load-bearing, not stylistic.** A custom property declared in terms of
another is substituted where it is *declared*. Left at `:root`, `--cp-inset-start` would
freeze on the root's `--cp-rail-icon` (32px) and the derived-tracks rules below — which move
`--cp-rail-icon` on `.cp-panel` — would not reach it. Both declarations must land on the same
element. This cost real time in the prototype; verify it first.

Delete `@utility cp-rail-icon`. It computes `--cp-rail-icon - --cp-inset-start`, which is now
always 0. This proposal removes a member rather than adding one.

### 2. The two leading tracks are derived from content

A leading track is reserved only when something in the panel occupies it: the gutter by a
drag handle, the icon column by an icon or a selection indicator. Per panel, never per row —
a per-row rule would break invariant #1.

`ControlPanel.Row` and `ControlPanel.RuleRow` must start *marking* their occupants; today they
emit no such attribute. Follow the plugin's existing `data-cp-*` convention
(`data-cp-footer`, `data-cp-cell`):

- `data-cp-handle` on the gutter cell, when `handle` is set
- `data-cp-icon` on the leading cell, when `icon` or `select` is set

Then, nested inside the utilities so they land in the same cascade layer (a `@layer base`
rule would *lose* to the utility regardless of specificity):

```css
@utility cp-panel {
  /* … as above … */
  &:not(:has([data-cp-handle])) { --cp-rail-icon: var(--cp-row-pad-x); }
}

@utility cp-row {
  grid-template-columns: var(--cp-gutter) var(--cp-icon-col) minmax(0, 1fr) auto;
  /* … */
  .cp-panel:not(:has([data-cp-handle])) & { grid-template-columns: var(--cp-icon-col) minmax(0, 1fr) auto; }
  .cp-panel:not(:has([data-cp-icon])) & { grid-template-columns: var(--cp-gutter) minmax(0, 1fr) auto; }
  .cp-panel:not(:has([data-cp-handle])):not(:has([data-cp-icon])) & { grid-template-columns: minmax(0, 1fr) auto; }
}
```

`cp-rule` needs the same treatment for its gutter track. Dropping a track must drop the column
gap that follows it, which is why each case is its own template rather than a zero width.

`ControlPanelStack`'s `display: contents` does not block `:has()` — the stack renders inside
the same `.cp-panel`.

### 3. The footer keeps its glyph, on the LEADING edge

**Corrected 2026-08-20, during the rebase onto main.** This section originally
said footer actions move to `trailing`. That produced THREE different treatments
of one thing — a trailing upload glyph on change-cover, no glyph at all on
page-icon's Remove and avatar's Clear — and it contradicted the prototype the
user approved, which showed a LEADING glyph. Footer actions now take a leading
`icon`, uniformly, on every panel.

Convention, not mechanism, either way. Invariant #4 says footers *are* rows, so
exempting them from the track scan would be a lie about the markup. With the rail
on the icon column the cost is contained to row LABELS rather than every block,
and in a picker whose only row IS the footer it costs nothing at all. The one
real price, measured: in a panel that also has ordinary rows (quick-theme's six
variant rows) a leading footer glyph still indents their labels 26px.

### 4. A third width role: `picker`

`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/popover-width.ts`

```ts
picker: "w-80 max-w-(--available-width)",   // 320px — a panel whose body is a grid
```

and add `"picker"` to `ControlPanelSize` in `control-panel-popover.tsx`.

The studies rejected a third role, and I argued that rejection. It was right at the time: one
content set justifies a measurement, not a role. The evidence has changed — **three
independent shipped panels already sit at `xl` = 320px** (avatar picker, page icon button,
change cover popover), and forcing them to `menu` = 262px is what wraps the avatar picker's
ten colour swatches onto a second row. Three consumers arriving at one width independently is
what separates a role from a measurement.

If you would rather hold the line at two roles, the consequence is those three panels get
visibly tighter than what they replace; nothing else in the plan depends on this.

## What does not change

- **`ControlPanel.Grid` / a closed cell scale — do not ship.** Calibrating it against the real
  panels showed the first scale was invented: `icon 44px` / `tile 112px` against shipped cells
  of ~28px and ~56px, about 2× across the board, so a picker built on it comes out *less*
  dense than the grid it replaces. Worse, a minimum cell and a typed column count are not
  interchangeable — `auto-fill` picks the count from the width, so one scale gives an icon
  picker 7 columns at 228px and 9 at 286px. Pickers want a stable count. Callers keep typing
  one; `ControlPanel` does not own content layout.
- **`cp-bleed` / letting non-text blocks out of the inset — do not ship.** It was a rescue for
  the wrong inset. On the icon rail a block is already level with its heading and already
  symmetric; bleeding now walks it 8px *past* its own heading.
- **Row descriptions and a per-row width — still rejected**, per the v1 doc.
- Sticky footers: `ControlPanel.Footer` should stick to the bottom of the scrolling surface.
  Settled in the studies, unchanged here, and listed under bugs below because the shipped
  `OverlayPanel` has a sticky `header` prop and no footer counterpart.

## Bugs to fix alongside

Three defects the studies found in shipped code, each independent of the geometry change:

1. **Reorder popover, orphan hairline.** A rule paints above the first band when nothing is
   hidden. `plugins/reorder/plugins/editor/`.
2. ~~**Date picker off-by-a-month.**~~ **WITHDRAWN — this bug is not in the shipped code.**
   The claim was that a trailing-cell ISO date is built as `"2026-08-" + day`, so clicking
   Sep 3 selects Aug 3. No such concatenation exists in `primitives/date-picker` or in
   `fields/date/filter`, and `git log -S` finds it never did. Every cell is a real `Date` from
   `buildMonthGrid`, serialized by `toISODay`, and `Calendar.pick()` pages to the clicked day's
   own month before emitting. The study measured its own prototype calendar and I recorded the
   result as a finding about the app — a mock is not evidence about shipped code. (A real
   related defect *was* fixed in 6bf09e9da on 2026-08-03: `toISODay` was UTC.) Three pinning
   cases now live in `date-picker/web/__tests__/calendar-grid.test.tsx` so it cannot regress.
3. **Sticky header occludes the scroll fade.** `OverlayPanel`'s sticky `header` covers 39 of
   the 46px top fade. `ui-kit/web/components/overlay-panel.tsx`. Fixing this is also where the
   footer counterpart belongs.

## Migration

Blast radius of the primitive change is bounded: the only consumers today are DataView and its
`view-core` / `custom-columns` sub-plugins (22 files, all under
`plugins/primitives/plugins/data-view/`). Nothing outside DataView renders a `ControlPanel`.

Order, each step independently shippable:

**Step 1 — primitive.** §1–§4 above, plus the fixtures. `control-panel/fixtures/` contributes
`rail-alignment`, `mixed-content`, `row-height`, `rule-grid`, `long-label` to the Layout Lab,
swept at every width role and measured by `./equin check layout-geometry`.
`rail-alignment`'s expected numbers change (labels move 58 → 32px) and a derived-tracks case
needs adding. Note the plugin `CLAUDE.md` rule that a new fixture must render something other
than a `Row`. Verify DataView's panels visually before touching anything else.

**Step 2 — the three pickers.** `avatar-picker.tsx`, `page-icon-button.tsx`,
`change-cover-popover.tsx`. Highest visual payoff and the surfaces the complaints came from.
All three today are raw `Popover` + `PopoverContent width="xl" padding="sm"` with a
hand-drawn `h-px bg-border` hairline; all three become `ControlPanelPopover size="picker"` with
`Section` + `Footer`, keeping their own grid markup. Drop three burndown entries.

**Step 3 — the remaining hand-rolled panels.** `callout-appearance.tsx`,
`block-actions-menu.tsx`, `category-chip.tsx`, `date-filter.tsx`, `metronome-button.tsx`, plus
`quick-theme-panel.tsx`, `view-options-toggle.tsx` and `fx-toggle.tsx` (see the lint gap
below). `theme-customizer.tsx` is a *pane*, not a panel — its hairline is a labelled rule, so
it belongs with step 4, not here.

**Step 4 — the labelled rule is not a control panel.** `commits-graph-body.tsx`,
`summary-row.tsx` and `theme-customizer.tsx`'s preset divider all draw the same shape: a
centered muted label flanked by growing hairlines. That is a `Separator` with a label, and it
has no primitive home — which is why all three hand-rolled it. Add the label variant to the
existing `Separator`, migrate the three, and drop them from the allowlist. They should never
have been on a control-panel burndown list.

## The lint rule catches drift signals, not the class

`no-adhoc-panel-body` fires on a `DropdownMenuSeparator` outside a menu, a `Separator` inside a
floating panel, or a hand-drawn `h-px` + `bg-border` pair. A hand-rolled panel that simply has
no divider is invisible to it. The exploration confirmed this is not hypothetical:
`change-cover-popover.tsx` is structurally identical to the allowlisted `avatar-picker.tsx`
and is not flagged; neither are `quick-theme-panel.tsx`, `view-options-toggle.tsx` or
`fx-toggle.tsx`.

Add a fourth signal that names the class rather than its symptoms: a `SectionLabel` rendered
inside a `PANEL_SURFACES` host with no `ControlPanel` ancestor. That is what all four missed
files have in common, and it is what a hand-rolled panel *is*. Land this at the end of step 3
so it does not fire on work already queued.

## Verification

```bash
./equin check app-css-utilities-in-sync   # any @utility added or removed
./equin check css-vars-single-owner       # --cp-inset-start now has one declaring site
./equin check css-vars-supplied           # --cp-rail-text deleted; no dangling var()
./equin check inherited-theme-defaults-scoped
./equin check layout-geometry             # the fixtures, at every width role
./equin check                             # boundaries, type-check, eslint, docs
./equin test plugins/primitives/plugins/css/plugins/control-panel
./equin build
```

`control-panel/web/__tests__/control-panel.test.tsx` asserts host inference and the
single-selection-language invariant; neither should move. Add a case for the derived tracks —
a panel with no handle and no icon renders a two-track row.

Then, against the deployed worktree:

```bash
bun plugins/primitives/plugins/css/plugins/control-panel/e2e/hairline-verify.ts
```

The hairline is unaffected by the inset change — `cp-band::before` cancels
`--cp-panel-pad + --cp-inset-start`, which shrinks by exactly what the panel's padding
shrinks, so the rule still reaches the panel's border box. The e2e script proves it rather
than assuming it.

Finally, screenshot the migrated pickers and the quick-theme panel and compare against the
panels they replace. The number to look for is the panel's own padding: **12px left and 12px
right**, with the section label, the search field and the grid all starting at the same x.

**Correction (2026-08-19, from the migration).** 12/12 is the verdict for a panel with NO drag
handle, which is most of them. A panel whose rows *do* hang a handle correctly pads **36/12**:
the inset is the icon rail, and the icon rail sits after the gutter. The DataView settings
panel measures 36/12 and that is right, not a regression. The invariant is "loose content
starts where a row's icon does", not "12px" — read a bare number here as a symptom of the
handle-less case, never as the rule.

## Landing notes (2026-08-20)

The work was written against the panel's old private geometry and rebased onto
main's repo-wide **rail contract** (`primitives/css/rail`), which shipped
independently while this was in flight. What changed on the way in:

- **The mechanism is main's, not this doc's.** There is no `--cp-inset-start` /
  `--cp-inset-end`. `cp-panel` publishes the shared `--rail-start` /
  `--rail-end` pair, and the change here is one term:
  `calc(panel-pad + rail-text)` → `calc(panel-pad + rail-icon)`. `cp-row` /
  `cp-rule` keep main's `min()`-clamped bleed (which is what lets a row be
  dropped outside a panel), not the negative-margin pair described in §1.
- **`--cp-rail-text` and `@utility cp-rail-icon` are both deleted**, as §1 said.
- **The derived leading tracks (§2) landed verbatim**, nested inside the
  `@utility` blocks, with the marker on the row (`data-cp-handle` /
  `data-cp-icon`) rather than on the rendered node.
- **What main's own comment argued, and we knowingly gave up.** On the text rail
  the panel's content box was exactly a row's content BAND — aligned on both
  sides. That was right, and it answered a different question. We take the
  left-edge symmetry (the heading IS the edge) and keep the end rail unchanged.
- **Not recovered:** the sticky-`ControlPanel.Footer` CSS and the
  `OverlayPanel` scroll-fade / footer-band rework this branch also carried.
  Main reworked the same code (measured `--rail-block-*` bands), and mixing the
  two was out of scope for the rebase. `data-cp-footer` remains a marker with no
  CSS behind it — the same state main is in. Bug #3 in the list above is
  therefore still open.
