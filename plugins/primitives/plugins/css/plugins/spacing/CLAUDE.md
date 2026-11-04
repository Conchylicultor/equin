# spacing

The layout-spacing standard: one closed set of gap/padding roles for every
spacing decision, the `<Stack>` / `<Inset>` primitives that consume them, and
the lint rule that keeps them the single source of truth.

## The scale

The 10-step ramp (`none | 2xs | xs | xsm | sm | smd | md | lg | xl | 2xl`) is declared in
[`primitives/css/space-ramp`](../space-ramp/CLAUDE.md) — its steps, its values,
and the `gap-<step>` / `p-<step>` classes each step names. Import `SpaceStep`
from there, not from here.

## The primitives

- **`<Stack direction gap align justify wrap as>`** — flex container with a gap
  from the ramp. Replaces `flex flex-col gap-*` and `space-y-*`. `direction`
  defaults to `col`; `gap` is required.
- **`<Inset pad x y t r b l as>`** — padding container. Replaces `p-*`/`px-*`/`py-*`.
  Props compose general→specific (`pad` then axis then side).

Both compose caller `className` last, so layout overrides win. Use the named
`gap-<step>` / `p-<step>` utilities directly for grids or third-party components
you don't want to wrap.

### Reaching the ramp from a `className`

- **`insetClass({pad,x,y,t,r,b,l})`** — the same resolver `<Inset>` uses (same
  general→specific order), returning a class string. Use it when you can only
  pass a `className` and cannot wrap the element: Lexical's `<ContentEditable>`,
  `<Text>`, any third-party `className` prop. Use `<Inset>` whenever you own the
  element.

`insetClass` also exists so a step can be a **variable** — see space-ramp on why
a call site passes the step and never builds the class.

