# ToggleChip primitive — unifying hand-rolled interactive toggle chips

## Context

A follow-up to the Badge / LinkChip primitive work
([`2026-06-03-global-badge-chip-primitive.md`](./2026-06-03-global-badge-chip-primitive.md),
"Out of scope" section). That task unified ~22 *display* chips (status/category/count/label
badges + inline link chips) but deliberately deferred a second cluster: chip-shaped
**interactive toggle controls**. These remain hand-rolled and visually divergent:

- **8 stats toggle sites** across `plugins/stats/**` — all copy the same
  `rounded-full border px-3 py-1 text-xs transition-colors` button with a
  `bg-primary` active / `bg-background` ghost inactive treatment, with small per-site
  drift (`shrink-0`, `mt-3`, `line-through`). Four of them are near-identical
  "bucket selector" segmented radio groups.
- **Notification filter chips** (`plugins/notifications/web/components/bell-button.tsx`) —
  a `rounded-full` ghost toggle with `bg-accent` active, built from a raw template literal.
- An **existing `filter-chips` primitive** (`FilterChip`/`FilterGroup`/`useChipFilter`,
  5 consumers) whose `FilterChip` renders the *exact same ghost semantics* as the
  notification chips — but with its own pre-token geometry (`rounded`, `px-2.5 py-1`).
  Two primitives for one concept is the smell we're removing.

This per-component divergence is the same problem Badge solved one altitude down. The
fix mirrors that work: one `ToggleChip` primitive that owns the geometry (token-anchored,
single radius, fixed `variant` enum — no `cva`), with each consumer keeping only its own
state logic. **Outcome:** every interactive toggle/segmented control in the app renders
through one primitive, and adding a new toggle is trivial.

**Out of scope (confirmed with user — different concepts, not toggles):**
- The bell **unread-count badge** (positioned circular numeric overlay) — stays hand-rolled.
- The prompt-template **split-button** (two-action control, single site) — stays hand-rolled.

**Decisions confirmed with the user:**
- **Scope:** ToggleChip only (the count badge and split-button are not folded in).
- **Radius:** `rounded-full` (pill) — faithful to 9/10 current interactive sites and the
  "toggle = pill" convention. Intentionally diverges from Badge's `rounded-md` (interactive
  control vs static label); document the divergence in the plugin description.
- **filter-chips:** re-base `FilterChip` onto `ToggleChip variant="ghost"`; keep
  `useChipFilter` / `FilterGroup` in the `filter-chips` plugin (it gains a `dependsOn`
  edge to `toggle-chip`). The 5 existing consumers shift to the unified pill geometry.

## Design principles applied

- **Mirror precedent (Badge).** Same file shape: `web/internal/toggle-chip.tsx` +
  `web/index.ts` barrel + `package.json`. `cn()` from `@/lib/utils`, a `VARIANT_CLASS`
  map with boolean conditions inside `cn()` (never `cva`), `[key: string]: unknown`
  passthrough, `as` polymorphic, `export default {...} satisfies PluginDefinition`.
- **Collection–consumer separation.** The primitive owns geometry + the two variant
  color treatments. Each consumer keeps only its own `active` boolean and `onClick`.
  No consumer re-hardcodes the chip geometry.
- **Minimal knobs.** Two variants (`solid`, `ghost`), two sizes (`md`, `sm`). No
  `colorClass` escape hatch — the color is a two-state (active/inactive) *pair*, which a
  single-string hatch can't express; residual one-offs (`shrink-0`, `mt-3`, `line-through`)
  ride on `className` (appended last). Add knobs only when a real site needs one.
