# Control-panel vocabulary v3 — config_v2 renders through the vocabulary

Third in the lineage after [`2026-08-16-global-control-panel-vocabulary.md`](./2026-08-16-global-control-panel-vocabulary.md)
and [`2026-08-19-global-control-panel-vocabulary-v2.md`](./2026-08-19-global-control-panel-vocabulary-v2.md).
Those two built the vocabulary and moved every hand-rolled *popover* onto it — the
`no-adhoc-panel-body` burndown tier drained on 2026-08-19 and is empty. This one closes the
gap those two left open: **the automated field renderer.**

## Context

There are two APIs for an option today, and they do not agree.

`ControlPanel` is the vocabulary — one rail, one row height, one selection language per
meaning, footers are rows, width is a role. `config_v2`'s `FieldRenderer` is the other: a
dispatch on `field.type.id` where each of 18 field types returns **arbitrary JSX and draws
its own label, its own padding, its own layout and its own control**.

The two are not sitting politely side by side. They are already nested, and the inner one
breaks the outer one:

`plugins/apps/plugins/sonata/plugins/view-options/web/components/view-options-toggle.tsx`
is a real `ControlPanelPopover size="menu"` (262px) whose contents are `FieldRenderer`.
What lands inside that panel:

- `bool-renderer.tsx` — a raw `<input type="checkbox" className="mt-1 h-4 w-4">`, carrying
  its own `spacing/no-adhoc-spacing` disable for the offset
- `enum-renderer.tsx` — a `RadioGroup` of native UA-drawn radios, chosen by an
  `options.length <= 3` heuristic living inside the renderer
- both wrapped in `className="py-md"`, so neither is `--cp-row-h`

Its sibling in the same HUD, `piano-roll/web/components/fx-toggle.tsx`, uses real
`ControlPanel.Row select="switch"`. So one screen shows **three different ways of saying
"on"** — a UA checkbox, a UA radio, and a `SwitchIndicator` — which is precisely the defect
invariant #3 exists to delete. The discriminated `ControlPanelRowProps` union cannot see it,
because the offenders are loose content inside a `Section`, not `Row`s.

The same seam is mounted in two more places: the config settings detail pane
(`config_v2/plugins/settings`) and the events source settings form. Every one of them gets
whatever the renderer felt like drawing.

**Outcome.** A field renderer returns *what goes in the box, never the box*. The label, the
rail, the row height, the padding and the selection indicator are supplied by the
vocabulary. Drawing them from a renderer becomes unspellable, not discouraged.

## Decisions taken

| Question | Decision |
| --- | --- |
| One vocabulary, or two sharing tokens? | **One.** `ControlPanel` grows the members a settings form needs; a renderer declares a shape from a closed union. |
| Where does a field description live? | **`Section` `description` + `Row` `hint`** — the studies' recommended option 6. No two-line rows; invariant #2 never bends. |
| `ControlPanel.Grid`? | **Stays rejected**, per v2. Callers keep typing their own grid; loose content already lands on the rail by doing nothing. |
| Migration scope | **The renderer and its three hosts** — 18 field renderers, the settings detail pane, sonata view-options, events source settings. The hand-rolled panes (theme customizer, sonata rich controls) are a later burndown. |

---

# Part 1 — the primitive

`plugins/primitives/plugins/css/plugins/control-panel/`

Three new members and two new props. All inside the one plugin — a compound namespace split
across plugins is a cross-plugin re-export in all but syntax.

## 1.1 `Section` gains `description`, `Row` gains `hint`

```ts
export interface ControlPanelSectionProps {
  label?: React.ReactNode;
  /**
   * A muted line under the eyebrow, INSIDE the band. It is prose about the band,
   * not a row — so it reserves no track and takes no row height, and invariant
   * #2 never sees it.
   */
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}
```

`hint` goes on `ControlPanelRowCommon`, so it reaches all three `select` arms, and on every
new member below:

```ts
  /**
   * Explanatory prose as a TOOLTIP, wired by `aria-describedby` — never a second
   * line. A second line is the one change that breaks invariant #2 in every panel
   * at once; a muted pseudo-row breaks invariant #1's meaning (a row that is not
   * a control still opens the rails).
   */
  hint?: string;
```

