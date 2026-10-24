# Chip primitives: stay role-specific, route single-line core through `region-line`

**Date:** 2026-06-15 · **Category:** global (primitives / CSS composition)

## Context

`Badge`, `ToggleChip`, and `LinkChip` each independently re-roll a chip shell
(`inline-flex items-center gap-xs … p-chip … [&_svg]:icon-auto`). The duplication
*looks* like it wants a shared `Chip` base. The open question this doc settles:
**is the remaining shared chip-shell worth a `Chip` base primitive (with
radius/padding/baseline props the three compose), or is the divergence essential
enough that they should stay three role-specific primitives?**

Decision: **keep three role-specific primitives — do NOT build a `Chip` base.**
The only genuinely shared invariant is the *single-line shell*
(`items-center` + `whitespace-nowrap`), which the `region-line` @utility already
owns. Above that layer the three diverge on role-essential axes, so a base would
be a flag bag, not an abstraction. Secondary cleanup: route `Badge` and
`ToggleChip`'s single-line core through `region-line` (matching the recent
`CollapsibleTrigger`/`CollapsibleCard` refactor), with `LinkChip` documented as
the deliberate truncation exception.

## What the three actually share vs. diverge on

Verbatim current shells (confirmed in source):

- **Badge** (`badge.tsx:53`): `inline-flex items-center gap-xs whitespace-nowrap rounded-md p-chip font-medium tabular-nums [&_svg:not([class*='size-'])]:icon-auto`
- **ToggleChip** (`toggle-chip.tsx:77`): `inline-flex items-center gap-xs whitespace-nowrap rounded-full font-medium transition-colors [&_svg:not([class*='size-'])]:icon-auto` + `control-xs p-chip` / `control-sm p-control`
- **LinkChip** (`link-chip.tsx:31`): `inline-flex max-w-full items-center gap-xs rounded-md bg-muted p-chip align-baseline text-caption text-primary hover:bg-muted/80 hover:underline [&_svg:not([class*='size-'])]:icon-auto` + inner `<span className="truncate">`

| Axis | Badge | ToggleChip | LinkChip |
|---|---|---|---|
| Single-line core | `items-center` + `whitespace-nowrap` | `items-center` + `whitespace-nowrap` | `items-center`, **no nowrap** (inner `truncate`) |
| Radius | `rounded-md` | `rounded-full` | `rounded-md` |
| Padding | `p-chip` | `p-chip`/`p-control` (control-height system) | `p-chip` |
| Color | 6 semantic variants + `colorClass` | solid/ghost × active/inactive | hardcoded `bg-muted text-primary` |
| Width/baseline | — | — | `max-w-full align-baseline` |
| Interactivity | none (static label) | `transition-colors`, `disabled:*`, `aria-pressed`, `useControlSize()` | always `<button>`, hover underline |
| Children render | `{children}` direct | `{children}` direct | inner `<span className="truncate">` |
| Polymorphism | `as` (span default) | `as` (button default) | none (always button) |
| Leading slot | `icon` | `icon` | `leading` |

The true shared remainder after `region-line` factors the single-line core is
just `gap-xs p-chip [&_svg]:icon-auto` + "render leading then children" — ~3
classes. Everything else is role-essential.

## Why no `Chip` base

