# Enforce density-derived control sizing (reject ad-hoc per-instance size)

## Context

Control primitives are supposed to derive their height/size from the ambient
`ControlSize` density context (`useControlSize()`), set once by a container
(`Bar`, `DataTable`, a `controlSize` slot, or a bespoke `<ControlSizeProvider>`).
That consistency mechanism **exists** but is **opt-out-able by convention**: each
primitive independently plugs the escape hatch with a hand-written `size?: never`,
and nothing stops a primitive — or a call site — from re-introducing an ad-hoc
per-instance size. This is the root cause behind the historically inconsistent
IconButton and chip heights.

`size?: never` is also incomplete: a height can still be smuggled in as a
className (`<Button className="h-7">`, `control-lg`, `size-8`), which TypeScript
never sees.

**Goal:** one enforcement, owned by the `control-size` primitive, mirroring the
`no-adhoc-control` / `no-adhoc-radius` lint family, so that:

1. The set of density-participating primitives is declared in **one registry**.
2. An ad-hoc per-instance size override — whether a `size` prop **or** a
   height/size class — on any of them is **rejected repo-wide**.
3. The "no size prop" contract itself comes from **one shared type**, not
   re-typed per primitive.

**Prerequisites are met.** The chip and decorative-primitive gaps named in the
task were closed by commit `64a6e559b` ("decorative primitives derive size from
ambient density"): `Avatar`, `StatusDot`, `BouncingDots` now read
`useControlSize()` and carry `size?: never`, joining `Badge`/`ToggleChip`. A repo
scan finds **zero** `size=` prop violations and only **3** className height
overrides to clean up (all `<Button className="h-7 …">` in one debug panel) — so
the rule can land now.

## Decisions (confirmed with user)

- **Rule scope:** flag both a `size=` attribute **and** a `control-*` / `h-\d` /
  `size-\d` height class in `className`, on registered density primitives.
- **Registry shape:** add the closed tag-name list as the lint registry **and**
  export a shared `DensityControlled = { size?: never }` type that every
  participating primitive intersects (centralizes the definition-side contract).

## Design

Two cooperating pieces, both owned by `control-size` / its co-located `ui-kit`:

### 1. Shared definition-side contract — `DensityControlled`

The `ControlSize` runtime context already lives in **ui-kit** (co-located with the
foundational `Button` so it can read density without importing a primitive above
it):
`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size.tsx`.

Add there, and re-export from the ui-kit web barrel
(`plugins/primitives/plugins/css/plugins/ui-kit/web/index.ts`):

```ts
/** A density-participating control derives its size from ambient ControlSize;
 *  it must NOT accept a per-instance `size`. Intersect props with this instead
 *  of hand-writing `size?: never`, so the contract has one home. */
export type DensityControlled = { size?: never };
```

Then replace the inlined `size?: never` in each participating primitive's props
type with `& DensityControlled` (importing the type from
`@plugins/primitives/plugins/css/plugins/ui-kit/web` — a normal cross-plugin
barrel import these primitives already make for `useControlSize`):

| Primitive | File | Current | Change |
|---|---|---|---|
| `Badge` | `css/plugins/badge/web/internal/badge.tsx` | `size?: never` in props | drop it, `& DensityControlled` |
| `ToggleChip` | `css/plugins/toggle-chip/web/internal/toggle-chip.tsx` | `size?: never` | `& DensityControlled` |
| `Avatar` | `avatar/web/components/avatar.tsx` | `size?: never` | `& DensityControlled` |
| `StatusDot` | `css/plugins/status-dot/web/internal/status-dot.tsx` | `size?: never` | `& DensityControlled` |
| `BouncingDots` | `css/plugins/bouncing-dots/web/internal/bouncing-dots.tsx` | `size?: never` | `& DensityControlled` |
| `Button` | `css/plugins/ui-kit/web/components/ui/button.tsx` | omits `size` from VariantProps | also `& DensityControlled` (explicit) |
| `IconButton` | `icon-button/web/components/icon-button.tsx` | `Omit<…,"size">` | also `& DensityControlled` |
| `SegmentedControl` | `css/plugins/toggle-chip/web/internal/toggle-chip.tsx` | no size prop | `& DensityControlled` |
| `LinkChip` | `css/plugins/link-chip/web/internal/link-chip.tsx` | no size prop | `& DensityControlled` |
| `FilterChip` | `filter-chips/web/internal/filter-chips.tsx` | wrapper, no size | `& DensityControlled` |

> This is a contract-tightening only — every primitive above already lacks a real
> `size` prop, so no runtime behavior changes. `PaneIconAction` (an `IconButton`
> composition) inherits the contract through `IconButton`.

### 2. The lint rule + registry — `no-adhoc-density`

New rule mirroring the `no-adhoc-*` family, in the **same plugin** as
`no-adhoc-control`:

- `plugins/primitives/plugins/css/plugins/control-size/lint/no-adhoc-density.ts`

**The registry** (closed tag-name allowlist, inline `Set` like icon-auto's
`AUTO_SIZING_PARENTS` — lint files run under jiti and **cannot** import
`@plugins/*`, so the name list is a lint-local artifact, not shared with the
runtime `DensityControlled` type; they are parallel expressions of the same
intent):

```ts
// KEEP IN SYNC with the primitives that intersect `DensityControlled`.
const DENSITY_PRIMITIVES = new Set([
  "Button", "IconButton", "PaneIconAction",
  "Badge", "ToggleChip", "SegmentedControl",
  "LinkChip", "FilterChip",
  "Avatar", "StatusDot", "BouncingDots",
]);
```

**Two checks**, both gated on the owning JSX element's identifier name being in
`DENSITY_PRIMITIVES` (matched by tag name only — aliased re-imports are an
accepted false negative, same precedent as icon-auto/no-adhoc-control):

- **Check A — `size` prop.** `JSXAttribute` named `size` whose owner ∈ registry →
  report. (Belt-and-suspenders with `DensityControlled`; also catches a primitive
  that joins the registry before its props are tightened, and reads clearer than a
  raw `ts(2322)`.)
- **Check B — height/size class.** `JSXAttribute` named `className` whose owner ∈
  registry; run the **shared class-token walk** (`collectTokens`, copied
  **byte-identical** from `no-adhoc-control.ts` between the
  `>>> shared:class-token-walk <<<` markers — enforced by the
  `class-token-walk-in-sync` check), strip variant prefixes via `baseClass`, and
  report if any token matches a height marker:
  - `/^control-(xs|sm|md|lg)$/` and `/^control-icon-(xs|sm|md|lg)$/` (the scale,
    applied ad-hoc instead of derived)
  - `/^h-\d/` (numeric height) and `/^size-\d/` (numeric size shorthand)

  Numeric-suffix-only (so `h-full`/`h-auto`/`size-full` are safe); widths,
  margins, `min-h-*`, and colors are untouched.

No autofix (choosing the right container density vs. a deliberate override is a
human call), matching the whole family.

**Barrel** — add to `control-size/lint/index.ts`:

```ts
export default {
  name: "control-size",
  rules: {
    "no-adhoc-control": noAdhocControl,
    "no-adhoc-density": noAdhocDensity,
  },
  ignores: {
    "no-adhoc-control": [],
    "no-adhoc-density": [],
  },
};
```

No `lint.generated.ts` regen is needed — `control-size` already has a `lint/`
folder; adding a rule to an existing barrel doesn't change the registry.

**Test** (precedent: `no-adhoc-typography.test.ts`, `no-adhoc-spacing.test.ts`):
- `control-size/lint/no-adhoc-density.test.ts` — `@typescript-eslint` `RuleTester`
  under `bun:test`. Invalid: `<Badge size="sm">`, `<IconButton size="lg">`,
  `<Avatar size="md">`, `<Button className="h-7">`, `<ToggleChip className="control-lg">`,
  class parked in a same-file map. Valid: `<Button className="px-2 text-sm">`,
  `<Avatar className="ml-2 size-full">`, `<Row size="sm">` (Row is **not** in the
  registry — its `size` is row text-density, legitimate), `<LaunchControl size="icon">`,
  `<SelectTrigger size="sm">`.

### 3. Fix existing violations (Check B blast radius)

Three `<Button className="h-7 …">` in
`plugins/debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx`
(lines ~348, 387, 390). Resolve by removing the `h-7` and letting density drive
the height (wrap the surrounding cluster in `<ControlSizeProvider size="sm">` or a
`Bar` if a specific tier is wanted). A full `eslint` run after implementation is
the source of truth for the complete list (multi-line JSX openings a grep misses).

## Out of scope / honest limits (document in CLAUDE.md, like icon-auto)

- Tag-name match only: an aliased import of a registered primitive is not caught.
- Spread props (`<Badge {...rest} />`) can still smuggle `size` past the index
  signature — neither TS nor this rule sees it (accepted, pre-existing).
- A brand-new primitive that simply doesn't join the registry / doesn't intersect
  `DensityControlled` is not forced to participate; the registry is the opt-in
  membership list (same shape as every other `no-adhoc-*` banned set).

## Files to modify

**New**
- `plugins/primitives/plugins/css/plugins/control-size/lint/no-adhoc-density.ts`
- `plugins/primitives/plugins/css/plugins/control-size/lint/no-adhoc-density.test.ts`

**Edit**
- `plugins/primitives/plugins/css/plugins/control-size/lint/index.ts` (register rule + empty ignores)
- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size.tsx` (+`DensityControlled`)
- `plugins/primitives/plugins/css/plugins/ui-kit/web/index.ts` (re-export it)
- The 10 primitive prop types in the table above (`& DensityControlled`)
- `plugins/debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx` (3 height overrides)
- `plugins/primitives/plugins/css/plugins/control-size/CLAUDE.md` (document rule + registry + `DensityControlled` + honest scope)

## Verification

1. `./equin build` — typecheck (confirms the `& DensityControlled` tightening
   compiles everywhere) + eslint runs.
2. `bun test plugins/primitives/plugins/css/plugins/control-size/lint/no-adhoc-density.test.ts`
   — RuleTester valid/invalid cases pass.
3. `./equin check class-token-walk-in-sync` — confirms the copied
   `collectTokens` walk is byte-identical across the `no-adhoc-*` rules.
4. `./equin check type-check` (runs eslint) — passes with **zero** remaining
   `control-size/no-adhoc-density` violations (after the worktree-cleanup fix).
5. Negative smoke test: temporarily add `<Badge size="sm">` to any `.tsx`, confirm
   eslint flags `control-size/no-adhoc-density`, then revert.
6. `./equin check plugins-doc-in-sync` — CLAUDE.md edits stay in sync.
