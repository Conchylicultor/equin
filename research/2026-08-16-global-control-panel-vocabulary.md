# Control-panel vocabulary + DataView control registry

## Context

Opening any DataView control (Filter, Sort, the settings gear) reads as unpolished. The
cause is not styling — it is that there is no shared vocabulary for "a data-control
panel". Each panel body is assembled by hand from `Stack` + `DropdownMenuSeparator` +
`SectionLabel` + `Button` + `Row`, so alignment, row height, separator placement,
selection indicator, footer shape and panel width are each an author's choice at each
call site.

Measured on the deployed app (Tasks list, `/agents`):

- **Three panels, three widths, each set by the wrong thing.** Filter 481px, sort 384px,
  settings 256px. The filter panel is that wide because its *footer* is the widest row —
  the rule itself ends at 360px, leaving ~120px of dead space. Adding a rule resizes the
  panel.
- **Nothing lines up.** Inside the filter panel, successive left edges sit at 12 / 14 /
  20 / 38px.
- **Three "on" languages stacked vertically** in the 256px settings panel: a filled blue
  checkbox (Properties), a full-width highlighted row with a leading ✓ (Group by), and a
  raw select + text input + button (Fields).
- **The closed state says nothing.** `FilterBuilderTrigger` knows it has 1 rule, but only
  in its `aria-label`; on screen it is the same glyph with a `secondary` instead of
  `ghost` variant.

A repo-wide survey found ~19 further popovers hand-rolling the same shape (avatar-picker,
page-icon-button, callout-appearance, change-cover-popover, quick-theme-panel,
date-filter, category-chip, view-settings-popover, custom-columns Fields,
dep-popover-content…), several with hand-rolled `h-px bg-border` hairlines and
near-duplicate "divider + single footer Row" tails whose own comments cross-reference each
other.

There is also a structural leak: `DataViewToolbar` takes three named props —
`sortControl`, `filterControl`, `fieldsControl` — which violates the collection-consumer
rule (a consumer must never name individual contributors) and means no plugin can add a
toolbar control.

**Intended outcome.** A closed, enforced vocabulary that makes the five invariants true by
construction rather than by discipline, plus a control registry so the toolbar names no
control and every control gets a visible active summary for free.

**Design reference:** `prototypes/control-panel-vocabulary/` — a working, interactive
prototype (opens by double-click; also in the Prototypes app). It rebuilds all three
panels on the proposed API and has a rail-overlay toggle.

## The five invariants

1. One rail — every label in every panel starts at the same x.
2. One row height, in every panel, always.
3. One selection language per meaning (check / radio / switch).
4. Footers are rows, never corner-pinned ghost buttons.
5. Width is a role, not a measurement — a panel never resizes as content changes.

## Approved decisions

| Decision | Choice |
|---|---|
| Scope | Primitive **and** control registry (not a repo-wide migration of the other ~19 panels) |
| Section label alignment | **Icon rail** — one column left of the row label |
| Selected single-select row | **Checkmark only, no background fill** (a filled row already means hover) |
| Enforcement | **Ship the lint rule in this pass** |

---

# Part 1 — the primitive

## Location

Two new plugins under the **`css` umbrella**, which is de facto the design-system umbrella
(it already holds `badge`, `card`, `color-picker`, `radio-group`, `toggle-chip`,
`selection-indicator`, `ui-kit`).

```
plugins/primitives/plugins/css/plugins/switch/
  web/index.ts                          ← the only barrel
  web/internal/switch.tsx

plugins/primitives/plugins/css/plugins/control-panel/
  web/index.ts                          ← the only barrel
  web/internal/control-panel.tsx        ControlPanel + Section + Footer + Empty
  web/internal/control-panel-row.tsx    ControlPanel.Row
  web/internal/rule-row.tsx             RuleList + RuleRow
  web/internal/field-control.tsx        ControlPanel.Field
  web/internal/control-panel-popover.tsx ControlPanelPopover
  web/internal/panel-stack.tsx          ControlPanel.Stack + usePanelStack
  web/__tests__/control-panel.test.tsx
  fixtures/index.ts                     default-export LayoutFixture[]
  lint/index.ts + lint/no-adhoc-panel-body.ts
```

Two verified facts drove this:

- `plugins/primitives/plugins/css/plugins/**/*.{ts,tsx}` is **already** a permanent glob in
  `layout/no-adhoc-layout`'s ignore list
  (`plugins/primitives/plugins/css/lint/index.ts`). The primitive inherits the raw-layout
  exemption with zero lint edits.
- `plugins/primitives/plugins/css/plugins/color-picker/` already owns a popover surface
  (`color-picker-popover.tsx`, built on ui-kit's `Popover`/`PopoverContent`/`PopoverTrigger`).
  A `css` sub-plugin owning a floating surface is in-grain, not a new idea.

**Dependencies are confined to the `css` umbrella**: `ui-kit`, `text`,
`selection-indicator`, `switch`. Build `ControlPanelPopover` on ui-kit's `Popover*`
directly (as `color-picker` does) rather than on `primitives/popover`'s `InlinePopover` —
that avoids a cross-umbrella edge entirely. Drop the `tooltip` prop; the caller's trigger
(typically `IconButton`) already owns its tooltip. `RuleRow`'s remove uses
`Button aspect="icon" aria-label` rather than `primitives/icon-button`.

**`control-panel` is ONE plugin, not an umbrella.** The API is a compound namespace
(`ControlPanel.Section` / `.Row` / `.RuleRow` / `.Footer` / `.Empty` / `.Field` /
`.Stack`). Attaching members from sibling plugins onto one exported object is a
cross-plugin re-export in all but syntax, which the boundary checker rejects transitively.
The namespace is what tells an author at the point of typing that there is a closed set
and no sixth thing. `switch` **is** its own plugin — genuinely reusable outside panels,
with no namespace tie.

## Public API

`ControlPanelSize = "menu" | "builder"` — the only width dial.

```ts
<ControlPanel size?>                      // paints NO surface; owns padding, rails,
                                          // and the hairline BETWEEN its direct children
  <ControlPanel.Section label?>           // author never places a divider
  <ControlPanel.Row
      icon? | (select + checked)          // discriminated union — see below
      handle? handleProps? trailing?
      tone?="default"|"danger" muted? disabled?
      onSelect? href? />
  <ControlPanel.RuleList>
    <ControlPanel.RuleRow
        prefix field operator? value?
        actions? onRemove? removeLabel?
        handle? handleProps? ref? style? className? />
  <ControlPanel.Field icon? label placeholder? disabled? onClick? />
  <ControlPanel.Footer>
  <ControlPanel.Empty>
  <ControlPanel.Stack root onExhausted>   // panel navigation, see below
```

Three API decisions worth keeping:

- **`RowProps` is a discriminated union**: `{ select: "check"|"radio"|"switch"; checked: boolean }`
  and `{ icon?: ReactNode }` are mutually exclusive, and `checked` is required once
  `select` is set. That is what makes the settings panel's three stacked "on" languages a
  type error rather than a review note.
- **`RuleRow` has no `children`** — named slots only. A slot-less escape hatch is how one
  shared grid degrades into six bespoke ones. `actions` (rendered before the built-in ✕)
  exists for the filter's "Turn into group"; `handleProps` + `ref`/`style`/`className`
  forwarding exist because both the sort rule list and the Properties list are dnd-kit
  sortables. Both are required, not optional niceties.
- **`ControlPanel.Row`'s host element is inferred, never authored** — `href`→`a`,
  `onSelect`/`disabled`→`button`, else `div`. Same rule as `css/row`'s `Row`, so authors
  learn it once.

### `ControlPanel.Row` is its own grid, not a composed `Row`

`css/row`'s `Row` is a `<Line>`-based **flex** row with `p-row` baked in. Its `icon` is a
leading flex child, so the label's x depends on whether an icon is present — that *is* the
12/14/20/38px bug, and flex has no track that occupies width when empty. Its trailing slot
(`actions`) is hover-revealed and overlay-pinned; the panel's trailing cell is in-flow and
presentational. Adding a grid mode plus a panel-only geometry axis to a primitive with 50+
call sites is worse than 8 lines of duplicated element inference.

What we deliberately do **not** re-implement: `rowActionsAnchor` / `RowActions` and the
split interactive/actions DOM path. A panel row's trailing cell is non-interactive by
contract, and the two interactive cases (`select="switch"`, the RuleRow remove) are the
row's own click target or live in a non-interactive `div` row — so nested-interactive DOM
stays unrepresentable without that machinery.

Drift risk is mitigated by sharing *tokens* (`--pad-row-x`, `--control-height-md`, the
same `hover="muted"` recipe) rather than code, plus the layout-harness fixtures below,
which pin the rail numerically.

## Geometry: `--cp-*` custom properties + `@utility` in `app.css`

Verified constraint: `spacing/no-adhoc-spacing`'s allowlist is **drained and explicitly
closed** ("do NOT add entries back"), and its regexes only bite on numeric/arbitrary
values — **word-valued utilities like `p-row`, `px-chrome`, `cp-row` are legal
everywhere**. So geometry goes in `app.css` (the project's only stylesheet, already the
declared home for `p-row` and `px-pane-gutter`), not inline styles and not a JS constants
module, and the `/* twmerge: … */` markers register each class with `cn()`'s conflict map.

Tokens bind to the density ramp wherever the meaning matches, so panels tighten with the
Compact preset instead of freezing at one screenshot:

```
--cp-panel-pad  : var(--space-xs)            --cp-row-h      : var(--control-height-md)
--cp-row-pad-x  : var(--pad-row-x)           --cp-rule-h     : var(--control-height-lg)
--cp-gutter     : var(--space-lg)            --cp-prefix-col : 4.625rem
--cp-icon-col   : 1.125rem                   --cp-remove-col : 1.5rem
--cp-icon-gap   : var(--space-sm)
--cp-rail-icon  : calc(row-pad-x + gutter)
--cp-rail-text  : calc(rail-icon + icon-col + icon-gap)
```

Binding row height to `--control-height-md` is a deliberate improvement on the prototype:
a panel row then lines up with every Button, Input and ToggleChip in the app, so the rail
invariant extends past the panel's own edge. `--cp-icon-col` and `--cp-prefix-col` are the
two genuinely new declared tokens — they are *column widths*, which the spacing ramp does
not model.

Utilities: `cp-panel` (padding), `cp-body` (the `& > * + *` full-bleed hairline that gives
sections their rhythm and makes a conditional null section leave no orphan rule), `cp-row`
(4 grid tracks: gutter | indicator | label | trailing), `cp-rule` (6 tracks: gutter |
prefix | field | operator | value | remove, with `[data-span="field"]` collapsing the
operator track for the sort builder), `cp-rail-icon`, `cp-rail-text`.

**Exemptions requested: none beyond the layout glob already in place.** The primitive must
stay clean against `no-adhoc-spacing`, `no-adhoc-radius`, `no-adhoc-typography`,
`no-adhoc-control`, `no-adhoc-surface` (it paints no surface), `row/no-adhoc-row` and
`no-adhoc-zindex`. The only lint-file edit in the whole plan is the new rule's own
`lint/index.ts`.

## Width roles

Add two roles to the closed ramp in
`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/popover-width.ts`:

```
menu:    "w-[16.375rem] max-w-(--available-width)"   // 262px — a list of choices
builder: "w-[32.75rem]  max-w-(--available-width)"   // 524px — a six-track rule row
```

New roles rather than mapping onto `md` (256) / `3xl` (480): reusing them re-imports the
thing being deleted — a measurement chosen because it was nearby. The ramp already carries
role names (`fit`, `snug`, `anchor`, `anchor-min`) beside its t-shirt sizes.

## The primitive owns the surface

`ControlPanel` paints nothing — no background, border, shadow, radius, scroll, clamp or
width. The surface is always `OverlayPanel`'s, contributed by whatever contains the body.

`ControlPanelPopover` is the sanctioned entry point and has **no `width`, no `padding`, no
`contentClassName`** — exactly the props that let 481 / 384 / 256px happen. It sets
`padding="none"`, maps `size` to a width role, and wraps children in `<ControlPanel>`.
That is what makes "width is a role" enforceable rather than aspirational: the prop is not
defaulted, it is absent from the type.

Consequences: no double elevation (so `no-adhoc-surface` needs no exemption); a panel
inside a panel is really a popover opened from inside a popover, each with its own
correctly-clamped `OverlayPanel`; and `<ControlPanel>` bare inside a `DialogContent` still
works, inheriting the dialog's width.

This does **not** migrate the other ~19 consumers. It makes migration a three-line
mechanical edit, and the lint rule's burndown list is the ledger. `InlinePopover` stays as
it is — it remains right for a popover whose content is not a control panel (date picker,
color picker, icon grid).

## Panel navigation lives in the primitive

`ControlPanel.Stack` + `usePanelStack()` — a stack of `{ key, title, render }` entries; at
depth > 0 the panel prepends a back header built from the vocabulary itself
(`<Section><Row icon={MdArrowBack} onSelect={pop}>{title}</Row></Section>`). `Escape` pops
one level and stops propagation; at depth 0 it falls through and closes the popover. On
push, focus moves to the new panel's first focusable.

It belongs in the primitive, not in data-view, because **three independent consumers need
it**: the compact toolbar fold, the filter builder's nested groups, and custom-columns'
per-field editor — and the third is a nested contribution that must reach the stack
through context from whichever chrome hosts the panel.

## The switch primitive

No switch/toggle component exists anywhere in the repo (verified: not in the 13 shadcn
primitives, and `theme-toggle` is an `IconButton`). Two exports:

- `SwitchIndicator({ checked, disabled?, className? })` — track + knob, a `<span>`, no
  handler, no role. Used **inside** something that is already the click target, so a
  switch can never nest a `<button>` in a `<button>`.
- `Switch({ checked, onCheckedChange, ... })` — `<button role="switch" aria-checked>`
  wrapping the indicator, for use outside a panel row.

One fixed size (28×16 track, 12 knob), matching `selection-indicator`'s single `size-3`.

## The lint rule

**`control-panel/no-adhoc-panel-body`** — a JSX-structure rule modelled on ui-kit's
`no-groupless-dropdown-menu-label` (a `JSXOpeningElement` visitor walking the parent chain,
stopping at function boundaries). It does **not** carry the shared `class-token-walk`
block and stays outside `class-token-walk-in-sync`'s scope.

Three signals:

- **`separatorOutsideMenu`** — a `DropdownMenuSeparator` in a file with no
  `DropdownMenu*Content` at all, or with no such ancestor in its own function. Measured
  today: exactly 4 files, all of them the panels this work replaces.
- **`separatorInPanel`** — a `<Separator>` with a `PopoverContent` / `InlinePopover` /
  `OverlayPanel` / `FloatingSurface` ancestor in the same function. Catches the "switch to
  `<Separator/>` to dodge the first signal" move.
- **`handRolledHairline`** — a className containing both `h-px` and a `^bg-border` token.

Escape hatch per-site: `// eslint-disable-next-line control-panel/no-adhoc-panel-body -- <reason>`.

`lint/index.ts` carries a permanent tier (ui-kit's own `components/ui/**`, this plugin,
`page/divider`) and a **burndown tier** naming the four data-view panels, the five popover
bodies with hand-rolled hairlines (avatar-picker, page-icon-button, callout-appearance,
block-actions-menu, category-chip) and three labelled-rule false positives that should be
`<Separator/>` anyway (theme-customizer, summary-row, commits-graph).

**Honest about coverage:** a body component built from `Stack` + `SectionLabel` + `Button`
with no divider and no hairline is invisible to this rule. It closes the *drift* signals —
borrowed dividers and hand-rolled hairlines, which is empirically how every one of these
panels sections itself — not the whole class. The burndown list is the rest of the forcing
function, and it only shrinks. **Run the rule with an empty allowlist first** and let the
real failure list become the burndown tier; the measured list above was taken at this
commit.

---

# Part 2 — the DataView side

## The control registry

New in `plugins/primitives/plugins/data-view/web/slots.ts`, beside `Setting`:

```ts
Control: defineSlot<DataViewControlContribution>("primitives.data-view.control", {
  docLabel: (p) => p.label,
})
```

```ts
interface DataViewControlSummary {
  label: string;          // "Status is none of 2"
  spoken?: string;        // for glyph labels: "Updated, descending"
  more?: number;          // rendered as "+N"
  count?: number;         // compact fold's aggregate badge; default 1 + (more ?? 0)
}

interface DataViewControlContribution {
  id: string;
  label: string;                     // tooltip, compact row label, sub-panel back title
  icon: ComponentType<{ className?: string }>;
  order?: number;
  isApplicable?: (ctx: DataViewControlsContextValue) => boolean;
  summary?: (ctx: DataViewControlsContextValue) => DataViewControlSummary | null;
  component: ComponentType;          // prop-less; reads useDataViewControls()
}
```

**One `summary` returning an object, not separate `summary` + `count` functions.** Two
independent functions over the same state can disagree — precisely the bug
`rule-resolution.ts` exists to close (the chip showing 0 rules while a value-less `bool`
rule silently filtered). One function, one object, disagreement unrepresentable.

**`summary` is a pure function, not a hook**, so the trigger renders without mounting the
panel. Mounting N panels to compute N summaries would make every DataView subscribe to
every control's data on first paint.

**`defineSlot` + `renderIsolated`, not `defineRenderSlot`** — the exact precedent of
`View` and `Setting`. The host filters by `isApplicable`, builds each trigger itself from
readable metadata, and mounts exactly one panel. A render slot would mount every panel on
every DataView on every page (each running `useFilterPresets`, the live custom-values
resource, …), and would be unconditionally reorderable, owing an authored
`config/…/primitives.data-view.control.jsonc` with a `// @review` marker that blocks the
build — for a fixed reading order that `order?: number` already expresses.

## One merged context

`web/components/settings/settings-context.tsx` → `web/components/controls/controls-context.tsx`.
`DataViewSettingsContextValue`/`useDataViewSettings` are **renamed** to
`DataViewControlsContextValue`/`useDataViewControls` and the old names deleted (exactly one
cross-plugin consumer: `custom-columns/web/components/custom-columns-setting.tsx`, fixed
in the same commit).

Today's five fields (`storageKey`, `fields`, `activeViewId`, `activeState`, `viewModel`,
`activeSupportsGroupBy`) plus five that are **already computed in `DataViewBodyInner`** and
merely re-homed: `activeSupportsSort`, `activeSupportsManualOrder`, `manualOrderOverridden`,
`filter: FilterController<unknown>`, `sort: SortController<unknown>`.