Composes `WithTooltip` from `primitives/tooltip/web`. No new cycle: `control-panel` already
imports `primitives/icon-button`, which sits above tooltip. The tooltip node renders inside
the row's **label** cell as a zero-box sibling, so it opens no track.

## 1.2 `ControlPanel.Setting` — the value row

The vocabulary has no way to say "Label ………… [ control ]", and config is full of them.

**It is a new member, not a fourth `select` arm and not a promoted `Field`.**

- Not a `select` arm: `select` is the *selection-language* axis and invariant #3 says there
  are three. A dropdown is not a fourth way to say "on" — it is a control inside a cell.
  Worse, `Row`'s host is inferred from `onSelect`/`href`, so a `Row` with a dropdown is a
  `<button>` inside a `<button>`. A `select="value"` arm would type that as correct.
- Not a promoted `Field`: `ControlPanel.Field` is *the box a value is picked from* (an
  outline `Button`, `w-full justify-between`, truncating). It is correct as a cell-level
  control and the filter builder needs it to stay one.
- It is a **sibling of `RuleRow`**, which established the construction: a non-interactive
  `<div>` box whose *cells* are interactive, with `row-actions` composed at `pin={null}` in
  a reserved track. The two rows then differ on exactly one honest axis — who is the click
  target — enforced by disjoint prop sets.

```ts
export interface ControlPanelSettingProps {
  /** The setting's name — the label cell, on the one text rail. REQUIRED. */
  label: React.ReactNode;
  hint?: string;
  /**
   * THE CONTROL. Interactive by contract: this row's box is a plain <div>, so
   * nesting is legal here and only here. There is NO `onSelect` and NO `href` on
   * this type, so the row can never become a click target — the nested-interactive
   * shape is unspellable rather than discouraged.
   */
  control: React.ReactNode;
  /**
   * "field"  — takes the panel's reserved VALUE track, so every dropdown and
   *            input in the panel starts at one x.
   * "inline" — sizes to its own content (a swatch, an avatar, a stepper).
   * Derived per PANEL exactly like the two leading tracks: one `fit="field"` row
   * opens the value track for every Setting in the panel. DECLARED via
   * `data-cp-value`, never sniffed from the rendered node — same reason
   * `data-cp-icon` is not `leading != null`.
   */
  fit: "inline" | "field";
  /** Presentational, in flow, before the actions — a tier chip, a unit, a count. */
  status?: React.ReactNode;
  /** Hover-revealed cluster, through RowActions pin={null}. */
  actions?: React.ReactNode;
  /** Chrome-gutter stripe. Costs no track — see 1.5. */
  mark?: "accent" | "warning";
  /** A note under the row, on the rail — a conflict line, a validation message. */
  note?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}
```

**`icon` is absent from the type, deliberately.** The leading-track `:has()` scan is per
*panel*: `cp-panel:not(:has([data-cp-icon]))` drops the icon column for every row in it. A
config field is contributed into panels its host does not own — view-options' panel is
assembled from four unrelated plugins — so one field carrying a type icon would indent
**every label in that panel** by 26px. This is the quick-theme footer-glyph failure the
CLAUDE.md already documents, with a new trigger living in another plugin's descriptor. It is
excluded at the type level, the same way `icon` is already excluded from the check/radio arm.