A `Chip` base parameterized for all three would need props for: `radius`
(`md`|`full`), `nowrap` (false for LinkChip), `baseline`, padding override
(ToggleChip's `p-control` is tied to its control-height tokens, not `p-chip`), a
truncation slot (LinkChip wraps children in a `truncate` span; the others render
directly), `as` polymorphism, plus three disjoint color systems left to each
caller anyway. That base owns no policy — it just forwards flags. Adding the next
chip role means adding the next flag and regression-testing the other two. This
is exactly the anti-pattern the `css` skill warns against: space/shape "negotiated
per child by sprinkling props" instead of a mode where the bug is unrepresentable.

Three ~30-line primitives, each readable top-to-bottom as one role, with the one
real cross-cutting invariant (single-line) living in `region-line` where lint
already enforces it (`no-clip-without-nowrap` treats `region-line` as nowrap-safe),
is the cleaner design. It matches the skill's "write the role" mental model and
the established sibling-primitive pattern (`selection-indicator`, `status-dot`,
`row` are all role-specific rather than collapsed into a config base).

`region-line` is the correct shared layer and **already exists**
(`plugins/primitives/plugins/ui-kit/web/theme/app.css:164`:
`@utility region-line { @apply items-center whitespace-nowrap; }`), already
consumed by `bar`, `row`, `collapsible`, and `collapsible-card`. The chip-shell
layer above it is genuinely role-divergent.

## The cleanup (Decision + region-line)

Route the single-line core of the two nowrap chips through `region-line`, so the
`items-center whitespace-nowrap` pair lives in exactly one place — consistent with
the recent `refactor(primitives): route CollapsibleTrigger & CollapsibleCard
single-line core through region-line` commit.

**1. `plugins/primitives/plugins/badge/web/internal/badge.tsx:53`**
Replace `inline-flex items-center gap-xs whitespace-nowrap rounded-md …` with
`inline-flex region-line gap-xs rounded-md …` (drop the now-redundant
`items-center whitespace-nowrap`; keep everything else — `font-medium`,
`tabular-nums`, `p-chip`, sizes, color, icon-auto — byte-for-byte).

**2. `plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx:77`**
Replace `inline-flex items-center gap-xs whitespace-nowrap rounded-full …` with
`inline-flex region-line gap-xs rounded-full …`. Leave the `disabled:*`,
`transition-colors`, control-size branches, variant map, and aria logic untouched.

**3. `LinkChip` — no code change; document the exception.**
LinkChip intentionally does **not** use `region-line`: it omits `whitespace-nowrap`
at the root and truncates via its inner `<span className="truncate">` for
inline-in-text use. Add a one-line comment at `link-chip.tsx:31` noting this is the
deliberate truncation exception to the chip single-line convention so a future
agent doesn't "consistency-fix" it into breakage.

**4. Capture the decision in prose.** Add a short note to
`plugins/primitives/plugins/badge/CLAUDE.md` (and/or a shared sentence echoed in
`toggle-chip` and `link-chip` CLAUDE.md) recording: the three chips stay
role-specific; their shared single-line core is `region-line`; a `Chip` base was
considered and rejected because the chip-shell layer above `region-line` diverges
on role-essential axes. This is the durable home for the decision (per repo rule:
how-it-works knowledge goes in CLAUDE.md, not memory).

No new files, no new exports, no API changes — purely an internal class
substitution plus docs. The `no-clip-without-nowrap`, `badge/no-adhoc-chip`, and
`no-adhoc-bar` lint rules already understand `region-line` as nowrap-safe, so this
stays green.

## Verification

1. `./equin build` from the worktree — must complete (regenerates docs,
   typechecks, runs `./equin check`).
2. `./equin check` — confirm `type-check`, `eslint` (incl.
   `no-clip-without-nowrap`, `badge/no-adhoc-chip`), and `plugins-doc-in-sync`
   pass.
3. Visual spot-check at `http://<worktree>.localhost:9000`:
   - A `Badge` (e.g. attempt-status chip in the Tasks pane) — still `rounded-md`,
     non-wrapping, correct padding/icon size.
   - A `ToggleChip` / `SegmentedControl` (e.g. stats scope toggle, filter chips) —
     still `rounded-full`, correct height at each density, hover/active states,
     no wrap.
   - A `LinkChip` (e.g. an attempt/task link inside conversation markdown) —
     still baseline-aligned inline and still truncates with `…` when narrow.
   Use `bun e2e/screenshot.mjs` if a before/after capture is wanted.

## Files

- `plugins/primitives/plugins/badge/web/internal/badge.tsx` — line 53 shell
- `plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx` — line 77 shell
- `plugins/primitives/plugins/link-chip/web/internal/link-chip.tsx` — line 31 (comment only)
- `plugins/primitives/plugins/ui-kit/web/theme/app.css:164` — `region-line` (reference, unchanged)
- `plugins/primitives/plugins/{badge,toggle-chip,link-chip}/CLAUDE.md` — decision note