Provided around **the toolbar only**, inside the `CollectRowOrder` children callback (where
`manualOrderOverridden` is computed). Not around the view body — view children have a
deliberate contract (`DataViewRenderProps`), and an ambient back-door to `viewModel` would
be a second undocumented seam. Popovers portal out of the DOM but stay React children, so
context reaches every panel.

`useFilterPresets` / `useSortPresets` move **out** of `data-view-body.tsx` and into the
panels — a panel is a mounted component and can hook freely, and presets are only read
when a panel is open.

## The three controls

Registered in `plugins/primitives/plugins/data-view/web/index.ts`:

| id | order | `isApplicable` | summary | component |
|---|---|---|---|---|
| `data-view.filter` | 0 | `ctx.filter.filterableFields.length > 0` | `summarizeFilter` | `FilterControlPanel` |
| `data-view.sort` | 1 | `ctx.activeSupportsSort && ctx.sort.sortableFields.length > 0` | `summarizeSort` | `SortControlPanel` |
| `data-view.settings` | 2 | — | — | `SettingsControlPanel` |

Each predicate is a literal transcription of today's `hasFilters` / `hasSort`.

`DataViewSlots.Setting` survives unchanged; settings stays a menu of `Setting`
contributions nested inside one control. Two levels is correct: a *control* is a toolbar
affordance, a *setting* is a section inside one panel. Flattening would put Properties /
Group by / Fields in competition for the toolbar's single line.

