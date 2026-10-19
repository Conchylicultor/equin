# text

The semantic typography primitive. `<Text variant tone as>` is the single
sanctioned way to set text hierarchy: you pick a **variant** (a closed set of
size + line-height + weight + tracking bundles), never a raw `text-sm`/`leading-6`.
The prop is named `variant` (not `role`) so it never collides with the DOM/ARIA
`role` attribute when a host spreads props onto `<Text>`.

## The closed role ladder

The variants are built on ONE closed set of typographic **roles**, declared
once as `TYPE_ROLES` in this plugin's `core/roles.ts` (exported from
`@plugins/primitives/plugins/css/plugins/text/core`). Everything else derives
from it: the `type-scale` token group's role keys (`roleTokenKeys()`), the
`text-<role>` / `text-<role>-compact` / `font-<role>` utilities in ui-kit's
`web/theme/app.css`, and the `<Text variant>` union. A component picks a role; a
theme sets roles (see the `theme` skill); **nothing mints a component-named type
token** — no `fontSizeChip`, no `sidebarLabelSize`, no `text-<component>`
utility. If no role fits, the fix is a new entry in `TYPE_ROLES`, not a token.

Per role:

- **Tokens** — `fontSize<Role>` + `lineHeight<Role>`, both literal LENGTHS (so
  `--font-scale` multiplies them; a unitless line height would be scaled twice).
- **Weight** — `weight` in `TYPE_ROLES`. A shared weight name (`normal` …
  `bold`) is frozen in the role's utility, read from the shared
  `--font-weight-<name>`. `"token"` (`control`, `tag`) means the role owns
  `fontWeight<Role>` + `fontWeight<Role>Strong` and a weight-only `font-<role>` /
  `font-<role>-strong` utility, so a control that swaps its size rung keeps its
  weight (Button, Badge, ToggleChip).
- **Compact rung** — `compact`: the next rung down at the `xs` density, keeping
  this role's weight/tracking (see *Compact density*). `"own"` (`tag`) means the
  role has its own `fontSize<Role>Compact` / `lineHeight<Role>Compact` tokens —
  a theme sets its count chips a half-step below the 2xs sub-scale.

## Variants

Each role variant maps to its `text-<role>` `@utility` in
`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`, backed by the
`type-scale` token group's `--font-size-<role>` / `--line-height-<role>` vars.
A theme resizes every variant by setting role tokens (or `fontScale`).

| Variant      | kind      | size      | line-height | weight            | tracking | Replaces                  |
| ------------ | --------- | --------- | ----------- | ----------------- | -------- | ------------------------- |
| `display`    | role      | 3rem      | 3.25rem     | 700               | -0.035em | `text-5xl font-bold`      |
| `title`      | role      | 1.25rem   | 1.75rem     | 600               | -0.01em  | `text-xl font-semibold`   |
| `heading`    | role      | 1.125rem  | 1.625rem    | 600               | -0.005em | `text-lg font-semibold`   |
| `subheading` | role      | 1rem      | 1.5rem      | 600               | 0        | `text-base font-semibold` |
| `body`       | role      | 0.875rem  | 1.5rem      | 400               | 0        | `text-sm leading-6`       |
| `label`      | role      | 0.8125rem | 1.25rem     | 500               | 0        | `text-sm font-medium`     |
| `group`      | role      | 0.75rem   | 1rem        | 600               | 0        | a group header's `text-xs font-semibold` |
| `control`    | role      | 0.875rem  | 1.25rem     | 500 (token, strong) | 0      | a button's own `text-sm font-medium` |
| `caption`    | role      | 0.75rem   | 1rem        | 400               | 0        | `text-xs`                 |
| `tag`        | role      | 0.75rem   | 1rem        | 500 (token, strong) | 0      | a chip's `text-xs font-medium` |
| `code`       | role      | 0.75rem   | 1.25rem     | 400               | 0        | `font-mono text-xs leading-5` |
| `eyebrow`    | treatment | caption   | caption     | caption           | wide     | `text-xs uppercase …`     |
| `count`      | treatment | caption   | caption     | control           | 0        | a counter's `text-caption` (a toolbar button's "3", "+387") |