- **One radius.** `rounded-full` everywhere (the user's choice), replacing the existing
  mix of `rounded-full` / `rounded`.

## The primitive

### `ToggleChip` — `plugins/primitives/plugins/toggle-chip/web/`

```
plugins/primitives/plugins/toggle-chip/
├── package.json                 # @singularity/plugin-primitives-toggle-chip
└── web/
    ├── index.ts                 # re-exports + default PluginDefinition
    └── internal/toggle-chip.tsx # ToggleChip + SegmentedControl
```

```tsx
export type ToggleChipVariant = "solid" | "ghost";
export type ToggleChipSize = "sm" | "md";

const VARIANT_CLASS: Record<ToggleChipVariant, { active: string; inactive: string }> = {
  // stats look: filled primary when on, bordered background when off
  solid: {
    active: "border border-primary bg-primary text-primary-foreground",
    inactive:
      "border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
  },
  // filter look: accent fill when on, transparent ghost when off
  ghost: {
    active: "bg-accent text-accent-foreground",
    inactive: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  },
};

export interface ToggleChipProps {
  active: boolean;
  variant?: ToggleChipVariant;   // default "solid"
  size?: ToggleChipSize;         // default "md"
  icon?: React.ReactNode;        // leading icon, rendered before children
  as?: React.ElementType;        // default "button"; "a" for link-style chips
  disabled?: boolean;
  className?: string;            // escape hatch: shrink-0, mt-3, line-through, etc.
  title?: string;
  children: React.ReactNode;
  [key: string]: unknown;        // onClick, href, type, … passthrough (matches Badge)
}
```

Render body (mirrors Badge's `cn()` ordering: base → size → variant → className). Note
the conditional a11y/HTML attrs so `as="a"` doesn't receive `type`/`disabled`/`aria-pressed`:

```tsx
const isButton = As === "button";
return (
  <As
    type={isButton ? "button" : undefined}
    disabled={isButton ? disabled : undefined}
    aria-pressed={isButton ? active : undefined}
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full font-medium transition-colors",
      "disabled:opacity-50 disabled:pointer-events-none",
      size === "sm" && "text-2xs px-2 py-0.5",
      size === "md" && "text-xs px-3 py-1",
      active ? VARIANT_CLASS[variant].active : VARIANT_CLASS[variant].inactive,
      className,
    )}
    {...rest}
  >
    {icon}
    {children}
  </As>
);
```

**Padding:** hardcode `px-3 py-1` (md) / `px-2 py-0.5` (sm) — NOT `p-chip`/`p-control`.
`p-chip` (2px y) is too tight for a click target; `p-control` (6px y) would grow every
stats chip by 2px and shift the panel. Literal padding preserves the exact current
geometry (zero visual regression on the 8 stats sites). `md` = the stats geometry,
`sm` = the notification-chip geometry. (If strict token-anchoring is later wanted, add a
`p-toggle` utility to `web-core/web/theme/app.css` = `4px 12px` — deferred, not in this task.)

### `SegmentedControl` — co-located in the same file

Four sites are genuine copy-paste: a `flex flex-wrap gap-1.5` wrapper `.map`-ing over
`BUCKETS` and rendering a `solid` ToggleChip with `active = value === id`. A small group
helper removes that 4× duplication and adds proper `radiogroup`/`radio` a11y the
hand-rolled versions lack.

```tsx
export interface SegmentedOption<T extends string> {
  id: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
}
export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  variant?: ToggleChipVariant;   // default "solid"
  size?: ToggleChipSize;
  className?: string;            // wrapper override (e.g. lines-charts "mt-3")
}
```

Renders `<div role="radiogroup" className={cn("flex flex-wrap gap-1.5", className)}>`
mapping each option to a `<ToggleChip role="radio" active={opt.id === value}
onClick={() => onChange(opt.id)} icon={opt.icon} title={opt.title}>{opt.label}</ToggleChip>`.

## Migration map

Variant legend: **S** = `solid`, **G** = `ghost`. `[SC]` = use `SegmentedControl`.
All divergences (`shrink-0`, `mt-3`, `line-through`) ride on `className`; `title` rides
the rest-spread (same as Badge). No new props needed.

| # | File:line | Shape | Migration |
|---|-----------|-------|-----------|
| 1a | `stats/web/components/stats-panel.tsx:27` | bool | `S` `<ToggleChip active={showEmptyDays} onClick title>` |
| 1b | `stats-panel.tsx:22` (Profiling `<a>`) | non-interactive link, inactive look | `S` `<ToggleChip as="a" href=… active={false}>` (kills the hand-rolled literal; `aria-pressed`/`type` auto-suppressed for `<a>`) |
| 2a | `commits/.../commits-section.tsx:21` "By category" | bool + `shrink-0` | `S` `… className="shrink-0"` |
| 2b | `commits-section.tsx:32` "Filter rebases" | bool | `S` (preserve `title` + any `eslint-disable` on the ternary) |
| 3 | `commits/.../rate-chart.tsx:102` | segmented 5 | `[SC]` `<SegmentedControl options={BUCKETS} value={bucket} onChange={setBucket} />` |
| 4 | `commits/.../commits-category-charts.tsx:282` | segmented 5 | `[SC]` (same) |
| 5a | `commits/.../lines-charts.tsx:476` "By type" | bool + `shrink-0` | `S` `… className="shrink-0"` |
| 5b | `lines-charts.tsx:496` | segmented 5, wrapper `mt-3` | `[SC]` `… className="mt-3"` |
| 6 | `commits/.../excluded-path-toggles.tsx:29` | multi-select, inactive `line-through` | keep the `.map`; each → `S` `<ToggleChip active={item.enabled} onClick title className={cn(!item.enabled && "line-through")}>` |
| 7 | `cost/.../scope-toggle.tsx:7` | bool | `S` `<ToggleChip active={singularityOnly} onClick title>` |
| 8 | `pushes/.../pushes-section.tsx:19` | segmented 3 | `[SC]` `<SegmentedControl options={BUCKETS} value={bucket} onChange={setBucket} />` |
| B | `notifications/.../bell-button.tsx:176` | ghost, sm, `shrink-0` | `G` `<ToggleChip variant="ghost" size="sm" active={typeFilter === chip} onClick className="shrink-0">` |

Notes:
- **`excluded-path-toggles` stays a `.map` of individual chips** (multi-select, not
  single-select) — not a `SegmentedControl`.
- **bell-button's filter-row container** (`flex gap-1 px-3 py-1.5 overflow-x-auto border-b`)
  stays hand-rolled — it's a horizontal-scroll layout, NOT the `filter-chips` `FilterGroup`
  (which renders a `label:` prefix). Only the inner chip buttons migrate.

## Re-base `filter-chips`

`FilterChip`'s active/inactive classes are line-for-line identical to `ghost`. Re-base it
onto the shared primitive; keep `useChipFilter` / `FilterGroup` where they are.

`plugins/primitives/plugins/filter-chips/web/internal/filter-chips.tsx`:

```tsx
import { ToggleChip } from "@plugins/primitives/plugins/toggle-chip/web";

export function FilterChip({ active, onClick, children }: FilterChipProps) {
  return (
    <ToggleChip variant="ghost" active={active} onClick={onClick}>
      {children}
    </ToggleChip>
  );
}
```

This shifts the 5 existing consumers (queue-view, calls-view, catalog-view, config-nav,
community-browser) to `rounded-full` + `px-3 py-1`. The padding delta is ~2px; the radius
becomes a full pill (consistent with the user's radius choice). Capture before/after
screenshots of these 5 for sign-off.

## Critical files

**New:**
- `plugins/primitives/plugins/toggle-chip/package.json` — `@singularity/plugin-primitives-toggle-chip`, `private`, `0.0.1`, with `description`.
- `plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx` — `ToggleChip` + `SegmentedControl`.
- `plugins/primitives/plugins/toggle-chip/web/index.ts` — barrel (re-export both components + their types; default `satisfies PluginDefinition` with `contributions: []`).

**Modified (re-base + 10 migration sites):**
- `plugins/primitives/plugins/filter-chips/web/internal/filter-chips.tsx`
- `plugins/stats/web/components/stats-panel.tsx`
- `plugins/stats/plugins/commits/web/components/{commits-section,rate-chart,commits-category-charts,lines-charts,excluded-path-toggles}.tsx`
- `plugins/stats/plugins/cost/web/components/scope-toggle.tsx`
- `plugins/stats/plugins/pushes/web/components/pushes-section.tsx`
- `plugins/notifications/web/components/bell-button.tsx`

## Plugin wiring

- Only `web/index.ts` is cross-plugin importable; consumers use
  `import { ToggleChip, SegmentedControl } from "@plugins/primitives/plugins/toggle-chip/web"`.
  `internal/` is private.
- `filter-chips` gains a `dependsOn` edge to `toggle-chip` (DAG-safe; toggle-chip depends
  only on web-sdk types + `@/lib/utils`).
- **No manual registry/codegen edits.** `web.generated.ts`, CLAUDE.md autogen blocks, and
  the docs are regenerated by `./equin build` (filesystem-driven, like Badge which
  sits in the registry with `dependsOn: []`).
- Run `bun install` from repo root once to register the new workspace.

## Verification

1. `bun install` (repo root), then `./equin build` from the worktree — confirm the
   build succeeds, the new primitive appears in the regenerated registry, and the app boots
   at `http://att-1780525818-xepg.localhost:9000`.
2. `./equin check` — must pass `eslint`, `--plugin-boundaries` (toggle-chip imports
   barrel-only; the `filter-chips → toggle-chip` edge is legal & acyclic), and
   `plugins-doc-in-sync` / `plugins-registry-in-sync` (green after the build regen).
3. Before/after screenshots with `bun e2e/screenshot.mjs`:
   - **Stats panel** — header (Profiling link + Show empty days), commits section (By
     category / Filter rebases, bucket selector, excluded-path `line-through` chips), lines
     section (By type + bucket), pushes section (bucket). Confirm pills look identical and
     inactive excluded-paths still strike through.
   - **Notification bell dropdown** — open the bell; confirm the All/Errors/types filter
     row renders as ghost `sm` pills with active highlight and horizontal scroll intact.
   - **The 5 filter-chips consumers** — queue-view, claude-cli-calls, forge/catalog,
     config_v2/settings nav, tweakcn community-browser. Confirm the `rounded`→`rounded-full`
     shift reads well.
4. Grep that no migrated file still hand-rolls the toggle markup:
   `rg -n "rounded-full border .*px-3 py-1 .*text-xs" plugins/stats plugins/notifications`
   returns only (if anything) intentional non-toggle markup — the toggle buttons are gone.

## Optional structural follow-up (recommended, separate PR)

Mirror the Badge follow-up: an ESLint rule under
`plugins/primitives/plugins/toggle-chip/lint/` that flags inline JSX with the toggle
signature (`rounded-full` + `border` + a `bg-primary`/`bg-accent` active branch on a bare
`<button>`), steering authors to `ToggleChip`. Heuristic/noisy — propose after the
migration settles, not part of the core change.