Geometry: a new `cp-setting` utility, tracks `gutter | icon | label | value | status |
actions`. Four are derived per panel by the scan `cp-panel` already runs (`data-cp-handle`,
`data-cp-icon`, plus new `data-cp-value`, `data-cp-status`, `data-cp-actions`). It binds
`--cp-row-h` (invariant #2 by construction), starts its label cell on the same computed
track as `cp-row`'s (invariant #1 by construction), and cancels the rail with the same two
written-out terms `cp-row` uses — never `rail-bleed`.

## 1.3 `ControlPanel.Block` — a control wider than a row

"Loose content lands on the rail by doing nothing" is true and it is **not enough**, because
somebody still has to draw the label — and if that somebody is the renderer we are back
where we started. `Block` is the member that carries it.

```ts
export interface ControlPanelBlockProps {
  label: React.ReactNode;
  hint?: string;
  /** Muted line under the label, above the control. Visible, not a tooltip. */
  description?: React.ReactNode;
  /** The control. Lands on the panel's rail by doing nothing. */
  children: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  mark?: "accent" | "warning";
  note?: React.ReactNode;
  className?: string;
}
```

`Block` is deliberately **not** a `Section`: it carries no `cp-band`, so a run of blocks is
one visual group with no hairline between them. Same reason `RuleList` and `Empty` are not
bands.

Its label is drawn in a `cp-row` label cell — on the **text** rail, not the panel's content
edge. Invariant #1 says every *label* starts at one x, and a Block label is a field label,
the same rung as a Setting label and a Row label. A `Section` label is an eyebrow, a
different rung, and keeps the panel's content edge. In a panel with no icon track the two
coincide; in one with icons the eyebrow hangs back by design. This is gated by a fixture
(§7), not by prose, because it is exactly the kind of thing that drifts silently.

## 1.4 `ControlPanel.Group` — nesting, with the policy owned by the host

`object` / `list` / `variant` recurse. A popover pushes; a pane has no obvious stack. The
choice is a property of the **host**, with no spelling at the call site.

```ts
export interface ControlPanelGroupProps {
  label: React.ReactNode;
  hint?: string;
  description?: React.ReactNode;
  /** Trailing summary when the group presents as a drill row ("3 items", a type). */
  summary?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  mark?: "accent" | "warning";
  children: React.ReactNode;
  // NO `mode` prop. The presentation belongs to the host, not the field.
}

export interface ControlPanelHost {
  /** "push" — a Group is a drill Row pushing a stack entry.
   *  "inline" — a Group is an indented labelled band, up to `inlineDepth`. */
  readonly nesting: "push" | "inline";
  readonly inlineDepth: number;
  /** Where a field description goes. See §3.2. */
  readonly descriptions: "band" | "hint";
}
export function useControlPanelHost(): ControlPanelHost; // throws when absent
```

`ControlPanelPopover` publishes `{ nesting: "push", inlineDepth: 0, descriptions: "hint" }`.
`ControlPanelPane` (§4) publishes `{ nesting: "inline", inlineDepth: 1, descriptions: "band" }`
**and still wraps its children in a `ControlPanel.Stack`**, so depth ≥ 2 falls back to a
push — a list-of-objects-of-lists in a 500px pane does not collapse into nothing.

Inline indentation is a **nested rail region**, not a margin: `cp-group[data-inline]` insets
by one `--cp-icon-col` and republishes `--rail-start`, so a nested `Row`'s bleed reaches the
*group's* edge and `useRailGuard` measures nested children against the right origin. This
replaces `object-renderer.tsx`'s hand-rolled `ml-2 mt-1 border-l border-border pl-lg`.

> **Note on `usePanelStack().push`:** it *replaces the whole body* (a back `Row`, then the
> entry's render). That is right for a popover and wrong for a 15-field pane, which is why
> the pane prefers inline for the first level rather than pushing.

## 1.5 Row adornments — the settings pane's stripe, badge and reset

Three adornments, three answers, and only one is settings-specific.

1. **Reset** is a hover-revealed trailing action — `actions`, rendered through
   `RowActions pin={null}` in a derived `--cp-actions-col` track. Verbatim the `RuleRow`
   construction: same reveal coupling, same xs density, in flow because the track reserves
   the space.
2. **The tier badge** is presentational and must *not* hover-reveal — `status`, its own
   derived track, in flow, before the actions.
3. **The accent stripe** is geometry, not content. Every row already cancels
   `--cp-panel-pad` so its fill reaches the panel's inner edge; that chrome gutter is
   currently painted by nothing. `mark` paints a stripe there. It costs no track, changes no
   rail, and lands identically on `Row`, `Setting`, `Block` and `Group`. A *state* prop
   rather than a `gutter?: ReactNode` child slot, deliberately — the latter reopens "the
   author draws chrome".

A popover host passes none of these, and the tracks are derived from occupancy, so sonata's
panels render byte-identically to today.

## The vocabulary after this

`ControlPanel` + `.Section` · `.Row` · **`.Setting`** · **`.Block`** · **`.Group`** ·
`.RuleList` · `.RuleRow` · `.Field` · `.Footer` · `.Empty` · `.Stack`, plus
`ControlPanelPopover` and **`ControlPanelPane`**.

Read as a set: four ways to be one field — `Row` (the row *is* the control), `Setting` (the
row *holds* the control), `Block` (the control is wider than a row), `Group` (the field is
other fields) — plus the builder pair, plus the boxes and bands.

---

# Part 2 — the renderer contract

**A renderer declares a shape as data. It does not return panel members.**

Returning panel members is rung 3 at best: nothing stops a `<div className="py-md">` beside
the member, a second label, or a `Section` inside a `Setting`. A lint rule saying "the root
must be a `ControlPanel` member" cannot see through a helper component — which is exactly how
today's drift happened (`enum` inlines its own label block instead of using `FieldHeader`;
the `<= 3` heuristic hides inside a helper).

Declaring data is rung 1: **`FieldShape` has no `label`, no `description`, no `className`, no
padding and no indicator anywhere in it**, so a renderer has nothing to draw them with. And
rung 2 on top: the return type is not assignable to `ReactElement`, so a renderer that
returns JSX does not compile.

## 2.1 The type

New types-only barrel: `plugins/config_v2/plugins/fields/core/` (`react` type-only import,
exactly as `plugins/fields/core` already does for `ComponentType`).

```ts
export interface ChoiceOption {
  readonly value: string;
  readonly label: React.ReactNode;
  /**
   * Placed only where the vocabulary has room — a `Field` summary. A radio/check
   * row's leading cell belongs to the indicator (invariant #3), so the icon is
   * DROPPED there rather than pushed into the label cell, which is what knocks a
   * row's text off the rail.
   */
  readonly icon?: React.ReactNode;
  readonly hint?: string;
}

/**
 * WHAT A FIELD IS, as data.
 *
 * Six arms, and not one carries a label, a description, a padding, a class, a row
 * or a selection indicator. All of those are supplied by the ONE host that maps a
 * shape onto ControlPanel members.
 *
 * The selection arms line up 1:1 with invariant #3's three languages:
 *   toggle               → select="switch"
 *   choice select="one"  → select="radio"
 *   choice select="many" → select="check"
 * There is no fourth here, for the same reason there is no fourth there.
 */
export type FieldShape =
  | { kind: "toggle"; checked: boolean; onToggle: () => void }
  | {
      kind: "choice";
      select: "one" | "many";
      options: readonly ChoiceOption[];
      /** "one" → zero or one entry; "many" → the chosen set. */
      value: readonly string[];
      onSelect: (value: string) => void;
    }
  | {
      kind: "value";
      /**
       * THE ESCAPE HATCH — and it does not reopen label-drawing, because this
       * element lands in the VALUE CELL of a Setting, where a label is meaningless
       * and self-applied padding is visible as a mistake. No label reaches this
       * far; there is nowhere to put one.
       */
      control: React.ReactElement;
      fit: "field" | "inline";
    }
  | {
      kind: "block";
      /** A control too wide for a row: textarea, code box, chip cluster, drag
       *  editor. Lands on the panel's rail by doing nothing. */
      control: React.ReactElement;
    }
  | {
      kind: "group";
      fields: FieldsRecord;
      values: Record<string, unknown>;
      onChangeField: (key: string, value: unknown) => void;
    }
  | {
      kind: "list";
      /** An item is ITSELF a shape — so a list of records and a list of scalars are
       *  one arm, and `string-list` stops being its own layout. */
      items: readonly { readonly id: string; readonly shape: FieldShape }[];
      onAdd?: () => void;
      onRemove?: (id: string) => void;
      onMove?: (activeId: string, overId: string) => void;
      addLabel?: string;
    };

export interface FieldShapeProps<T = unknown> {
  field: FieldDef<T>;
  value: T;
  onChange: (value: T) => void;
}

export interface FieldShapeRenderer<T = unknown> {
  readonly type: FieldType<T>;
  /**
   * A HOOK — it may call hooks (useLocalValue, useResource, useContributions) and
   * returns the field's SHAPE, never JSX. `FieldShape` is not assignable to
   * ReactElement, so a renderer that draws its own row is a type error.
   */
  readonly useShape: (props: FieldShapeProps<T>) => FieldShape;
}
```

## 2.2 How it plugs into the existing dispatch

The slot machinery is unchanged — still `defineDispatchSlot` keyed on `props.field.type.id`.
The component is *generated*:

```tsx
// plugins/config_v2/plugins/fields/web
export function defineFieldShape<T>(r: FieldShapeRenderer<T>): FieldRendererComponent<T> {
  const Rendered = (props: FieldShapeProps<T>) => (
    // Hook called unconditionally, at the top, in a real component.
    <FieldShapeView field={props.field} shape={r.useShape(props)} />
  );
  Rendered.type = r.type;
  return Rendered;
}
```

A field type's whole config plugin then reads:

```ts
Fields.Renderer(defineFieldShape({
  type: boolFieldType,
  useShape: ({ value, onChange }) => ({
    kind: "toggle", checked: value, onToggle: () => onChange(!value),
  }),
}));
```

`FieldShapeView` is **the one file in the repo that imports `ControlPanel` on behalf of a
config field.** It reads `field.meta`, reads `useControlPanelHost()`, and picks the member.
`kind: "group"` and `kind: "list"` recurse back through the dispatch slot, deleting the
hand-rolled recursion in `object`, `variant`, `list` and `string-list`.

## 2.3 The deletion that makes it stick

**Delete `FieldHeader`** (`plugins/config_v2/plugins/fields/web/components/field-header.tsx`).
It is the highest-leverage edit here: while it exists, "draw your own label" is a one-import
affordance with a blessed helper behind it. Delete `FieldRendererComponent`'s public export
too, so a stale renderer is a compile error rather than a survivor.

Shapes are a **closed set in `core/`, not a slot** — per the rule that a closed list both
runtimes need is plain data, not a slot plus a codegen bridge. Field *types* stay open
through the existing dispatch slot. The open dimension stays open; the closed one gets
genuinely closed.

---

# Part 3 — grouping is derived, not declared

## 3.1 No new metadata

`FieldMeta` stays `{ label?, description?, placeholder?, typeHint? }` and `ConfigDescriptor`
gains nothing. `FieldShapeView` groups by rules stated once:

- A run of consecutive `toggle` shapes bands into one `Section` of `select="switch"` rows.
- A `choice select="one"` with **≤ 6 options is a `Section`** whose rows are its options
  (`select="radio"`); above that it is a `Setting fit="field"` whose `Field` opens a choice
  panel. **This deletes the `options.length <= 3` heuristic from `enum` and `dynamic-enum`** —
  a presentation decision a field must never make. The threshold is one constant in
  `FieldShapeView`; if a host ever needs a different one it becomes another field on
  `ControlPanelHost`, never a prop on a field.
- `choice select="many"` behaves identically with `select="check"`.
- `value` / `block` shapes join the surrounding run's band.
- `group` / `list` become `ControlPanel.Group`, presented per host policy.

Explicit grouping metadata is rejected: it is a `group`/`order` pair that 80 descriptors
would have to be revisited to supply, that nothing enforces (rung 5 — a doc asking authors
to please group), and that drifts the first time someone adds a field and forgets the name.

**A named section is already expressible, and it is a field type.**
`objectField({ label: "Appearance", subFields: {…} })` *is* a named section, and under
`nesting: "inline"` it renders as one. That belongs in `plugins/config_v2/CLAUDE.md` as the
answer to "how do I section my settings page".

## 3.2 Long descriptions — the `descriptions` host policy

Measured across the repo: **113 field descriptions, 77 over 80 characters, 31 over 140,
longest 344.** Those render as real paragraphs today. Putting all of them behind hover would
make them invisible on touch, unreachable by ⌘F, and gone for anyone reading down the pane.

The two approved mechanisms are enough to avoid that, with no third one and no bent
invariant. `ControlPanelHost.descriptions` decides which is used:

- **`"hint"` (popover).** Every description becomes a `Row`/`Setting` tooltip. Correct there:
  a popover passes field subsets precisely because it wants short labels, not prose.
- **`"band"` (pane).** A `toggle` or `value` field **that has a description** becomes its own
  single-row `Section`, with the description on the band. Descriptionless toggles still band
  together. A `choice` field is a `Section` already, so its description simply lands. A
  `block` field carries its description visibly via `Block`.

No new prop, no threshold constant, no invariant bent — the description is visible wherever
one was written, and the row height never changes.

---

# Part 4 — `ControlPanelPane`

Invariant #5 survives. It says width is a *role* and a panel never resizes as its content
changes. A pane's width is decided by the pane system (`Pane.define({ width: 500 })`) — the
surface's role, exactly as `size="menu"` is the popover's, and it does not move as content
changes. What must never appear is a `width` prop on the panel *body*, and nothing here
proposes one.

```ts
export interface ControlPanelPaneProps {
  label?: string;
  children: React.ReactNode;
  // NO width. NO padding. NO size. Same absences as ControlPanelPopover, for the
  // same reason — the escape is missing from the type, not defaulted in it.
}
```

It owns exactly four things: the body (`<ControlPanel>`, which publishes the rail — the same
one the popover path publishes, which is what makes a pane and a popover align
pixel-for-pixel); the `ControlPanel.Stack`, so `usePanelStack()` works and deep nesting has
somewhere to go; the host policy `{ nesting: "inline", inlineDepth: 1, descriptions: "band" }`;
and nothing else.

It owns **neither the scroll nor the width**. `PaneChrome`'s scroller is already the
scroller; a second one inside a pane is the bug this avoids. It must **not** import
`primitives/pane` (that inverts the layer) — it is a body, a stack and a context value,
about twenty lines.

**Out of scope: the sticky footer.** `data-cp-footer` is a marker with no CSS behind it (v2
recorded this, and it is still true). The settings pane's action toolbar stays pane chrome
above the panel, so nothing here needs it. Left open.

---

# Part 5 — the 18 renderers, mapped

`plugins/fields/plugins/*/plugins/config/web/components/*-renderer.tsx`. (`date`, `rank` and
`uuid` have config sub-plugins but contribute no renderer, and none is reachable from a
`defineConfig` descriptor — they are entity/resource field types. See the `renderers-total`
check in §7.)

| Field type | `FieldShape` | Popover (`push` / `hint`) | Pane (`inline` / `band`) |
| --- | --- | --- | --- |
| `bool` | `toggle` | `Row select="switch"` | same, own Section if described |
| `enum` | `choice select="one"` | ≤6: `Section` of `Row select="radio"`; >6: `Setting fit="field"` → pushed choice panel | ≤6: same; >6: `Setting` → popover |
| `dynamic-enum` | `choice select="one"` (options from the contributed hook) | as `enum` | as `enum` |
| `tags` | `choice select="many"` | ≤6: `Section` of `Row select="check"`; >6: `Block` + `Cluster` of `ToggleChip` | same |
| `text` | `value fit="field"` (`Input`) | `Setting` | same |
| `int` / `float` | `value fit="field"` (numeric `Input`) | `Setting` | same |
| `secret` | `value fit="field"` (password `Input`, or Configured/Replace) | `Setting` | same |
| `directory-path` | `value fit="field"` (`FolderPickerPopover` on a `Field`) | `Setting` | same |
| `color` | `value fit="inline"` (`ColorPickerPopover` swatch trigger) | `Setting` | same |
| `avatar` | `value fit="inline"` (`AvatarPicker` trigger) | `Setting` | same |
| `multiline-text` | `block` (`textarea`) | `Block` | same |
| `json` | `block` (`Surface level="sunken"` + `Scroll`) | `Block` | same |
| `reorder-tree` | `block` (`ReorderEditor`) | `Block` | same |
| `string-list` | `list` of `value fit="field"` items | drill `Row` + pushed panel, `Footer` "Add" | inline `Group`, one `Setting` per item |
| `list` | `list` of `group` items | drill `Row` per item (`summary` = first text field) | inline `Group` per item, `Footer` "Add" |
| `object` | `group` | drill `Row` (`summary` = field count) | inline `Group` (nested rail) |
| `variant` | `group` whose first field is the type `enumField` | drill `Row` (`summary` = variant label) | inline `Group` |

Two things this makes visible: `secret`'s two-state control and `dynamic-enum`'s fallback are
the only places a renderer still branches on presentation, and both branches are now about
the **control**, not the frame. And `string-list` stops being its own layout.

---

# Part 6 — migration order

### Phase 0 — the primitive, alone

`Section description`, `Row hint`, `Setting`, `Block`, `Group`, `ControlPanelPane`,
`useControlPanelHost`, the derived `value`/`status`/`actions` tracks, `mark`, `note`. Plus
the `cp-setting` / `cp-group` `@utility` blocks in
`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`. **Nothing in the repo
compiles differently.** Land the fixtures (§7) and run `layout-geometry` before a single
consumer moves.

### Phase 1 — the contract, in one commit, for all 18 renderers

`FieldShape` + `defineFieldShape` + `FieldShapeView` land, `FieldHeader` is deleted, and all
18 renderers are rewritten. **Not incrementally** — leaving both contracts alive for a
release is a smaller re-run of the problem this exists to end. Each renderer shrinks to
roughly 10–20 lines; the four largest (`list`, `object`, `variant`, `string-list`) shrink
most, because their recursion *and* their layout both go away.

Hosts are untouched here. `config-field-row.tsx`'s `Stack`/`Rigid`/badge/button wrapper still
wraps the new members, which will look slightly odd for one commit. That is acceptable and
visible.

### Phase 2 — sonata view-options (the proving slice)

`plugins/apps/plugins/sonata/plugins/view-options/web/components/view-options-toggle.tsx`
drops the raw `FieldRenderer`-in-a-`Section` and renders shape-mapped members.

**The acceptance test is one screenshot**: open the View panel and the FX panel side by side
in the same HUD. Same 262px, one rail, one row height, one switch language — or the design
failed. Smallest possible slice: one file, three of six shapes, and a falsifying sibling
already shipped.

### Phase 3 — the settings pane and the events form

`plugins/config_v2/plugins/settings/web/components/config-detail.tsx` wraps its field list in
`ControlPanelPane`. Everything that is genuinely pane chrome **stays outside the panel body**:
`ScopeTabs`, the three conflict banners, the `Reset all` / `Stop customizing` / `Raw file`
toolbar, `RawFileView`, `ConflictDiff` / `InvalidDiff`.

`config-field-row.tsx` collapses from a hand-rolled row into prop plumbing — `mark` from
modified/conflict, `status` from the tier badge, `actions` from the reset button, `note` from
the "Upstream:" line — and most likely ceases to exist as a component.

Then `plugins/apps/plugins/events/plugins/sources/web/components/source-config-form.tsx`, a
three-line change once the pane host exists.

### Not in this plan

The hand-rolled *panes* — `theme-customizer.tsx` + `token-row.tsx`, and sonata's
`voicing-controls` / `rhythm-controls/track-config.tsx` / `track-mixer-panel.tsx`. They are a
later burndown; `no-adhoc-setting-row` (§7) will name them.

---

# Part 7 — enforcement

**Rung 1 — inexpressible.** `FieldShape` has no label/class/padding anywhere in it.
`Setting` has no `onSelect`/`href` and no `icon`. `Row` has no `control`. `Group` has no
`mode`. `ControlPanelPane` has no `width`. `FieldHeader` is deleted.

**Rung 2 — type error.** `useShape` returns `FieldShape`, not assignable to `ReactElement`.
`ControlPanelSettingProps.fit` is required, so value-track occupancy is declared, not sniffed.

**Rung 3 — lint.**

- **`config_v2/fields/no-field-chrome`** (new `lint/` on `plugins/config_v2/plugins/fields/`)
  — a path-scoped **import allowlist**: inside `plugins/fields/plugins/*/plugins/config/web/**`
  the legal UI imports are `ui-kit` controls, the type's own picker primitive, and the shape
  factory. `Stack`, `Inset`, `Text`, `SectionLabel`, `Collapsible`, `SortableList` and
  `control-panel` itself are banned there. Stronger than pattern-matching layout, because an
  allowlist bans a new way to draw a label before anyone invents it.
- **`control-panel/no-adhoc-panel-body` signal E** — a bare `<ControlPanel>` whose nearest
  host is a pane body rather than `ControlPanelPane`. Same shape as the existing signal D,
  one host wider.
- **`control-panel/no-adhoc-setting-row`** — a `Stack direction="row" justify="between"` (or
  a `Line`/`Row` with a `Fill` label and a trailing control) containing a `Text
  variant="label"`, in a file that already imports a panel or pane surface. This is the
  "label ………… [control]" shape drawn by hand — *the* shape this exercise deletes — and it
  closes precisely the gap the existing rule's own doc admits to ("a body built from `Stack`
  + `SectionLabel` + `Button` with no divider is invisible to it"). Uses the shared
  class-token walk from `buildLintConfig`. The burndown tier stays **empty**; the hand-rolled
  panes get per-site disables with reasons until Phase 4.

**Rung 3 — checks.**

- `layout-geometry` fixtures in `control-panel/fixtures/`: `setting-rail` (the label rail
  *and* the derived value track across a panel mixing `Row`, `Setting fit="field"`,
  `Setting fit="inline"` and `Block` — the pair that can actually drift), `block-label-rail`
  (the §1.3 decision, gated rather than documented), `group-nested-rail` (a nested group's
  republished rail against its children).
- **Add 500 to the width sweep.** `WIDTHS = [MENU_ROLE_WIDTH, PICKER_ROLE_WIDTH,
  BUILDER_ROLE_WIDTH]` = 262/320/524, while `configDetailPane` is `width: 500`. Without this,
  every geometry claim about the settings pane is untested.
- **A second `RegionFixture`: `control-panel/pane-region`.** `ControlPanelPane` opens a
  region too, and a region fixture cannot scope its own children — so the same
  `REGION_CHILDREN` kit re-gates both hosts, and a member added to the kit re-gates both with
  no edit here.
- **`config-v2:renderers-total`** (new, `plugins/config_v2/check/`) — every field type
  reachable from a registered `defineConfig` descriptor (walking `subFields`/`itemFields`
  through `mapConfigLists`) has a contributed shape renderer. Today a miss is a silent
  `Placeholder` in the dispatch fallback. Also asserts the inverse: a `plugins/config`
  sub-plugin contributing no renderer is dead weight.

**Rung 4 — loud runtime.** `useControlPanelHost()` throws when absent, same policy as
`usePanelStack` — a `Group` cannot render correctly in a host that has not said whether to
push or inline, and a silent default is a dead click at depth 2. `useRailGuard` already names
any child of a live panel that misses the rail, and covers the pane host for free because the
pane renders the same `cp-panel`.

**Rung 5 — documentation.** Only what the rungs above genuinely cannot hold: the §1.3
eyebrow-vs-field-label two-rail decision, and "a named settings section is an `objectField`"
in `plugins/config_v2/CLAUDE.md`.

---

# Boundary check

`control-panel` grows *inside itself* — no new plugin, no cross-plugin re-export, the
compound namespace stays whole. `config_v2/plugins/fields` gains a types-only `core/` barrel,
and its `web/` barrel gains an import of `control-panel/web` — a leaf primitive that knows
nothing about config, so no cycle. Each field type's `config/web` narrows to the shape
factory plus its own control primitive.

---

# Known risk, accepted

The `descriptions: "band"` policy (§3.2) keeps every written description visible in the pane,
but it does so by giving most described fields their own `Section` — so a descriptor where
nearly every field carries a description renders as a run of single-row bands with a hairline
between each. Watch this on the widest descriptors during Phase 3 (`debug/sentinel`,
`debug/queue-health`); if it reads as noise, the lever is the band rule, not a new prop.

---

# Verification

```bash
./equin check layout-geometry     # the fixtures, now including 500px
./equin check plugin-boundaries
./equin check config-origins-in-sync
./equin check                     # type-check, eslint, docs, registries
./equin test plugins/primitives/plugins/css/plugins/control-panel
./equin test plugins/config_v2
./equin build
```

`control-panel/web/__tests__/control-panel.test.tsx` asserts host inference and the
single-selection-language invariant; neither should move. Add: a `Setting` renders a `<div>`
host and never a `<button>`; a panel of `Setting fit="inline"` only reserves no value track.

Then, against the deployed worktree:

```bash
bun plugins/primitives/plugins/css/plugins/control-panel/e2e/hairline-verify.ts
```

And by hand, in this order:

1. **Sonata HUD** — open View and FX side by side. One rail, one row height, one switch
   language, both 262px. This is the acceptance test for the whole design.
2. **Settings → Config** — a descriptor with a `bool`, an `enum`, a `text` and an `object`
   (e.g. `debug/trace`). Every label on one x; every input starting at one x; descriptions
   still readable; modified stripe, tier badge and reset all present and behaving.
3. **Events → a configured source** — its settings section renders the same rows the config
   pane does.
4. A **long** description (`debug/session-divergence`'s grace window) — visible in the pane,
   a tooltip in a popover.
