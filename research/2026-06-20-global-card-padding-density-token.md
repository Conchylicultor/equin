# Card padding → density `p-card` token

## Context

`<Card>` hardcodes its padding as `PAD = "p-3"` (a module const predating the
density spacing ramp), so card padding is a fixed `0.75rem` that does **not**
scale with the Density preset (Compact / Cozy / Comfortable) the way every other
padded surface does. Switching to Compact tightens controls, rows, chips, gaps,
and insets — but cards stay puffy. Surfaced by
`research/2026-06-20-css-primitives-audit.md` §8.3.

A second, latent issue compounds it: the `surface/no-adhoc-surface` lint rule
already **advertises `p-card`** as the sanctioned padding escape for hand-rolled
raised surfaces (`no-adhoc-surface.ts:48`, `:114`, and the message in
`surface/CLAUDE.md`), and a passing test relies on it
(`no-adhoc-surface.test.ts:41`). But **`p-card` is never defined as a CSS
utility** anywhere — only `p-chip` / `p-control` / `p-row` exist in `app.css`. So
any developer who follows the lint's advice and writes `p-card` gets a no-op
class with **zero padding**. The token is dangling.

**Outcome:** introduce a real, density-scaling `p-card` semantic padding token
(mirroring the existing `p-row` / `p-control` / `p-chip` component-chrome
precedent), point `<Card>` at it, and thereby (a) make card padding tighten with
density and (b) make the lint-advertised `p-card` escape resolve to actual
padding. Single source of truth: one `--pad-card` density var behind both the
`<Card>` primitive and the hand-rolled-surface escape.

## Why a dedicated token (not the `p-md` ramp)

Cards are **component chrome**, exactly like rows / chips / controls — whose
padding lives in the semantic `--pad-*` density family (`p-row` etc.), *not* the
`<Inset>`/`<Stack>` ramp (`p-md`). Mirroring that precedent:

- keeps card padding **independently themeable** (the density customizer's
  `DensitySection` auto-renders one editable row per `densityGroup.schema` key —
  see `density/shared/config.ts:7`), instead of welding it to the `md` gap step;
- makes the dangling `p-card` lint escape **real** with one definition behind
  both `<Card>` and the escape;
- matches how `defineTokenGroup` already emits `padCard → --pad-card`
  (`theme-engine/core/define-token-group.ts:16` camelToKebab).

The audit's "`md` ≈ 0.75rem" named a value, not a mechanism; a dedicated token
delivers the density-scaling it asked for and fixes more.

## Changes

### 1. Declare the token — `plugins/ui/plugins/tokens/plugins/density/shared/group.ts`
Add to the `densityGroup` schema, next to the other `pad*` keys:
```ts
padCard: { default: "0.75rem", label: "Card padding" },
```
`defineTokenGroup` derives the `--pad-card` var automatically. Uniform (single
value, not X/Y) because card padding is symmetric — `p-3` was symmetric; an X/Y
pair would encode a false asymmetry axis no card uses. (Named structural reason
for deviating from the `padRowX`/`padRowY` shape.)

### 2. Seed all three presets — `plugins/ui/plugins/tokens/plugins/density/web/presets.ts`
Add `padCard` to `comfortablePreset`, `cozyPreset`, `compactPreset`, tracking the
`space-md` curve so cards tighten in lockstep with the `md` step:
| preset | padCard |
| --- | --- |
| comfortable | `0.75rem` (= current `p-3`, no visual change at default) |
| cozy | `0.625rem` |
| compact | `0.5rem` |

### 3. Define the utility — `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`
In the "Density padding utilities" block (after `p-row`, ~line 182):
```css
@utility p-card { padding: var(--pad-card); }
```

### 4. Point Card at it — `plugins/primitives/plugins/css/plugins/card/web/internal/card.tsx`
Replace `const PAD = "p-3"` (and its now-stale comment about `p-3` /
`no-adhoc-spacing`) with the inlined token in the `cn(...)`:
```ts
className={cn("p-card", interactive && HOVER, selected && SEL, className)}
```
`p-card` is word-valued, so `no-adhoc-spacing` allows it inline (its `PAD` regex
only fires on numeric/arbitrary steps — `no-adhoc-spacing.ts`); the const
indirection that hid `p-3` is no longer needed. Consumers still override padding
via `className` (tailwind-merge resolves the conflict).

### 5. Docs (kept in sync by `plugins-doc-in-sync`)
- `card/CLAUDE.md` — change the two `p-3` mentions ("layers on `p-3`", "Default
  chrome is `… p-3`") to `p-card` and note it scales with density.
- `surface/CLAUDE.md` — the `p-card` escape is now real; optionally note it
  density-scales (wording already references it as a token).

### 6. Regen — `./equin build`
Codegen rewrites
`plugins/framework/plugins/tooling/plugins/checks/core/token-group-vars.generated.ts`
to add `--pad-card` to the `density` group list. (No DB migration; no registry
change — `padCard` is a schema key, not an export.)

## Critical files
- `plugins/ui/plugins/tokens/plugins/density/shared/group.ts` — token decl
- `plugins/ui/plugins/tokens/plugins/density/web/presets.ts` — 3 preset seeds
- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css` — `@utility p-card`
- `plugins/primitives/plugins/css/plugins/card/web/internal/card.tsx` — consume `p-card`
- `plugins/primitives/plugins/css/plugins/card/CLAUDE.md` + `…/surface/CLAUDE.md` — doc sync

## Verification
1. `./equin build` — regenerates `token-group-vars.generated.ts`, rebuilds
   CSS/frontend/server. Confirm it includes `--pad-card` under `density`.
2. `./equin check` — must pass:
   - `type-check` (incl. `no-adhoc-spacing` — `p-card` allowed; `no-adhoc-surface`
     test at `:41` still green now that the escape resolves),
   - `token-group-vars`-in-sync, `plugins-doc-in-sync`.
3. Visual density sweep with the e2e helper — a card-heavy surface (e.g. the Home
   app-cards grid or `studio/explorer`) at Comfortable vs Compact:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/home --out /tmp/card-comfortable
   ```
   Switch density via the theme customizer (floating action bar → Appearance →
   Density, or Settings → Appearance), re-shoot, and confirm card padding visibly
   tightens (0.75 → 0.5rem) while Comfortable is pixel-identical to today.
4. Confirm the density customizer's `DensitySection` now shows a **"Card padding"**
   row (auto-derived from the schema) and that editing it re-themes cards live.
5. Sanity-check a hand-rolled `p-card` escape now paints padding (it previously
   resolved to nothing) — e.g. inspect any element using the lint escape, or add a
   throwaway `<div className="rounded-md border bg-card p-card">` in devtools.