**Filter and sort are NOT extracted into sub-plugins in this pass.** Both pull heavily on
`web/internal/` (`use-filter-controller`, `filter-tree-ops`, `rule-resolution`,
`filter-slot`, `sort-presets`, `use-direction-labels`) and the evaluator is shared with
`useFlatRows`; extraction would force a large slice of `internal/` out through the parent
barrel for zero user-visible gain. The registry's value is that a *third-party* plugin can
now add a control — custom-columns already proves the child→parent contribution edge.
File a follow-up task.

## Trigger rendering

> **Amended after review — the active chip below was built and then reverted.** The
> trigger is **icon-only at every width**: `<IconButton variant={active ? "secondary" :
> "ghost"} />`, no summary text and no `+N` on the button. Two pills consumed the whole
> toolbar of the agent-manager sidebar, and a width-dependent trigger (chip when wide,
> glyph when narrow) was rejected outright — one presentation everywhere. `summary` stays
> exactly as specified below and is spent as TEXT: the trigger's tooltip + accessible
> name, and the compact fold's row `trailing`.

One component, `web/components/toolbar/control-trigger.tsx`, no branching on identity.

- **At rest**: `<IconButton icon={c.icon} label={c.label} variant="ghost" />` — unchanged,
  and the accessible name stays the bare word.