(Sizes are the Default theme's; a theme overrides them.)

`tone` layers a foreground color (`default | strong | subtle | muted | faint | primary | destructive`; `faint` is the dimmer tier below muted, from the palette's `faintForeground`; `strong` / `subtle` are the palette's `strongForeground` / `subtleForeground`, which default to body text and to muted, so they only differ where a theme sets them);
`as` swaps the host element (default `span`). `cn(variant, tone, className)` —
caller `className` wins last, so layout margins/truncation compose on top.

`display` is the landing/marketing headline rung — the one role above `title`,
and the only one sized for a page whose whole job is a single sentence. App
chrome never reaches for it; a page has at most one.

`code` is monospaced text, block AND inline (log viewers, code blocks, an inline
`code` span, math source). It has its own tokens (`fontSizeCode` /
`lineHeightCode`, default caption size with the looser label line height —
code wraps and is scanned line-by-line) and owns the mono **family** as well as
the metrics, so "code" is one decision — do not pair it with `font-mono`. Its
compact rung is the 2xs size at the caption line height.

`group` is the heading of a group of rows in a list or sidebar — a quiet group
header ("Queue 14", data-view's `headerStyle="quiet"`). Its own role rather than
`label`, so a theme sizes its group heads apart from the rows they head (Mist:
12.5px over 13px rows). Semibold, frozen; its compact rung is the caption
metrics at that weight.

`control` is the words ON a control — a tab's title, and (through
`buttonTextClassFor`) every `Button`'s label — so a region sets both at once.
Its weight is a token (`--font-weight-control`, plus `font-control-strong` for a
primary action): the app chrome's fixed theme sets its controls to regular
weight without re-weighting the prose around them. Its compact rung is the
caption metrics at the control weight.

`tag` is the words on a chip — a `Badge`, a pane header's model/status chips, a
transcript card's tool badge (`text-tag font-tag-strong`). Weight is a token
like `control`'s; its compact rung (`text-tag-compact`, a `Badge` at `xs`) has
its own size tokens.

`count` is a **treatment**, not a role: a number beside a glyph — a toolbar
button's count, a diff's `+387` — rendered as the control's compact rung with
tabular figures (`text-control-compact tabular-nums`). It owns no tokens; a
theme moves it by setting the caption / control roles.

`textVariantClass(variant)` returns a variant's classes as a string, for the
elements `<Text>` cannot be — a shiki `<pre>`, a `dangerouslySetInnerHTML` div, a
Lexical input. Same own-it-⇒-component rule as the layout helpers. It reads no
ambient `ControlSize`, so a helper-styled box does not compact.

`eyebrow` is the overline / section-label **treatment**. Like `count` it is
**not** a utility of its own — it reuses `text-caption` and adds the small-caps
treatment (`uppercase tracking-wide whitespace-nowrap`). Tone stays orthogonal.

`text-2xs` / `text-3xs` are the sanctioned sub-scale below role granularity
(`TYPE_SUBSCALE`: times, chip internals). They are type-scale tokens too and
follow `--font-scale`.

## `fontScale`

The `type-scale` group's `fontScale` (`--font-scale`, default `1`) is the ONE
multiplier on every role's size and line height, the compact rungs, the
sub-scale and the inherited base — "make the text one step bigger" is this one
value, in any theme scope, sub-themes included.

- **Applied in the utilities, at the element.** Every role utility writes
  `font-size: calc(var(--font-size-<role>) * var(--font-scale))` (same for
  line-height), and the `@theme inline` bridges for `text-2xs` / `text-3xs` do
  likewise. Nothing scales `html`, so spacing and rem tokens are untouched.
- **The inherited base** is set at every `[data-theme-scope]` root as
  `calc(var(--font-size-base) * var(--font-scale))`, and `fontSizeBase` is `1rem`,
  never `1em`: every pane is a nested `<Theme>` scope, so an em base would
  compound the scale once per nesting level. `lineHeightBase` stays unitless.
- **Role line heights are lengths**, so the multiplication is exact.
- **Not scaled:** weights, the reading measure (`measureReading`), and
  plugin-local CSS that hard-codes px sizes.
- **A TS consumer that needs a role's raw metric** (a page block's bullet
  aligned to the body line) uses `typeVar("line-height-body")` from `core/` —
  the same `calc(… * var(--font-scale))` expression — never
  `var(--line-height-body)`, which would skip the scale.

### SectionLabel

`SectionLabel` (also exported from this barrel) is the small-caps muted
section/eyebrow label — a thin composition over
`<Text variant="eyebrow" tone="muted" as="div">`. It was previously a standalone
`section-label` plugin; the eyebrow geometry now lives here as a Text variant
(one definition) and the helper supplies the muted tone + block host. Import from
`@plugins/primitives/plugins/css/plugins/text/web`.

