# Standardize control (button/chip) sizing across the codebase

## Context

Button size and theme are inconsistent across surfaces — even within a single row. Examples:
- Prompt bar: the "blocked / blocking" deps control is smaller than its neighbors.
- Task view: "Add folder as dep" (a real `Button size="xs"`) is taller than "+ Prerequisite" (a raw `<button>` with a hand-written class string).

**Root cause: two parallel sizing models that can never agree.**
- `Button` (`plugins/framework/plugins/web-core/web/components/ui/button.tsx`) uses CVA with **hardcoded fixed heights** (`h-6/h-7/h-8/h-9`).
- Chip/row primitives (`ToggleChip`, `LinkChip`, `Badge`, `Row`) use **density-token padding** (`p-chip`/`p-control`/`p-row`) with **no fixed height** (height = padding + line-height). These shift with the density preset; buttons don't.

On top of that, three escape hatches let any author bypass the system entirely:
1. `triggerClassName: string` on `TaskDraftPopover` (caller hand-writes the whole button style).
2. `buttonVariants` applied to a `<div>` with raw `<button>` children (`dependencies-button.tsx`).
3. Hand-rolled `h-7 rounded-full` pills via `DropdownMenuTrigger` className / raw `<div>+<button>` (`launch-prompts-button.tsx`, `prompt-template-chips.tsx`).

No amount of fixing call sites helps while the two models measure height differently. **Intended outcome:** one density-aware size scale that every interactive control shares, sanctioned primitives for every real composition shape so authors never hand-roll, and a lint rule that makes divergence fail `./equin check`.

## Design overview (3 layers)

### Layer 1 — One density-aware size scale, defined once

