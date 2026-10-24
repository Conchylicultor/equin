# Row's passthrough lands on one node, always

## Context

`Row` renders as **one** element until it is given `actions`, at which point it
splits into a plain container box plus an inner `<button>`/`<a>` sibling of the
action cluster (nesting interactive elements is invalid DOM — see
`plugins/primitives/plugins/css/plugins/row/CLAUDE.md`).

Everything a caller spreads — `data-*`, `aria-*`, `title`, `style`, `id`,
handlers — falls into `{...rest}`, and `rest` is spread on **whichever element
that path renders**: the single element on the first path, the inner control on
the second. So the destination of a caller's attribute flips the day someone
gives the row an action, at a call site nobody edited.

`primitives/outline/rail`'s `outline-row.tsx` is the live example: it sets
`data-outline-row=""` / `data-outline-id`, and the rail's scroll-spy resolves
elements by those attributes and reads their **geometry** (which section is in
view). It expects the row box. It has no `actions` today, so it works — and it
would silently start measuring an inner button the day it grows one.

This is the third instance of one defect. `interactiveRef` had it for refs;
`className` had it for focus styling. Both are fixed, and the fixes rhyme: the
ref case by handing out a **capability** instead of a node, the styling case by
making `Row` **own** the treatment. The passthrough case has no answer yet, and
unlike the other two it is completely silent — no throw, no lint, no type error.

The open `[key: string]: unknown` passthrough that `Line`, `Card`, `Badge`,
`Surface` and `ToggleChip` carry is honest for them: each renders exactly one
element, so "the rendered element" names a node. `Row` is the only one of the
family that is not single-element, and it inherited a contract that assumes it
is.

## The two destinations are real

Some of `rest` genuinely belongs on the control and some genuinely belongs on
the box, so this cannot be fixed by picking a node:

- `onClick` must sit on the control — a `disabled` `<button>` swallows clicks,
  and Enter/Space only synthesize a click on the button.
- `href`, `target`, `rel`, `download` describe the `<a>`.
- `aria-expanded` / `aria-controls` describe the **disclosure control**.
  `SectionHeaderRow` passes exactly those two into `Row`'s `rest` today.
- `data-outline-row` addresses the **row** — the thing that has a position on
  screen, the same node `ref` already hands out.
- `style` (a dnd transform) and drag/pointer listeners belong to the row box,
  which is what `ref` is measured and dragged by.

## Design

> **Everything you spread on a `Row` lands on the row BOX — the same node `ref`
> gives you — on every path. The exception is a closed, named set of attributes
> that describe the row's CONTROL, which `Row` routes to whichever node it
> synthesized.**

The caller states **meaning**, never a node; `Row` owns placement, exactly as it
now owns the focus ring and the focus capability. Nothing about a caller's
attribute changes when the row grows an action:

| what the caller writes | where it lands, both paths |
| --- | --- |
| `data-*`, `id`, `title`, `style`, mouse/pointer/drag handlers, anything else | the row **box** (= `ref`) |
| `onClick`, `onKeyDown`, `onKeyUp`, `onFocus`, `onBlur`, `href`, `target`, `rel`, `download`, `role`, `tabIndex`, `autoFocus`, any `aria-*` | the row's **control** |

Three properties make this the strongest available rung rather than a
convention:

1. **The flip becomes unspellable.** There is no prop whose destination depends
   on `actions`. The whole defect class disappears rather than being documented.
2. **One source of truth for the routing.** The runtime split list *is* the
   type: `CONTROL_KEYS` is a `const` array, and `RowControlProps` is
   `Pick<React.AnchorHTMLAttributes<HTMLElement>, (typeof CONTROL_KEYS)[number]>`
   intersected with `React.AriaAttributes`. A key added to the type without the
   runtime split (or vice-versa) is not expressible — the classic "these two
   lists must agree" hazard never comes into being.
3. **`Row`'s own attributes stop being overridable.** The control bag is spread
   *before* the attributes `Row` owns (`type`, `disabled`, `aria-current`,
   `data-focus-ring`, `className`), instead of `{...rest}` landing last and
   winning. `type` becomes `type?: never` — it is `Row`'s, inferred from the
   element, and a caller who sets it now gets a type error instead of silently
   turning a row into a submit button.

The box passthrough **stays open** (`[key: string]: unknown`). Once the
destination no longer flips, an open bag aimed at one known element is the same
honest contract `Line`/`Card`/`Badge` have — and closing it would mean
enumerating every DOM attribute a row box might ever want.