## Single-line truncation (the folded `TruncatingText`)

`Text` IS the truncation leaf — the former `TruncatingText` plugin folded into it.
Whether it truncates is **not** its own prop: it reads the ambient `SingleLine`
context (`useSingleLine()` from `…/ui-kit/web`, the exact mirror of `ControlSize`).

- Inside a **line container** (`Frame` slot / `Row` / `Bar` / collapsible header,
  which provide `SingleLineProvider value={true}`) a `<Text>` applies the
  `block w-fit max-w-full min-w-0 truncate` recipe and ellipsizes on one line,
  auto-deriving a `title` tooltip from string children.
- Inside a **flow container** (`Stack` col / `Stack wrap` / `Column` / `Cluster`,
  which reset to `value={false}` + `whitespace-normal`) it wraps.

### Why the leaf is block-level

The recipe used to say `inline-block`, and that is the whole of a misalignment
the repo carried at every row built the canonical way. An inline-level box whose `overflow` is not
`visible` — which `truncate` makes true — hands the line it sits on the bottom of
its own margin box as its baseline. Put such a leaf in a plain block parent (a
`<Fill>` cell is one) and the parent still has to leave room *below* that
baseline for its own strut's descender: at 16px/24px the cell measured 30px for
24px of text. The row's `items-center` then centred the sibling icon against that
inflated box and dropped it ~3px below the words it labels — the canonical
`Line > Icon + Fill(Text)` row, quietly wrong at all ~57 places a `<Text>` sits
directly in a `<Fill>`.