- **Active** (as built, now reverted): `<Button variant="secondary">` with the icon, the
  summary label as a truncating leaf (`max-w-40 truncate`), and a muted `+N`. The
  `aria-label` / tooltip wording survives the revert:
  ``${c.label}: ${s.spoken ?? s.label}${s.more ? `, +${s.more} more` : ""}``.

`summarizeFilter` (`web/internal/summarize-filter.ts`) flattens the tree depth-first,
keeps rules passing the existing `isRuleActive`, describes the first as
`"<Field> <operator lowercased> <value>"` and counts the rest as `more`. Value formatting
tries a **new optional `FilterOperator.summarize(operand, field)`** (core `types.ts`,
beside the existing `isComplete`, since the operand shape is operator-owned) then falls
back generically: string→itself, number/boolean→`String`, `string[]`→the single option's
label or the count, anything else→omitted. No operator implements it in this pass.

`summarizeSort` filters dangling rules exactly as `SortController.ruleCount` does and
renders `"<Field> ↑|↓"` with a `spoken` word.

On `/agents` this yields **`Status is none of 2` `+1`** and **`Updated ↓` `+1`**.

Both get unit tests next to the source (`*.test.ts`, pure-logic runner).

Settings carries no summary — view settings are configuration, not a narrowing of what you
see, and a "Group by: Status" chip would compete for the one line the toolbar has.

