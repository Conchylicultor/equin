# row

## Element is inferred — there is no `as`

`Row` picks its own host element from props, so a consumer never authors one:

- `href` present → `<a>` (link row)
- else `onClick` / `disabled` present → `<button>` (the keyboard-accessible click target)
- else → non-interactive `<div>` (display / form-style container row)

This closes the **nested-interactive footgun**. A `Row` carrying interactive
`actions` (`IconButton`, a `DropdownMenuTrigger`, …) can no longer be declared as
a `<button>` that then nests those action buttons (invalid `<button>`-in-`<button>`
DOM whose failure is *silent* — the action click is swallowed or falls through to
the row). When a row is interactive **and** has `actions`, `Row` renders a
non-interactive container with the primary `<button>`/`<a>` as a **sibling** of the
actions (a full-bleed `aria-hidden` hit-area keeps the whole padded row clickable
and names the button from its children). The split is structural, so the bad DOM
is unrepresentable; `web/__tests__/row.test.tsx` pins it.

**Contract:** a clickable row's **body is presentational** — put every
interactive trailing control in the `actions` slot, never in `children`. A row
that needs interactive controls *in its body* (e.g. an inline title button + a
remove button) is a non-interactive container: pass no `onClick`/`href` and it
stays a `<div>` that may legally nest them.

"Presentational" bans nested **click targets**, not hover. A clickable row's body
may hold hover-driven affordances — a tooltip trigger, a CSS `group-hover`
chip — and they work: the split path's hit-area paints *beneath* the row content
(`z-under`), so `:hover` still reaches the body. It used to sit on top and
silently ate every pointer event aimed at the body, which read as "tooltips just
don't fire in a DataView list". If you catch yourself hoisting body content out
to `actions` to make it hoverable again, that's the bug, not the fix.

## Focus is the row's, not the caller's