`block` removes the inline formatting context, so there is no strut and the
parent's height is exactly the leaf's. It is exact at every font-size pairing,
which `vertical-align: top` is not (that only helps while the leaf's line-height
is at least the parent's). `w-fit` restores the shrink-to-fit width
`inline-block` was also providing, so a `hover:underline` or a background still
ends where the words end; in a flex or grid parent it changes nothing, since the
item is blockified and content-sized there either way.

It is the [`Badge`](../badge/CLAUDE.md) baseline incident one layer down — an
inline-flex chip handing a sentence its *icon's* bottom edge — and the same class
of bug: a box offering the line a baseline that is not its text's.

There is deliberately **no truncation on/off prop** — "non-truncating text in a
line row" is a contradiction, so misuse is structurally impossible: pick the
container. `side="start"` flips the ellipsis to the leading edge (file paths) via
the RTL technique; it's inert outside a single-line context. The rare
forced-single-line-in-a-flow-region case wraps the leaf in
`<SingleLineProvider value={true}>` explicitly. The `min-w-0` lives only here (the
single owner); `variant` is optional (omit = inherit the surrounding typography,
the role `TruncatingText` used to fill). The `text/block-parent-no-op` geometry
fixture guards the block-level hardening; `web/__tests__/single-line.test.tsx`
covers the context behavior.

This plugin also hosts the `no-clip-without-nowrap` lint rule (relocated from the
deleted `truncating-text` plugin) — see `lint/index.ts`.

## Compact density

`Text` reads the ambient `ControlSize` (the region signal — `Bar` is `sm`,
`DataTable`/tree rows/compact `Card` are `xs`). At the compact `xs` density it
swaps each variant for its **weight-preserving `-compact` form** (the next
size+line-height rung down with the original weight/tracking kept, so a compact
subheading stays semibold and still reads as a subheading). `sm`/`md`/`lg` keep
the comfortable size. There is **no prop** — the region owns it, mirroring the
control-density arc invariant (size is a property of where you are, not of the
leaf). An omitted `variant` inherits the surrounding typography, so there's
nothing to compact.

The single threshold lives in `textStepFor(density)` in
`…/ui-kit/web/theme/control-size.tsx` — **the one density→text-step policy
shared by `Button`, `Badge`, AND `Text`** (so neighbours in a row can't desync
their type rung). The `-compact` utilities live beside the base `text-<role>`
utilities in `…/ui-kit/web/theme/app.css`. `web/__tests__/compact-density.test.tsx`
covers the swap.

### Three disjoint sizing axes

| Axis                  | Owner                          | Scope      | Controls                                             |
| --------------------- | ------------------------------ | ---------- | --------------------------------------------------- |
| **Density preset**    | `tokens/density`               | global     | padding / spacing / control heights (no font sizes) |
| **Type scale**        | `tokens/type-scale`            | per theme  | every role's size/line-height/weight + `fontScale`  |
| **ControlSize**       | `ControlSizeProvider` / region | per-region | affordance density → height/icon/chip/**text step** |

The `tokens/density` group has **zero font-size tokens** — typography is the
*separate* `tokens/type-scale` group (and the `type-scale:closed-role-ladder`
check fails if any other group declares one). So `ControlSize → Text` and the
density preset never collide: `ControlSize` picks a *different role*; the
type-scale preset still themes whichever role is picked.

The three write different properties (padding vs font-size vs which role is
picked), so there is no container/child race here and nothing to escape from —
this is **not** the [rail contract](../rail/CLAUDE.md), despite the surface
resemblance of "they compose, no double-apply". Do not reach for a rail utility
to reconcile them; they never needed reconciling.

## Enforcement

- `lint/no-adhoc-typography.ts` fails `./singularity check` on raw named font
  sizes (`text-{xs,sm,base,lg,xl,2xl…}`) and `leading-*` in any class-name
  context — reach for `<Text variant>` (or its `text-<role>` utility) instead.
  The shared class walk reads `className`, `cn` / `clsx` / `twMerge` AND `cva`
  (a `cva` table's base and variant values are classes; its variant names and
  `defaultVariants` are not), and follows same-file string consts and
  object/array maps (`cn(TONE[tone])`). It enforces repo-wide with no exemptions
  allowlist. A genuinely fixed raw size escapes per-site via
  `// eslint-disable-next-line text/no-adhoc-typography -- reason`.
- `type-scale/lint/no-arbitrary-font-size.ts` bans `text-[Npx]` /
  `text-[Nrem]`; only the sub-scale sizes (10px / 11px) auto-fix.
- The `type-scale:closed-role-ladder` check (in `ui/tokens/type-scale/check/`)
  keeps the ladder closed: the type-scale keys are exactly `roleTokenKeys()`
  plus its short non-role list; no other token group declares a font size,
  line height or weight; every ui-kit `@utility` that sets type metrics is a
  derived role utility multiplied by `--font-scale`; the lint message above names
  every `<Text>` variant; and no `.ts(x)` outside this plugin and type-scale
  reads a raw `var(--font-size-*)` / `var(--line-height-*)`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Semantic typography primitive: <Text variant tone as> picks a frozen size/line-height/weight role from the typography token group (incl. the eyebrow/section-label role). The single sanctioned home for text hierarchy; raw text-size/leading-* is banned by no-adhoc-typography.
- Web:
  - Uses:
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.MENU_LABEL_PAINT`
    - `primitives/css/ui-kit.textStepFor`
    - `primitives/css/ui-kit.useControlSize`
    - `primitives/css/ui-kit.useMenuSurface`
    - `primitives/css/ui-kit.useSingleLine`
  - Exports (types):
    - `SectionLabelProps`
    - `TextProps`
    - `TextTone`
    - `TextVariant`
    - `TruncateSide`
  - Exports (values):
    - `SectionLabel`
    - `Text`
    - `textVariantClass`
- Cross-plugin:
  - Uses tokens: 44 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/type-scale` ×36
    - `ui/tokens/color-palette` ×6
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --spacing`
  - Imported by: 373 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×105
    - `conversations` ×72
    - `primitives` ×42
    - `debug` ×35
    - `page` ×21
    - `plugin-meta` ×14
    - `ui` ×14
    - `tasks` ×12
    - `fields` ×9
    - `stats` ×6
    - `build` ×5
    - `auth` ×4
    - `infra` ×4
    - `review` ×4
    - `integrations` ×3
    - `reorder` ×3
    - `active-data` ×2
    - `apps-core` ×2
    - `backup` ×2
    - `code-explorer` ×2
    - `config_v2` ×2
    - `map` ×2
    - `screenshot` ×2
    - `shell` ×2
    - `framework/web-core`
    - `history/dialog`
    - `layouts/route-fallback`
    - `search/quick-find`
- Core:
  - Exports (types):
    - `TextTreatment`
    - `TypeRole`
    - `TypeSubscale`
    - `TypeVarName`
  - Exports (values):
    - `roleTokenKeys`
    - `TEXT_TREATMENTS`
    - `TYPE_ROLES`
    - `TYPE_SUBSCALE`
    - `typeVar`

<!-- AUTOGENERATED:END -->