## The compact fold becomes a panel stack

`compact-controls.tsx` keeps its `MdTune` trigger and aggregate badge (now derived
generically as `Σ summary(ctx)?.count` over applicable controls, plus 1 for a non-empty
query — the same arithmetic as today's `activeControlCount`). Its content becomes one
`ControlPanel.Stack` whose root panel is the search input plus one `ControlPanel.Row` per
control, each showing that control's summary chip as its `trailing` and pushing the
control's own panel on select.

**No nested popovers anywhere.** Today the fold nests each control's popover trigger
inside another popover as `[label] [icon-button]` rows.

Wide and compact share one code path: `web/components/toolbar/control-panel-host.tsx`
exports a single `DataViewControlPanel({ control })` that calls `renderIsolated`. The wide
layout renders it inside a `ControlPanelPopover`; the compact fold renders it as a stack
entry. Because the panel component is prop-less and reads `useDataViewControls()`, the two
call sites are byte-identical — there is nothing left to diverge.

## Panel-by-panel migration

**Filter** — both `DropdownMenuSeparator`s deleted (the container draws hairlines).
`ConjunctionCell` loses its `w-16` rail and `Center`/`control-sm` chrome (the `prefix`
track owns that column, which is what aligns the filter and sort builders with each
other); its three-state logic is unchanged. `FilterRuleRow` dissolves into a `RuleRow`
(`field`/`operator`/`value` slots; its hand-rolled `min-w-0 flex-1` value wrapper deleted;
`useHoverReveal` gone). "Turn into group" moves to `RuleRow`'s `actions`. The search-first
`FieldSearchList` empty state stays. `SavePresetAffordance`'s popover-in-popover becomes a
pushed panel.

**Nested filter groups become a pushed sub-panel** — a child group collapses to one
`RuleRow` reading `Group · 3 conditions`, whose click pushes that group's own
`RuleList`. `FilterGroupPanel({ groupId })` recurses exactly as the data does. This keeps
the rail invariant at every depth and fixes a real bug: a deeply nested group today grows
the popover horizontally past the pane. It is the one place the migration changes *what
the user sees*, not just how it is drawn — screenshot before/after on a surface with a
nested group.

**Sort** — the `manualOrderOverridden` copy survives verbatim as a `ControlPanel.Empty` in
its own section. `RuleRow handle` + `handleProps` keeps dnd-kit drag-to-reprioritise.

**Settings** — the gear, the `InlinePopover` and the inter-scope `DropdownMenuSeparator`
all go. `GroupByControl` becomes `<Section label="Group by">` + `Row select="radio"`,
deleting the `MdCheck className={selected ? undefined : "invisible"}` hack.
`PropertiesControl` becomes `Row handle select="check"`, still inside
`SortableList`/`SortableItem`; "Show all fields" becomes the section's last `Row` (not the
panel `Footer` — a contribution owns a section, not the panel). **Each `Setting`
contribution now renders its own `ControlPanel.Section`** — a contract change on a
documented slot, to be recorded in `data-view/CLAUDE.md`.