- **`selfClass(align)`** — where ONE child sits on the cross axis, keyed by the
  same `StackAlign` union as `<Stack align>` and declared beside `ALIGN_CLASS`
  in `stack.tsx`: the two are one decision seen from the container and from the
  child. Flex only (a grid child's override is `justify-self-*`).

  **No `<Self>` component, for a structural reason:** a wrapper would *become*
  the flex item, so the alignment would land on the wrapper and the real child
  would stretch inside it. `yield`/`grow` are class-only because there is nothing
  to wrap; this one because wrapping **breaks** it. A site that cannot take a
  `className` restructures — it does not gain a wrapper.

- **`<FirstLine>` / `firstLineClass()`** — the box of a leading mark (icon,
  status dot, numbered badge) that must sit on the **first line** of the text
  beside it however far that text wraps: one line tall (`h-[1lh]`, the line
  height it inherits from the row), the mark centred inside, pinned to the
  row's start. The mark is its child. It replaces the `mt-0.5` nudge tuned by
  eye to one font size.

## No margins — on purpose

There are no margin classes, and there will not be. Space belongs to the
**container**, never to a child pushing its neighbours away: a margin is a
decision about a sibling made by an element that cannot see it, so it breaks
the moment the sibling moves, wraps or disappears. Each kind of margin has a
container-owned spelling:

| what the margin did | reach for |
| --- | --- |
| space between stacked blocks (`mt-2`, `mb-1.5`) | the parent's `<Stack gap>` — nest a `Stack` for a tighter or looser group |
| space around an inline separator, arrow, badge, icon → text (`mx-1.5`, `ml-1`) | `<Inline gap>` / a `gap-<step>` on the row. A `Button` already gaps its icon (`gap-control-*`) — the `mr-2` on its icon was doubling it |
| a push to the far end (`ml-auto`) | an empty `<Fill>` (css/fill) |
| an indent (`ml-2` on a collapsible body) | padding — `pl-<step>` / `<Inset l>` |
| a bleed (`-mx-2`) | `rail-bleed` under a region that opened with `rail-<step>` (css/rail) |
| an optical nudge seating a mark on a text's first line (`mt-0.5`) | `<FirstLine>` |
| a UA margin reset (`m-0` on `<p>`/`<pre>`) | nothing — Tailwind's preflight already zeroes them |
| prose rhythm (rendered markdown) | the `my-flow-*` roles in app.css (below) |

**Prose is the one place a margin is the mechanism.** Rendered markdown is a
run of blocks that cannot be a flex column — a float has to wrap them, and the
gap between two blocks depends on the *pair* (a heading after a paragraph),
which only collapsing margins express. So it has named roles of its own, each
reading a ramp step: `my-flow-block` (paragraphs, lists, quotes, tables, code
fences), `my-flow-item` (list items), `my-flow-heading` / `my-flow-subheading`,
`my-flow-rule` (`<hr>`). They are for content that flows *in prose*; a card in
a column is a Stack child.

A site that genuinely needs a raw margin (a third-party DOM we only reach
through a selector) keeps a per-site disable with its reason.

## Enforcement

`lint/no-adhoc-spacing.ts` fails `./equin check` on any class-name carrying
a raw Tailwind spacing utility — numeric (`gap-2`, `px-3`, `mt-4`, `space-y-2`)
or arbitrary (`gap-[7px]`, `p-[5px]`, `p-(--x)`) — across gap, padding,
margin, and space-between.

A word value is not raw, but it must **exist**: `space-ramp/no-dead-spacing`
rejects any word-valued spacing class that no app.css `@utility` declares and
Tailwind cannot resolve itself (`auto`, `px`, `reverse`). There are
intentionally **no margin or `space-*` classes** on the ramp, so `mb-xs` is
such a class — it compiles to nothing. Both rules' messages carry the table
above, so the error says what to reach for.

The rule has no allowlist. A genuinely-fixed one-off escapes per-site via
`// eslint-disable-next-line spacing/no-adhoc-spacing -- reason`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Layout spacing primitives: <Stack gap> (flex + gap) and <Inset pad> (padding) draw from the closed density spacing ramp declared in primitives/css/space-ramp, plus insetClass() — the same padding resolver as a class string, for consumers that only accept a className — and selfClass(align), one child's cross-axis override (the same StackAlign union as <Stack align>, seen from the child), which is class-only because a wrapper would become the flex item and take the alignment itself — and <FirstLine> / firstLineClass(), the one-line-tall box that seats a leading mark on the first line of the text beside it (the structural replacement for an optical mt-0.5 nudge). The sanctioned home for layout rhythm; raw gap-/p-/m-/space- Tailwind is banned by no-adhoc-spacing.
- Web:
  - Uses:
    - `primitives/css/text.TextVariant`
    - `primitives/css/text.useTextVariantClass`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.SingleLineProvider`
  - Exports (types):
    - `FirstLineProps`
    - `InsetProps`
    - `InsetSides`
    - `StackAlign`
    - `StackDirection`
    - `StackJustify`
    - `StackProps`
  - Exports (values):
    - `FirstLine`
    - `firstLineClass`
    - `Inset`
    - `insetClass`
    - `selfClass`
    - `Stack`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by: 432 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×109
    - `conversations` ×70
    - `primitives` ×54
    - `debug` ×38
    - `ui` ×31
    - `page` ×25
    - `plugin-meta` ×16
    - `tasks` ×14
    - `fields` ×9
    - `infra` ×7
    - `apps-core` ×6
    - `stats` ×6
    - `build` ×5
    - `auth` ×4
    - `review` ×4
    - `shell` ×4
    - `integrations` ×3
    - `reorder` ×3
    - `active-data` ×2
    - `backup` ×2
    - `code-explorer` ×2
    - `config_v2` ×2
    - `framework` ×2
    - `layouts` ×2
    - `menu-bar` ×2
    - `screenshot` ×2
    - `hints/ask`
    - `history/dialog`
    - `map/google`
    - `music/chord-box`
    - `network/live/live-state`
    - `reports/launch-fix`
    - `search/quick-find`
    - `tag-tree/picker`

<!-- AUTOGENERATED:END -->
