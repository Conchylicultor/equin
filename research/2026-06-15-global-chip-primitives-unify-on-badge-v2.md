# Chip primitives: unify on Badge (one shell, role-named wrappers)

**Date:** 2026-06-15 · **Category:** global (primitives / CSS composition) · **Supersedes:** `2026-06-15-global-chip-primitives-stay-role-specific.md`

## Context

`Badge`, `ToggleChip`, and `LinkChip` each re-roll the same chip shell
(`inline-flex items-center gap-xs … p-chip … [&_svg]:icon-auto`) and then drift
on radius, padding, truncation, alignment, and color. The v1 doc argued the
divergence was role-essential and the three should stay separate. **That was
wrong.** On review, almost every divergence is accidental drift, not role
essence — and the inconsistency is itself the problem to fix.

**Decision: unify on Badge as the single canonical chip.** Badge owns the one
shell. `LinkChip` and `ToggleChip` keep their public APIs (zero consumer churn)
but become thin wrappers that *compose* Badge — LinkChip = "a clickable badge,"
ToggleChip = "a badge that toggles, height-matched to buttons." Three duplicated
shells → one.

## Why each divergence is drift, not essence

Confirmed against real source and all consumers:

| Divergence | Verdict |
|---|---|
| **Color** (Badge variants / ToggleChip active-pair / LinkChip link-color) | Not structural — all fit Badge's existing opaque `colorClass` hatch. Each role computes its own. |
| **`mono`** (LinkChip) | Opt-in font choice. → universal `mono` prop. |
| **Inner `truncate` span** (LinkChip) | A chip is a content leaf; leaves truncate. Badge today is `whitespace-nowrap` with no max-width → it *overflows* instead, which is the wrong leaf behavior. → universal structure (root `max-w-full`, label in `truncate` span, leading rigid). Fixes a latent bug. |
| **`align-baseline`** (LinkChip) | `vertical-align` is ignored on flex children and correct on inline-in-text boxes → safe to bake into the base (free where it doesn't apply, correct where it does). |
| **`active` + aria-pressed/disabled** (ToggleChip) | `active` just selects which `colorClass`; aria/disabled flow through `as="button"` + passthrough. Not structural. |
| **Radius** (`rounded-md` vs `rounded-full`) | The one *deliberate* axis (status badge = rounded-rect; filter/toggle = pill). → expose as a `shape` axis, not collapse. |
| **Control-height** (`control-xs/sm` + `p-control`, ToggleChip) | Genuinely ToggleChip's own — a toggle sits *among buttons*, so it height-matches them. Stays in the ToggleChip wrapper, not Badge. |
| **`SegmentedControl`** (ToggleChip) | A real single-select radio-group abstraction. Kept. |

What's left that is *truly* role-specific is only **behavior**: ToggleChip's
button-height matching and `SegmentedControl`. Everything else unifies.

## Target design

### Badge = the canonical chip (the one shell)

`plugins/primitives/plugins/badge/web/internal/badge.tsx`. Keep `variant` /
`colorClass` / `size` / `icon` / `as` / passthrough. Changes:

- Route the single-line core through `region-line` (already exists,
  `ui-kit/web/theme/app.css:164`): `inline-flex region-line gap-xs …` replaces
  `inline-flex items-center gap-xs whitespace-nowrap …`. (Matches the recent
  `CollapsibleTrigger`/`CollapsibleCard` refactor.)
- **Universal truncation structure:** root gains `max-w-full`; children render
  inside `<span className={cn("truncate", mono && "font-mono")}>`; the leading
  `icon` stays a rigid sibling. (LinkChip's exact existing structure, generalized.)
- **`mono?: boolean`** — monospace label.
- **`shape?: "rounded" | "pill"`** (default `"rounded"` → `rounded-md`; `"pill"`
  → `rounded-full`). Replaces the hardcoded `rounded-md`.
- **Baseline-safe alignment:** add `align-baseline` to the base (harmless on flex
  children, correct inline) — verify visually.

Badge keeps `p-chip` (label padding). It does **not** learn control-heights —
that stays a ToggleChip concern.

### LinkChip → thin Badge wrapper (API unchanged)

`plugins/primitives/plugins/link-chip/web/internal/link-chip.tsx`. Keep its
public props (`onClick`, `leading`, `mono`, `title`, `className`, `children`) so
its 11 consumers don't change. Body becomes roughly:

```tsx
export function LinkChip({ onClick, leading, mono, title, className, children }: LinkChipProps) {
  return (
    <Badge
      as="button" type="button" onClick={onClick} title={title} mono={mono}
      icon={leading}
      colorClass="bg-muted text-primary hover:bg-muted/80 hover:underline"
      className={className}
    >
      {children}
    </Badge>
  );
}
```

No duplicated shell; truncation/baseline/mono come from Badge. (`leading` maps to
Badge's `icon`.) Link color + hover-underline + clickability stay LinkChip's
identity, expressed via `colorClass`.

### ToggleChip → thin Badge wrapper + control behavior (API unchanged)

`plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx`. Keep
`active` / `variant` (solid|ghost) / `size` / `icon` / `as` / `disabled` /
passthrough and `SegmentedControl` unchanged so its 23 consumers don't change.
Render `<Badge>` for the shell, supplying:

- `shape="pill"`,
- `colorClass={active ? VARIANT_CLASS[variant].active : …inactive}` (the existing
  pair map),
- the control-height class for the chosen size (`control-xs p-chip text-2xs` /
  `control-sm p-control text-caption`) via `className` (overrides Badge's `p-chip`
  through `cn()`),
- `as` / `disabled` / `aria-pressed` flow through Badge's passthrough.

`useControlSize()`, the active/inactive maps, aria, and `SegmentedControl` stay in
this wrapper — that's ToggleChip's real (behavioral) identity.

### Dependency direction

`link-chip` and `toggle-chip` gain a dependency on `badge` (cross-plugin import
of `@plugins/primitives/plugins/badge/web` — a legal runtime-barrel import; DAG
stays acyclic since Badge imports neither). `filter-chips` and `SegmentedControl`
keep wrapping `ToggleChip` — unchanged.

## Open taste call (not correctness)

**Radius/`shape`.** Recommended: keep the pill-vs-rounded distinction as a
deliberate vocabulary (`shape="pill"` for toggles/filters, default rounded for
labels). If you'd rather have *total* visual consistency, collapse to a single
radius and drop the `shape` axis — say the word and the plan loses one prop.

## Verification

1. `./equin build` from the worktree, then `./equin check`
   (`type-check`, `eslint` incl. `no-clip-without-nowrap` + `badge/no-adhoc-chip`,
   `plugins-doc-in-sync`, `plugin-boundaries`) must pass.
2. Visual regression pass (the truncation/baseline/region-line changes touch all
   chip consumers), `http://<worktree>.localhost:9000`:
   - **Badge** — attempt-status chip (Tasks pane), conversation category/status
     chips: correct color, `rounded-md`, no clipping on short labels, and a long
     label now truncates with `…` instead of overflowing.
   - **LinkChip** — attempt/task link inside conversation markdown: still inline,
     baseline-aligned, truncates when narrow, `mono` ids still monospaced.
   - **ToggleChip / SegmentedControl** — stats cost "Singularity only" toggle,
     enum/bool field filters, surface placement control: still `rounded-full`,
     correct height beside buttons at each density, hover/active/disabled states,
     radio semantics intact.
   Use `bun e2e/screenshot.mjs --url … --click …` for before/after on a toggle.
3. Targeted check that `cn()` override works: confirm ToggleChip's
   `control-sm p-control rounded-full` actually wins over Badge's `p-chip` +
   `shape` radius in the rendered class string (inspect one rendered chip).

## Files

- `plugins/primitives/plugins/badge/web/internal/badge.tsx` — shell becomes the base (region-line, max-w-full + truncate span, `mono`, `shape`, baseline)
- `plugins/primitives/plugins/link-chip/web/internal/link-chip.tsx` — compose Badge
- `plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx` — compose Badge; keep control-height + `SegmentedControl`
- `plugins/primitives/plugins/ui-kit/web/theme/app.css:164` — `region-line` (reference, unchanged)
- `plugins/primitives/plugins/{badge,link-chip,toggle-chip}/CLAUDE.md` — record: Badge is the canonical chip; the other two compose it; what each role adds
```