The one sizing axis that genuinely *diverged* is **height**: Button used fixed `h-*`, chips derived height from padding. So **height is the single source of truth** — a density-var-backed `@utility`. Everything else (padding, font, gap, radius, color, corner-clamp, icon-size, icon-asymmetric padding) stays as ordinary per-primitive classes, unchanged. (Refinement adopted after reading the files: putting `padding-inline` in the utility would fight Button's `px-*` + `has-data-[icon=…]:pr-*` overrides via unpredictable utility-layer ordering; bundling font/gap causes specificity fights with `text-*`. Height-only sidesteps all of it and keeps existing buttons pixel-identical.)

**1a. Extend the density token group** — `plugins/ui/plugins/tokens/plugins/density/shared/group.ts`. Add 4 keys (auto-derived CSS vars via camelToKebab, e.g. `controlHeightSm`→`--control-height-sm`):
```
controlHeightXs/Sm/Md/Lg
```

**1b. Add preset values** — `plugins/ui/plugins/tokens/plugins/density/web/presets.ts`, all 3 presets, light+dark via `both()`. Comfortable = today's Button heights, so unspecified callers stay pixel-identical:

| size | comfortable   | cozy          | compact     |
|------|---------------|---------------|-------------|
| xs   | 1.5rem (24)   | 1.375rem (22) | 1.25rem (20)|
| sm   | 1.75rem (28)  | 1.625rem (26) | 1.5rem (24) |
| md   | 2rem (32)     | 1.875rem (30) | 1.75rem (28)|
| lg   | 2.25rem (36)  | 2.125rem (34) | 2rem (32)   |

Keep `pad-chip-*`/`pad-control-*`/`pad-row-*` untouched (Badge/Row keep them). Horizontal padding stays static per-primitive for now (not density-coupled in v1).

**1c. Add `@utility` blocks** — `plugins/framework/plugins/web-core/web/theme/app.css` (bottom, next to `p-chip` etc.; add matching `:root`/`.dark` defaults right after the `--pad-row-y` lines in both blocks). Height-only; the square icon variant adds width:
```css
@utility control-xs { height: var(--control-height-xs); }
@utility control-sm { height: var(--control-height-sm); }
@utility control-md { height: var(--control-height-md); }
@utility control-lg { height: var(--control-height-lg); }
@utility control-icon-xs { height: var(--control-height-xs); width: var(--control-height-xs); }
@utility control-icon-sm { height: var(--control-height-sm); width: var(--control-height-sm); }
@utility control-icon-md { height: var(--control-height-md); width: var(--control-height-md); }
@utility control-icon-lg { height: var(--control-height-lg); width: var(--control-height-lg); }
```
- Class names must be **literal** in source (Tailwind v4 `@source` scanning) — never `control-${size}` interpolation.

**1d. Export `ControlSize` type** (`"xs"|"sm"|"md"|"lg"`) from web-core next to Button, so Button/ToggleChip/LinkChip/ButtonGroup share one enum. Share the *type*, not a runtime class-map (primitives don't share the same static recipe).

**1e. Rewrite Button CVA** — `button.tsx`. Swap ONLY the height classes; leave everything else byte-for-byte identical (highest-risk step — bug mode is silent visual regression):
- `h-6`→`control-xs`, `h-7`→`control-sm`, `h-8`→`control-md`, `h-9`→`control-lg`.
- `size-6`→`control-icon-xs`, `size-7`→`control-icon-sm`, `size-8`→`control-icon-md`, `size-9`→`control-icon-lg` (these are square; the icon utility sets width=height).
- **Keep** the corner-clamp `rounded-[min(var(--radius-md),Npx)]`, `has-data-[icon=inline-*]` padding, `in-data-[slot=button-group]:rounded-lg`, per-size `text-*`/`gap-*`, and all `[&_svg…]:size-*` classes exactly as they are.

Rename the `default` size key → `md`, but **keep `default` as a duplicate alias mapping to the same classes** and leave `defaultVariants.size: "default"` so unspecified `<Button>` is unchanged — decouples the rename from any visual change. Add `shape?: "default" | "pill"` (`rounded-full`). Export `ControlSize = "xs"|"sm"|"md"|"lg"` from this file. Migrate explicit `size="default"` call sites to `"md"` in a follow-up, then drop the alias.

**1f. Migrate ToggleChip** (`plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx`): add a fixed height class — `md→control-sm`, `sm→control-xs` (chips read one notch smaller; current rendered heights land ~24–28px). Keep `rounded-full`, flex centering, and horizontal `p-*` (vertical padding becomes inert under the fixed height). **`Badge`, `Row`, and `LinkChip` stay out of the height scale** — label / full-width list-row / inline-in-text (baseline-aligned) respectively; a fixed height would be wrong for each.

### Layer 2 — Sanctioned primitives replacing the escape hatches

**2a. `TaskDraftPopover`** (`plugins/tasks/plugins/task-draft-form/web/components/task-draft-popover.tsx`): `InlinePopover.trigger` is *already* `React.ReactElement` rendered via `render={trigger}`. So: change the prop `trigger: ReactNode` + `triggerClassName: string` → `trigger: React.ReactElement`, **delete** the wrapping `<button className={triggerClassName}>` (lines ~225–235), pass `trigger` straight to `InlinePopover`. Callers pass a real `<Button size="md" variant="outline">+ Prerequisite</Button>`. This alone fixes the task-view divergence (now identical to "Add folder as dep").

**2b. New `ButtonGroup` primitive** — `plugins/framework/plugins/web-core/web/components/ui/button-group.tsx` (**web-core, next to Button** — primitives already depend on web-core's Button, so placing it in `plugins/primitives` would invert the layer; the boundary checker permits it but it's the wrong direction). Composes 2+ real Buttons / `DropdownMenuTrigger(render=<Button/>)` into a joined, bordered, single-`size` group; applies segment radii (first `rounded-r-none`, last `rounded-l-none`, middle `rounded-none`); accepts arbitrary children including a non-button divider. Sets `data-slot="button-group"` so the existing `in-data-[slot=button-group]:rounded-lg` Button rule keeps working. Migrate:
- `dependencies-button.tsx` (two popover-trigger buttons + center `MdLink` divider) — replaces `buttonVariants`-on-div + raw `<button>`s.
- `launch-control.tsx` (model dropdown + launch split, currently manual `rounded-l/r-none`).
- `prompt-template-chips.tsx` (apply + send split pill — use `shape="pill"`).
- `launch-prompts-button.tsx` (single trigger → `<DropdownMenuTrigger render={<Button size="sm" variant="outline" shape="pill" />}>`).

The base-ui `render` prop hosting a real `<Button>` is already a working pattern (`launch-control.tsx` lines 172–208).

### Layer 3 — Lint rule `no-adhoc-control` (makes divergence impossible)

New lint barrel at **`plugins/framework/plugins/web-core/lint/index.ts`** (`{ name: "web-core", rules, ignores }`) + `no-adhoc-control.ts`, mirroring `plugins/primitives/plugins/badge/lint/no-adhoc-chip.ts` (JSXAttribute visitor + `collectTokens` helper, copied verbatim). Auto-discovered via build-regenerated `lint.generated.ts`; root `eslint.config.ts` needs no edits. Co-located in web-core so the `buttonVariants` allowlist (button.tsx + button-group.tsx) stays stable. Flags, in non-allowlisted files:
- raw `<button>`/`<a>` carrying a sizing fingerprint (`h-*`/`px-*`/`text-*` together) → "use Button/ToggleChip/ButtonGroup";
- `buttonVariants` imported anywhere but button.tsx + button-group.tsx;
- size-shaping classes (`h-*`, `px-*`, `py-*`, `text-*`) in a `className` on `<Button>`/`<ToggleChip>` → size must flow through the `size` prop;
- interpolated `control-${...}` class names (Tailwind won't generate them).
Ensure the fingerprint does not double-fire with the existing `no-adhoc-chip`/`no-adhoc-row` rules. Add the rule **last** so it can't fail the build mid-migration.

## Migration order (each step independently green)

1. **Tokens + utilities + `ControlSize` type** — additive, nothing consumes them. *Low risk.*
2. **Button CVA rewrite, output held identical** at comfortable density (re-attach clamps/icon-padding/group-override; keep `default` alias; add `shape`). **Highest risk** — bug mode is silent visual regression. Screenshot-compare before/after.
3. **ToggleChip + LinkChip** → `control-*`. Badge/Row untouched. *Medium.*
4. **Escape-hatch call sites**: TaskDraftPopover (delete wrapper) → build `ButtonGroup` → migrate dependencies-button, launch-control, prompt-template-chips, launch-prompts-button. *Medium.*
5. **Lint rule** `no-adhoc-control` + allowlist. *Low.*

## Files

**Modify**
- `plugins/ui/plugins/tokens/plugins/density/shared/group.ts` — +8 token keys
- `plugins/ui/plugins/tokens/plugins/density/web/presets.ts` — +8 values × 3 presets (light+dark)
- `plugins/framework/plugins/web-core/web/theme/app.css` — `:root`/`.dark` defaults + `@utility control-*`/`control-icon-*`
- `plugins/framework/plugins/web-core/web/components/ui/button.tsx` — CVA rewrite, `shape`, `ControlSize` export, `default` alias
- `plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx` — add `control-*` height
- `plugins/tasks/plugins/task-draft-form/web/components/task-draft-popover.tsx` — drop `triggerClassName` + wrapper
- `plugins/tasks/plugins/task-dependencies/web/components/task-dependencies.tsx` — pass real `<Button>` triggers
- `plugins/conversations/plugins/conversation-view/plugins/dependencies/web/components/dependencies-button.tsx` — `ButtonGroup`
- `plugins/primitives/plugins/launch/web/components/launch-control.tsx` — `ButtonGroup`
- `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/components/prompt-template-chips.tsx` — `ButtonGroup` + `shape="pill"`
- `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/web/components/launch-prompts-button.tsx` — Button via `render`

**Create**
- `plugins/framework/plugins/web-core/web/components/ui/button-group.tsx`
- `plugins/framework/plugins/web-core/lint/index.ts`
- `plugins/framework/plugins/web-core/lint/no-adhoc-control.ts`

**Auto-regenerated by `./equin build`** (do not hand-edit)
- `plugins/framework/plugins/tooling/plugins/lint/core/lint.generated.ts` (picks up the new web-core lint barrel)

## Verification

1. `./equin build` after each migration step.
2. **Step 2 regression gate** — before/after screenshots at comfortable density of representative Buttons (toolbar, task header Hold/Drop, deps row). Must be pixel-identical for unspecified-size callers.
3. **The two reported cases**, at `http://<worktree>.localhost:9000`:
   - Task view: "Add folder as dep", "+ Prerequisite", "+ Follow-up" now identical height.
   - Conversation prompt bar: the deps "blocked/blocking" control matches its neighbors.
   Use `bun e2e/screenshot.mjs --url .../c/<id> --out /tmp/controls` to capture a toolbar row.
4. **Density coupling** — switch density preset (Comfortable → Compact) in theme settings; confirm Buttons *and* chips shrink together and stay aligned in a shared row. Check icon-only buttons stay square and don't collapse; check `text-xs` isn't clipped at compact xs.
5. **Lint enforcement** — temporarily add a raw `<button className="h-7 px-3 text-xs">` in a consumer and a `buttonVariants` import outside web-core; confirm `./equin check --eslint` fails on both. Remove.
6. `./equin check` fully green (migrations-in-sync for the density schema change, eslint, plugins-doc-in-sync).