Because the control is *synthesized*, a caller cannot predict which node it is,
cannot predict the day it appears (someone adds `actions`), and therefore may
not style it. So `Row` paints the app's canonical focus ring itself, on the ROW
BOX, on both paths: `focus-ring` fires when the box IS the control, the new
`focus-ring-from` fires when the box holds a control it nominated with
`data-focus-ring`, and the split path's inner button carries `outline-none` so
the UA outline never draws a second, tighter indicator inside the ring. One
indicator, identical whether or not the row carries actions, covering the whole
`p-row` padding ring that a `flex-1` control can never reach. (`focus-ring-within`
is deliberately unused: it would also fire when a row ACTION takes focus,
restoring the double indicator on top of that button's own ring.)

**Callers author no focus styling on a `Row`** — no `outline-*`, no `ring-*`, no
`focus:`/`focus-visible:`/`focus-within:` variant in its `className`, enforced by
`row/no-row-focus-class`. Such a class lands on the BOX, which stops being the
focused node the day the row splits; that is how a page row ended up drawing its
own ring around the container while the browser drew one around the button
inside it. What callers *do* have vocabulary for is **`selected`** — "this is the
current row" (the editor's caret is here, this list item is the open one). It is
a background tint, a different question from focus, and the two layer. A
selected row also takes `text-accent-foreground`, so its label
reads brighter than its neighbours' in a theme whose accent text is brighter
than its body text (Mist); a leaf that sets its own tone keeps it.

**A row has no hover dial.** It hovers to `--hover-fill`, which every surface
publishes (`surface.ts`: a card its muted tone, the sidebar its accent, a
popover its `popoverHover`), so it is right on whatever it sits on. Never pick
a colour per call site.

`ref` is the ROW ELEMENT — the outermost box — for DnD / scroll-into-view /
measurement. It is never the thing you focus: on a row with `actions` it is a
plain `<div>` that cannot take focus at all. To move focus into a row (keyboard
navigation landing on a void editor block) use **`focusRef`**, which is
`Ref<RowFocus>` — a `{ focus(): void }` capability and deliberately NOT a node.
Handing out the node is what the old `interactiveRef` did, and it failed
silently: a second ref you had to know to reach for, whose omission left you
calling `.focus()` on an unfocusable `<div>` — no throw, no focus. A capability
cannot be measured, dragged, or compared against `document.activeElement`, so it
cannot be mistaken for `ref`, and `Row` stays free to move the focus target
between paths. `focus()` is synchronous (the page editor's `CaretSurface`
contract is `focus: () => void`, which is why this is not a declarative `focused`
prop) and THROWS on a row that renders no control at all — a loud caller bug
instead of a silent no-op.

## The passthrough goes where `ref` goes

The rule itself is no longer Row's — it lives in
[the passthrough contract](../../../passthrough/CLAUDE.md), which every primitive
that accepts props it does not name now spells `extends Passthrough`. Row is
where it was learned, and the one primitive with a genuine SECOND destination.

Everything you spread on a `Row` — `data-*`, `id`, `title`, `style`, mouse /
pointer / drag handlers, anything else — lands on the **row box**, the same node
`ref` hands out, on **both** paths. The exception is a closed, named set that
describes the row's **control**: `onClick`, `href` / `target` / `rel` /
`download`, `role`, `tabIndex`, `autoFocus`, the keyboard and focus handlers, and
any `aria-*`. Those `Row` routes onto whichever node it synthesized, through
`splitPassthrough(rest, isControlKey)` — the sanctioned split, where saying the
second destination out loud is what tells a deliberate routing apart from an
accidental one.

The caller states **meaning**; `Row` decides the node — the same move as
`focusRef` (a capability, not a node) and `className` (the treatment, owned by
the row). The incident behind it: `rest` used to be spread on "the rendered
element", which is one node until the row is given `actions` and two afterwards.
So a `data-*` attribute a caller used as a selector target moved from the row box
to an inner button the day someone added an action — at a call site nobody
edited, with no throw, no lint and no type error. Now nothing about a caller's
attribute changes when the row splits.

Both destinations are real, which is why this is not a matter of picking one
node. `onClick` has to be on the control (a `disabled` `<button>` must swallow
it, and Enter/Space only synthesize a click there); `aria-expanded` describes the
disclosure control, which is what `SectionHeaderRow` depends on;
`data-outline-row` addresses the row, because the outline rail resolves it and
then measures **where it is on screen**.

Two consequences worth knowing:

- **The routing has one source.** `CONTROL_KEYS` is the runtime split list, and
  `RowControlProps` is derived from it, so the type and the behaviour cannot
  drift apart. `aria-*` is matched by prefix on both sides, so the aria family
  stays open with no list to maintain.
- **`Row`'s own attributes are no longer overridable.** The bags are spread
  *before* `type`, `disabled`, `aria-current` and `className`, instead of `rest`
  landing last and winning. `type` is `never` — the row infers its element, so
  setting `type` is a type error rather than a row that quietly became a submit
  button. `aria-current` comes from `selected` only. And `style` is merged under
  `indent` (which wins on `padding-left`) instead of replacing it, which used to
  un-indent a tree row silently.

On the split path the box is **not** a click target — it is a plain `<div>`
wrapping the control. Address the control the way a user does
(`getByRole("button", { name })`), not by clicking a `data-testid` you put on the
row.

## `SectionHeaderRow`: where the disclosure sits

`SectionHeaderRow` is `Row` as a collapsible header. `disclosure` places its
chevron:

- **`"lead"`** (default) — before the label, always visible; a static header
  (`collapsible={false}`) keeps the chevron's box invisible so a mixed stack
  aligns on one title column.
- **`"trailing"`** — right after the label run (so a label + count run reads
  "Queue 6 ›"), shown only while the row is hovered or its control has keyboard
  focus. The label then starts on the rows' own column — a quiet group header
  (`DataViewProps.groupHeaders="quiet"`). `aria-expanded`, `aria-controls` and
  the click target are unchanged.
- **`"none"`** — no chevron and no reserved box. The row is still the
  disclosure control (`aria-expanded`, `aria-controls`, click), and TONE carries
  the state: a collapsed header is muted (its actions re-toned to the
  foreground, so a header toggle never reads disabled). `SectionCard`'s
  `inspector` variant.

The trailing reveal is `hover-reveal`'s `useHoverReveal` (per-instance state;
pointer enter/leave on the row box, keyboard-only focus on the control, each
composed with a caller's own handler) rather than a Tailwind group: `Row`'s
`group/row-actions` belongs to the action cluster, and headers are few enough
that the state costs nothing.

## Row is not a data list

`Row` is for *single* rows and transient chrome (menus, pickers, nav, tab
strips, section headers). Rendering a **collection of homogeneous domain
records** by mapping into `Row` is banned — that's a
[`DataView`](../../../data-view/CLAUDE.md) surface (`views={["list"]}`
minimum; search/filter/sort/groupBy/item-actions come free, and the view
config is git-promotable). Enforced by `data-view/no-adhoc-row-list`; a
genuine transient-chrome list escapes with
`// eslint-disable-next-line data-view/no-adhoc-row-list -- <reason>`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Generic interactive row primitive (list, menu, nav, tree, and collapsible section-header rows) with a sanctioned home so ad-hoc rounded+padded interactive markup routes through one primitive.
- Web:
  - Uses:
    - `primitives/collapsible.CollapsibleChevron`
    - `primitives/collapsible.CollapsibleWarmHandlers`
    - `primitives/collapsible.useCollapsibleContext`
    - `primitives/css/line.Line`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.useMenuSurface`
    - `primitives/hover-reveal.hoverRevealClass`
    - `primitives/hover-reveal.useHoverReveal`
    - `primitives/row-actions.RowActions`
    - `primitives/row-actions.rowActionsAnchor`
  - Exports (types):
    - `RowControlProps`
    - `RowFocus`
    - `RowProps`
    - `RowSize`
    - `SectionHeaderDisclosure`
    - `SectionHeaderRowProps`
    - `SectionHeaderVariant`
  - Exports (values):
    - `Row`
    - `SectionHeaderRow`
- Cross-plugin:
  - Uses tokens: 26 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/type-scale` ×11
    - `ui/tokens/color-palette` ×8
    - `ui/tokens/density` ×4
    - `ui/tokens/shape` ×3
  - Imported by: 66 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×16
    - `ui` ×13
    - `page` ×10
    - `primitives` ×9
    - `conversations` ×6
    - `plugin-meta` ×3
    - `tasks` ×3
    - `code-explorer/file-resolve`
    - `config_v2/settings`
    - `debug/trace/pane`
    - `reorder/editor`
    - `search/quick-find`
    - `shell/health-report`
- Exemptions:
  - Exempts itself from:
    - `row/no-adhoc-row` — `web` (sanctioned)
    - `row/no-row-focus-class` — `web` (sanctioned)
  - Exempted by: `primitives/css/row` (0 debt)

<!-- AUTOGENERATED:END -->