**`view-core/web/components/view-settings-popover.tsx`** — Name section + options sub-form
+ a `Footer` of Duplicate / Delete rows, deleting the outline-button-beside-destructive-
ghost pair. view-core imports only the `control-panel` primitive (a sibling); it must
never import data-view.

**custom-columns Fields** — the biggest visual win. The `[Select][Input][Button]` cram
becomes a `Section label="Fields"` of rows plus a `New field` row; edit and add each push a
sub-panel (rename + read-only type + the per-type `ColumnConfig` editor + a `Delete column`
danger footer row). This is why `usePanelStack` must publish through context — it is
reached from inside a nested contribution.

## Blast radius

Consumer-visible breaks, all inside this repo:

1. `useDataViewSettings` / `DataViewSettingsContextValue` renamed — one cross-plugin
   consumer, fixed in the same commit.
2. Filter/sort trigger accessible names change (`"1 rule"` → `"Filter: Status is none of 2, +1 more"`).
   `plugins/apps/plugins/events/plugins/sources/e2e/sources-verify.ts` matches
   `/^(Filter|\d+ rules?)$/` — update to `/^Filter(:.*)?$/`. Its compact-fold fallback path
   also now finds a navigation row rather than a popover trigger.
3. `DataViewSlots.Setting` contributors must render a `ControlPanel.Section`.

`DataViewToolbarProps` is plugin-internal (constructed only in `data-view-body.tsx`), so
dropping the three control props breaks nothing outside.