`aria-*` routes by **prefix** at runtime and by `React.AriaAttributes` in the
type, so the aria family stays open on both sides without a list to maintain.
`aria-current` is exempted from the type (`Row` derives it from `selected`); if
one arrives anyway, `Row`'s own value wins by spread order.

### Fixed in passing (same defect, same file)

- **`style` no longer clobbers `indent`.** `style` sits in `rest` today and is
  spread *after* `style={{paddingLeft: indent}}`, so a caller's `style` silently
  deletes the row's tree indentation. It becomes a declared box prop, merged
  with `Row`'s indent winning.
- **`title` moves to the box**, so the tooltip covers the whole padded row and
  its actions rather than the inner label only.

## Implementation

**`plugins/primitives/plugins/css/plugins/row/web/internal/row.tsx`** — the only
behavioural change.

- Add `CONTROL_KEYS` (`as const`) + `isControlKey(k)` (`k.startsWith("aria-") ||
  CONTROL_KEYS.includes(k)`).
- Derive `RowControlProps` from `CONTROL_KEYS` as above; export it alongside
  `RowProps` so the contract is readable from the barrel.
- Declare `style?: React.CSSProperties` and `type?: never` on `RowProps`; keep
  the open `[key: string]: unknown` for the box, re-documented as "the row box,
  the node `ref` gives you".
- Split `rest` once into `controlProps` / `boxProps` (a single `for` over
  `Object.entries`), then:
  - **single-element path**: `<Line as={Tag} {...boxProps} {...controlProps} …>` —
    same node, so the split is a no-op there by construction.
  - **split path**: `boxProps` on the `<Line as="div">`, `controlProps` on
    `<Tag>`, each spread *before* the attributes `Row` owns.
- Merge style: `indent !== undefined ? { ...style, paddingLeft: indent } : style`.

**`…/row/web/internal/section-header-row.tsx`** — no behavioural change (its
`aria-expanded`/`aria-controls` now route explicitly instead of by accident);
update the passthrough doc comment to point at `Row`'s rule.

**`…/row/CLAUDE.md`** — a new section, "Passthrough goes where `ref` goes",
completing the trio the file already tells (`ref` → capability, `className` →
owned).

**`…/row/web/__tests__/row.test.tsx`** — a new `describe` pinning the invariant
on both paths: a `data-*` attribute lands on the row box with and without
`actions`; `aria-expanded` lands on the control with and without `actions`;
`style` and `indent` compose; a caller's `aria-current` cannot displace the one
`selected` derives.

**`plugins/primitives/plugins/outline/plugins/rail/web/components/outline-row.tsx`**
— comment only: its `data-*` contract is now guaranteed rather than incidental.

**`plugins/primitives/plugins/collapsible/web/internal/use-collapsible.ts`** —
the one call site the change does break, and it breaks correctly.
`message-card.tsx` spreads `useCollapsible().triggerProps` onto a `<Row>`, and
that bag carries `type: "button"` — which `Row` now refuses, because it owns its
element. The bag is built for a raw `<button>`; a host that owns its element
needs the same semantics without the `type`, which `sidebar-pane-section.tsx`
already worked around by reading three fields out one at a time. So the hook
gains `triggerControlProps` (aria + onClick, no element), and `triggerProps`
becomes `{ type: "button", ...triggerControlProps }` — derived, so the two cannot
disagree. Both call sites then spread the bag that fits.

Otherwise no call site changes: the props actually passed to `<Row>` across the
repo are `onClick`, `href`, `target`, `rel`, `download`, `role`, `tabIndex`,
`aria-selected` / `aria-expanded` / `aria-controls`, `data-*`, `title`, `id` and
`onMouseEnter` — all covered by the table above, and all landing where they
already did on the single-element path.

## Verification

- `./equin test plugins/primitives/plugins/css/plugins/row` — the new
  destination tests plus the existing nested-interactive / focus-ring / focusRef
  suites.
- `./equin check` — `type-check` is the real gate here: `type?: never` and
  the derived `RowControlProps` must not break any of the 128 `<Row>` call sites.
- `./equin build`, then the outline rail end-to-end: open a long page at
  `http://<worktree>.localhost:9000/pages/…`, confirm the right-edge dash
  indicator still tracks the section being read (that is the scroll-spy resolving
  `[data-outline-row]` and measuring it).

## Follow-ups worth filing

- `Line`, `Card`, `Badge`, `Surface`, `ToggleChip` and `SectionHeaderRow` all
  carry `[key: string]: unknown`. They are single-element today, so it is
  honest — but nothing stops one of them from growing a second node the way
  `Row` did. A check that flags a component with an open passthrough rendering
  more than one host element would catch the next instance at authoring time
  rather than three bug reports later.
