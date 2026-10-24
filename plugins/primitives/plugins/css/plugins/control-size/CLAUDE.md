# control-size

The control-size standard: one density-aware height scale shared by every
interactive control, plus the lint rule that keeps it the single source of truth.

## The scale

Heights live in the **density** token group as `--control-height-{xs,sm,md,lg}`
runtime vars, exposed as the `control-{xs,sm,md,lg}` and square
`control-icon-{xs,sm,md,lg}` `@utility` classes (defined in
`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`). Picking a density preset
(Comfortable / Cozy / Compact) rescales all controls together.

These utilities are consumed by the sanctioned primitives — `Button`/`IconButton`
(single actions), `ButtonGroup` (split / segmented controls), and `ToggleChip` —
which carry the `ControlSize = "xs" | "sm" | "md" | "lg"` type exported from
`@plugins/primitives/plugins/css/plugins/ui-kit/web`. Height is the only axis the utilities own; padding,
font, radius, and icon size stay per-primitive.

## Enforcement

Two lint rules in `lint/` keep the scale the single source of truth, split by
concern:

**`no-adhoc-control.ts`** fails `./equin check` on the two ways a control is
*fabricated* outside the sanctioned primitives:

- importing `buttonVariants` to paint a non-button element like a button (Check A),
  and
- a raw `<button>`/`<a>` carrying the hand-rolled fingerprint (fixed height +
  horizontal padding + rounded) (Check B).

**`no-adhoc-density.ts`** fails on a *per-instance density override* on a
density-participating control primitive — the relocated escape that desyncs a
control from its neighbours. It is **registry-driven**: one closed allowlist,
`DENSITY_PRIMITIVES` (`Button`, `IconButton`, `PaneIconAction`, `Badge`,
`ToggleChip`, `SegmentedControl`, `LinkChip`, `FilterChip`, `Avatar`, `StatusDot`,
`BouncingDots`), matched by JSX tag name. On any of them it flags two shapes:

- a `size=` prop, and
- a fixed height class in `className` — digit-led `h-*`/`size-*`, or the named
  scale `control-*`/`control-icon-*`. `className="size-6"` *is* the control height
  written by hand. Only height matches; `min-h-0`, `h-auto`, `h-full`, `size-full`,
  fixed *width* (`w-N`), margins, and colours stay legal.

Height/size is ambient — set it once on the region via `<ControlSizeProvider size>`
(or a slot's `controlSize`), never per control; don't hand-roll a sized button,
reach for `<Button>` / `<ButtonGroup>`. A genuine fixed-size exception (custom
chrome, or a density-deriving primitive applying the derived scale to a composed
primitive — e.g. `ToggleChip` on its inner `<Badge>`) escapes per-site via
`// eslint-disable-next-line control-size/no-adhoc-density -- <reason>`.

This is the registry counterpart of the runtime contract: each participating
primitive intersects the shared `DensityControlled = { size?: never }` type
(exported from ui-kit), so the "no `size` prop" lock has one home instead of a
hand-written `size?: never` per primitive.

## Density from context (toolbar-enforced size)

A control's size is a **bundle** (height + padding + radius + text + gap + icon)
named by a density `ControlSize = "xs" | "sm" | "md" | "lg"`. Size should be set
**once by the container**, not per control:

- A **size-owning slot declares density once** — `defineRenderSlot(id, {
  controlSize: "sm" })`. `.Render` wraps every contribution in a
  `ControlSizeProvider`, so a host can't forget. Any subtree can also wrap in
  `<ControlSizeProvider size>` manually (innermost wins).
- Each control maps that density to **its own shape**: `Button` (text) →
  `control-sm`, `IconButton`/`PaneIconAction` (icon) → `control-icon-sm`,
  `ToggleChip` → its `sm`. Mixed controls in one toolbar share a height, keep
  their shapes.
- **No control has a `size` prop** — `Badge`, `ToggleChip`, `SegmentedControl`,
  `LinkChip`, `FilterChip`, `Avatar`, `StatusDot`, `BouncingDots`,
  `IconButton`/`PaneIconAction`, and `Button` all derive density *only* from
  ambient density (`useControlSize`); passing `size` is a compile error on every
  one of them. The lock has one home: each intersects the shared
  `DensityControlled = { size?: never }` type (from ui-kit) instead of a
  hand-written `size?: never`, and the `no-adhoc-density` lint rule rejects the
  same override (prop *or* fixed height class) at call sites repo-wide. There is
  no per-instance density escape hatch anywhere in the app. `Button`'s **shape**
  (text vs square-icon vs inline) is selected via an explicit `aspect` prop
  (`"text"` default | `"icon"` | `"inline"`), which carries no density.

Region primitives declare intrinsic density so consumers don't have to: `Bar`
(toolbars/headers) wraps its contents in `sm` by default; `DataTable` wraps in
`xs` (compact); `Card` opts in via an explicit `controlSize` prop. Composing
these primitives is the primary way to set density for chrome and tables —
`ControlSizeProvider` is still available for bespoke markup that doesn't use them.

The runtime context lives in the **ui-kit** plugin at
`@plugins/primitives/plugins/css/plugins/ui-kit/web` (`ControlSizeProvider`, `useControlSize`,
`iconSizeFor`/`textSizeFor`, `ControlSize`) — co-located with the shadcn `Button`
in the same design-system unit, NOT in this plugin, so the foundational `Button`
reads it without importing a primitive above it. This plugin owns the CSS scale
and the `no-adhoc-control` lint.

## The single density→text policy

Text size is part of the same arc: a leaf's type rung is a property of the region,
not of the leaf. The policy lives next to `Button` in
`…/ui-kit/web/theme/control-size.tsx`:

- `textStepFor(density): 0 | 1` — THE one density→text-step threshold, returning
  `1` only at the compact `xs` density. Consumed by `Button`, `Badge`, AND `Text`
  so they can never step at different boundaries in the same row.
- `buttonTextClassFor(density)` — `Button`'s rung map built on it (`xs → text-xs`,
  else `text-sm`).

**Decision: the step is at `sm → xs`.** `sm`/`md`/`lg` are comfortable affordance
tiers (they change height/padding, not type size); only the explicitly-compact
`xs` tier drops a type rung. Rationale: keep a legibility floor, keep header/
toolbar hierarchy stable (`Bar` defaults to `sm`, so stepping at `sm` would shrink
every chrome label), and treat compaction as a content concern (tables/trees/logs
cram more rows). A future change to where text steps is a single edit to
`textStepFor`.

Design: `research/2026-06-11-global-context-driven-control-size.md`,
`research/2026-06-21-global-text-scales-with-control-density.md`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Control-size standard: the shared control-* height scale and its enforcing lint rule (no-adhoc-control).

<!-- AUTOGENERATED:END -->