Docs: `data-view/CLAUDE.md` gains a "Toolbar controls" section (sibling to "Per-item
actions" / "Field extensions") covering the `Control` slot, why it is `defineSlot`, the
merged context, the pure-summary contract, the panel-stack model, and `ControlPanel` as
the required panel shape for both `Control` and `Setting` contributions — plus a note that
the slot owes **no** `config/…jsonc` override. `view-core/CLAUDE.md` and
`custom-columns/CLAUDE.md` need a line each. `plugins-doc-in-sync` guards all of it.

---

# Build order

Each step compiles and deploys green. Run `./equin build` with
`run_in_background: true` and end the turn (median ~10 min, over the foreground cap).

**Primitive**

1. `switch` — leaf, unblocks everything.
2. Geometry + width roles: the `--cp-*` block and `cp-*` `@utility` block in `app.css`
   (each with its twmerge marker), plus `menu`/`builder` in `popover-width.ts`. **Gate:**
   must land before any TSX consumes a `cp-*` class, or `cn()` won't know the conflict
   groups. Then `./equin check app-css-utilities-in-sync`.
3. The panel body (`ControlPanel`, Section, Row, RuleList, RuleRow, Field, Footer, Empty).
4. The surface (`ControlPanelPopover`) and `ControlPanel.Stack`.
5. Tests (`web/__tests__/control-panel.test.tsx`): element inference; `select="radio"`
   renders a checkmark with **no background fill**; `select="switch"` occupies the trailing
   cell and ignores `trailing`; the hairline is on the container, not on Section; `RuleRow`
   without `operator` sets `data-span="field"`.
6. Layout-harness fixtures — `fixtures/index.ts` default-exporting `LayoutFixture[]`,
   `widths: [262, 524]`, `data-geo` on the boxes. Four fixtures:
   `rail-alignment` (`leftPack`: the section label's left edge equals the row icon cell's,
   across a mixed row set — invariant #1, measured), `row-height` (`rigidIntegrity`),
   `rule-grid` (`noOverlap` + `neverTruncatesWhenRoomy` + `pinnedRight` on remove +
   `rigidIntegrity` on the prefix column), `long-label` (`truncationOnsetOrder`, with a
   `falsification` case mutating to the flex + `pr-2xl` + `absolute right-2` construct and
   asserting `noOverlap` is VIOLATED — proof the gate has teeth). `./equin check layout-geometry`.
7. The lint rule — **empty allowlist first**, read the real failures, then write the
   burndown tier.
8. `CLAUDE.md` for both plugins.

**DataView**

9. Context + slot, **zero visual change**: move and widen the context, provide it around
   the toolbar, add `DataViewSlots.Control`, rename the hook, fix custom-columns. Keep the
   three toolbar props. Screenshot must be identical. This is the safe base.
10. The registry: register the three controls, toolbar renders from the slot, delete both
    `*BuilderTrigger` files and the three props.
11. Summaries: tests first, then the derivations and the active chip. `/agents` visibly
    changes here.
12. Panel stack + compact fold.
13. Panel migrations, easiest first so the vocabulary's rough edges surface cheaply:
    settings → sort → filter (nested groups last, they need step 12) →
    `view-settings-popover` → custom-columns Fields.

# Verification

```bash
./equin check                       # boundaries, type-check, eslint, docs, geometry
./equin test plugins/primitives/plugins/css/plugins/control-panel
./equin test plugins/primitives/plugins/data-view
```

Visual, against the deployed worktree:

```bash
# fixture gallery — rails, heights, rule grid at both widths
bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
  --url http://<worktree>.localhost:9000 --click "Layout Lab" --out /tmp/cp-lab

# wide: /agents carries an authored filter AND sort, so the chips paint on first load
bun …/screenshot.ts --url http://<worktree>.localhost:9000/agents \
  --viewport 1400x900 --out /tmp/dv-wide
bun …/screenshot.ts --url …/agents --click "Filter: Status is none of 2, +1 more" --out /tmp/dv-filter
bun …/screenshot.ts --url …/agents --click "Sort" --out /tmp/dv-sort

# compact: the agent-manager sidebar folds below 360px
bun …/screenshot.ts --url …/agents --viewport 900x900 --click "View options" --out /tmp/dv-compact
```

Check on each `-after.png`: the panel width did not change when a rule was added; every
label starts at one x; the selected single-select row shows a checkmark and no fill;
footer actions are full-width rows. Also sweep a `table` view with many columns
(Properties list) and the Pages sidebar tree (narrow, grouped, manual-order active — the
one place the `manualOrderOverridden` line shows).

Then re-run the one script that asserts on the filter trigger, after fixing its matcher:
`bun plugins/apps/plugins/events/plugins/sources/e2e/sources-verify.ts`.

# Open items

- **The settings control loses its self-hide.** `DataViewSettingsMenu` today returns null
  when no `Setting` is applicable; a `Control`'s `isApplicable` is pure and cannot read
  another slot. Recommendation: settings is always applicable and the empty case renders
  `ControlPanel.Empty`. In practice nothing changes — custom-columns' "Fields" setting has
  no `isApplicable`, so the gear is already always visible. This is the one capability the
  migration trades away.
- **`--cp-panel-pad: var(--space-xs)` (4px) vs the prototype's 6px** (not on the ramp).
  Ship `--space-xs`, look at the screenshot, and declare a named `0.375rem` token if it
  reads cramped.
- **Verify Tailwind v4 supports `& > * + *` nesting inside `@utility`** with a throwaway
  class in step 2. `scroll-fade` already uses `&::before` / `&[data-fade-top]::before`, so
  nesting works; if the child combinator does not, move the rule into `@layer components`
  in the same file — same edit locality, no API change.
- **Row roles**: plain `role="checkbox"/"radio"/"switch"` on the row button rather than
  `menuitemcheckbox`/`menuitemradio` (which need a `role="menu"` ancestor the panel does
  not have), with `role="group"` + `aria-label` on `ControlPanel`.
- **Follow-up tasks** (not this pass): a `control-panel:burndown` check that fails when the
  lint allowlist grows; extracting filter/sort into `data-view/plugins/`; migrating the
  ~19 other hand-rolled panels; adopting `FilterOperator.summarize` in `fields/date/filter`.
