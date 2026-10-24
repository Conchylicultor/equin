# Typography scale + density tokens

**Date:** 2026-06-03
**Category:** global (ui tokens / theme / lint)
**Status:** Plan — awaiting approval

## Context

The token system covers color, radius, shadow, and font-family, but defines **no typographic size/weight/line-height scale and no density scale**. Because Tailwind's floor is `text-xs` (12px), dense components fall off the scale into arbitrary values:

- `text-[10px]` ×110, `text-[11px]` ×57, `text-[9px]` ×9, `text-[8px]` ×1 — **177 sub-12px arbitrary font sizes across 100 files**.
- ~30 distinct `px-N py-M` combinations expressing a handful of real intents (tight chip `px-1.5 py-0.5` ×63, status badge `px-2 py-0.5` ×32, control `px-3 py-2` ×101, row `px-2 py-1.5` ×36, …) — **~311 freeform paddings with no shared rhythm**.

The result is effectively a dozen uncoordinated font sizes and paddings — the root cause of the app looking cramped and misaligned.

### Why tokens alone don't fix it — and what does

Adding named tokens forces nothing by itself; an agent can still type `text-[10px]`. The **forcing function for consistency is the lint guard** that bans the arbitrary value and points at the one named alternative. The tokens are the sanctioned vocabulary the guard redirects to. Naming is therefore chosen per-axis for what makes that redirect unambiguous:

- **Font size → numeric** (`text-3xs`=10px, `text-2xs`=11px). The codebase already uses `text-xs/sm/base` consistently (494+253 uses); the sprawl exists *only below `text-xs`* where Tailwind has no step. Extending the same numeric scale downward closes exactly that gap, and is the **only naming the lint rule can auto-fix** (`text-[10px]`→`text-3xs` is mechanical; a semantic name would need per-site judgment, reintroducing the inconsistency).
- **Density → intent** (`p-chip`/`p-control`/`p-row`). Padding has no consistent named scale today — `p-2` is just a number — which is *why* 30 combos meaning "tight chip" diverged. The ~311 combos collapse into ~3 roles; intent naming maps role→value so every chip matches.

This fixes **value sprawl** now. **Usage sprawl** ("same element → same look everywhere") is owned by a later **primitive layer** (`<Badge>`/`<Chip>`/`<Label>`) — explicitly a follow-up task, not in this scope. Layering: tokens = closed values · lint = enforcement · primitives (later) = intent→rendering.

### Decisions locked
- **Scope:** Foundation + exemplars + lint guard (incremental burn-down), **not** a full 277-file sweep.
- **Primitives:** out of scope — separate follow-up task.
- **Density home:** new `density` token group (its own Comfortable/Cozy/Compact presets), sibling to `shape`.
- **Naming:** numeric type scale + intent density utilities.

## How the token system works (reference)

`defineTokenGroup(id, schema)` (`plugins/ui/plugins/theme-engine/core/define-token-group.ts`) derives a CSS var per key via camel→kebab (`fontSize2xs` → `--font-size-2xs`). A token is runtime-themeable only when all four hold:
1. it's in the group `schema` (`shared/group.ts`),
2. it's in every preset (`web/presets.ts`, type-forced by `*TokenValues`),
3. a Tailwind utility references its var via `@theme inline` in `app.css`,
4. a static fallback exists in `:root`/`.dark` in `app.css`.

At runtime `ThemeInjector` reads each group's config (preset + overrides) and injects `:root{…}` / `.dark{…}` overriding the fallbacks. `config.ts` auto-derives its fields from the schema, so **adding schema keys needs no config edit**. Precedents to mirror exactly: `--tracking-normal: var(--letter-spacing)` (runtime-var → utility bridge) and `--radius-md: calc(var(--radius)*0.8)`.

Tailwind v4 has **no config file**. Font-size utilities come from the `--text-*` theme namespace; a paired line-height is `--text-<name>--line-height`. `--spacing` is the single global multiplier behind every `p-N`/`m-N`/`gap-N` — **scaling it for density is too blunt** (rescales margins/gaps/insets app-wide); density uses dedicated `--pad-*` vars consumed via `@utility` only.

## Part A — Typography scale

### A.1 New tokens in `typography/shared/group.ts`
Add 8 keys to `typographyGroup`:

| key | var | value |
|---|---|---|
| `fontSize2xs` | `--font-size-2xs` | `0.6875rem` (11px) |
| `fontSize3xs` | `--font-size-3xs` | `0.625rem` (10px) |
| `lineHeight2xs` | `--line-height-2xs` | `1rem` (16px) |
| `lineHeight3xs` | `--line-height-3xs` | `0.875rem` (14px) |
| `fontWeightNormal` | `--font-weight-normal` | `400` |
| `fontWeightMedium` | `--font-weight-medium` | `500` |
| `fontWeightSemibold` | `--font-weight-semibold` | `600` |
| `fontWeightBold` | `--font-weight-bold` | `700` |

Monotonic scale: `text-3xs`(10) < `text-2xs`(11) < `text-xs`(12). The rare 9px/8px sites migrate to `text-3xs`. `TypographyTokenValues` auto-expands; this forces the preset edit in A.3.

### A.2 `app.css` wiring (all three blocks)
**`@theme`** (defines the utilities + build-time anchor):
```css
--text-2xs: 0.6875rem;            --text-2xs--line-height: 1rem;
--text-3xs: 0.625rem;             --text-3xs--line-height: 0.875rem;
```
**`@theme inline`** (bridges runtime vars → utilities, mirroring `--tracking-normal`):
```css
--text-2xs: var(--font-size-2xs);   --text-2xs--line-height: var(--line-height-2xs);
--text-3xs: var(--font-size-3xs);   --text-3xs--line-height: var(--line-height-3xs);
--font-weight-normal: var(--font-weight-normal);
--font-weight-medium: var(--font-weight-medium);
--font-weight-semibold: var(--font-weight-semibold);
--font-weight-bold: var(--font-weight-bold);
```
**`:root` and `.dark`** (static fallbacks — add all 8 runtime vars to *both* blocks, identical, matching how `--letter-spacing: 0em` appears in both):
```css
--font-size-2xs: 0.6875rem;  --font-size-3xs: 0.625rem;
--line-height-2xs: 1rem;     --line-height-3xs: 0.875rem;
--font-weight-normal: 400;   --font-weight-medium: 500;
--font-weight-semibold: 600; --font-weight-bold: 700;
```

Line-height rides along on the size utility (paired modifier), so migrated sites write only `text-3xs` — no second class — matching how `text-[10px]` is written today.

### A.3 Preset
`typography/web/presets.ts`: add all 8 keys to `defaultPreset`'s `both({…})` with the fallback values. No `config.ts` change (schema-derived). Verify `typography-section.tsx` / `typography-picker.tsx` don't hardcode a field list (they render schema-derived fields — expected fine).

## Part B — Density group (new, mirrors `shape/` file-for-file)

New plugin `plugins/ui/plugins/tokens/plugins/density/`. Schema = 6 intent vars; values are supplied per preset (no CSS `calc` scalar — presets are clearer and allow per-intent tuning):

| key | var | Comfortable (default) | covers |
|---|---|---|---|
| `padChipX` / `padChipY` | `--pad-chip-x/y` | `0.375rem` / `0.125rem` | `px-1.5 py-0.5`, `px-2 py-0.5`, `px-1 py-0.5` |
| `padControlX` / `padControlY` | `--pad-control-x/y` | `0.75rem` / `0.375rem` | `px-3 py-2`, `px-2 py-1`, `px-2.5 py-1`, `px-3 py-1.5` |
| `padRowX` / `padRowY` | `--pad-row-x/y` | `0.5rem` / `0.375rem` | `px-2 py-1.5`, `px-4 py-2` |

Presets: **Comfortable** (default, above), **Cozy** (~1 step tighter), **Compact** (tightest).

Consumed via `@utility` in `app.css` (padding utilities can't read theme vars, so this is the only bridge):
```css
@utility p-chip    { padding: var(--pad-chip-y) var(--pad-chip-x); }
@utility p-control { padding: var(--pad-control-y) var(--pad-control-x); }
@utility p-row     { padding: var(--pad-row-y) var(--pad-row-x); }
```

### Files to create (copy from `shape/`, swap shape→density)
- `density/shared/group.ts`, `shared/config.ts`, `shared/index.ts`
- `density/web/index.ts` (register `ThemeEngine.TokenGroup` + `VariantGroup` + `ThemeCustomizer.Section` + `DynamicEnum.Options` + `ConfigV2.WebRegister` — see `shape/web/index.ts`)
- `density/web/presets.ts`, `web/slots.ts`, `web/internal/config.ts`
- `density/web/components/density-picker.tsx`, `density-section.tsx`
- `density/server/index.ts`, `density/package.json`, `density/CLAUDE.md`

Auto-discovered by the loader and `ThemeInjector` — no registry edits.

## Part C — Migration + regression guard

### C.1 Strategy (foundation-first, incremental burn-down)
1. Land Parts A + B fully working/themeable, touching **zero** call sites.
2. **Migrate exemplars** — the densest, highest-signal clusters as the reference pattern: queue-view chips, profiling/gantt `text-[10px]`, the conv-category chip (`text-[9px] px-1 py-px`), and the `data-table` sticky header. Convert font sizes to `text-3xs`/`text-2xs` and tight paddings to `p-chip`/`p-control`/`p-row`.
3. **Lint guard on, with allowlist** — ship `no-arbitrary-font-size` as `error` (the mechanism registers contributed rules repo-wide as error) with an `ignores` allowlist enumerating every currently-offending file. New code is blocked immediately; legacy migrates in follow-ups that delete allowlist entries.
4. Sweep the long tail opportunistically.

A full one-PR sweep is rejected: ~277 files, high review + merge-conflict cost.

### C.2 Lint rule (first contributed lint barrel in the repo)
The mechanism exists and is grounded (`eslint.config.ts` auto-discovers `plugins/<name>/lint/index.ts`, codegen writes `lint.generated.ts`, per-rule `ignores?: Record<string, string[]>` supported). Place at the typography plugin (it owns the target tokens):

- `plugins/ui/plugins/tokens/plugins/typography/lint/index.ts` — `default { name: "typography-tokens", rules, ignores }`.
- `plugins/ui/plugins/tokens/plugins/typography/lint/no-arbitrary-font-size.ts`:
  - Visit string `Literal` + `TemplateElement` (classes appear both bare in `className` and inside `cn("…")`), test `/(?:^|\s)text-\[\d+px\]/`.
  - Message: ``text-[Npx] is banned — use text-3xs (10px) / text-2xs (11px) / text-xs (12px); add a token in typography/shared/group.ts for a new step.``
  - **Fixer** for the three mapped sizes only: `text-[10px]`→`text-3xs`, `text-[11px]`→`text-2xs`, `text-[12px]`→`text-xs`. Other px values: report-only. The fixer makes burn-down cheap.
  - `ignores["no-arbitrary-font-size"]` = list from `rg -l 'text-\[\d+px\]' plugins`, with a "temporary — migrate then delete" comment.
- Defer `no-raw-tight-padding` (noisier; tight paddings also appear off-chip). Ship later, narrowly scoped, after primitives land.

No manual edit to `eslint.config.ts` / `lint.generated.ts` — codegen regenerates on `./equin build`.

## Files touched (summary)
**Modify**
- `plugins/ui/plugins/tokens/plugins/typography/shared/group.ts` — 8 schema keys.
- `plugins/ui/plugins/tokens/plugins/typography/web/presets.ts` — 8 preset values.
- `plugins/framework/plugins/web-core/web/theme/app.css` — **central, highest-risk**: `@theme` (text-2xs/3xs + paired LH), `@theme inline` (size/LH/weight bridges), `:root`+`.dark` (8 type + 6 density fallbacks), 3 `@utility p-*` blocks.
- Exemplar component files (step C.1.2).

**Create**
- `plugins/ui/plugins/tokens/plugins/density/**` (mirror `shape/`).
- `plugins/ui/plugins/tokens/plugins/typography/lint/{index.ts,no-arbitrary-font-size.ts}`.

## Riskiest parts (verify during implementation)
1. **Paired line-height via runtime var** — whether `--text-2xs--line-height: var(--line-height-2xs)` in `@theme inline` yields a `text-2xs` utility that emits a *runtime-resolving* line-height. Spike one utility + inspect DevTools before rollout. **Fallback:** static LH in `@theme` block 1 (size themeable, LH not) — acceptable; size is what the audit needs.
2. **Same `--text-2xs` in both `@theme` and `@theme inline`** — confirm v4 accepts it and the inline (runtime) declaration wins for resolution while block 1 still generates the utility. Fallback: rely on `@source` scanning + keep only the inline declaration.
3. **Font-weight shadowing** — redeclaring `--font-weight-medium` etc. over v4 defaults to make `font-medium` themeable; confirm ours win without changing the default look. If contentious, drop weight tokens (usage is already near-standard 500/600).

## Verification
1. `./equin build` (regenerates `lint.generated.ts`, builds, restarts).
2. **Utilities exist & resolve:** load `http://att-1780485330-lyo2.localhost:9000`, inspect a migrated chip — computed `font-size: 10px`, paired `line-height` present, `p-chip` padding from `--pad-chip-*`.
3. **Runtime themeable:** open the theme customizer → Typography section shows the new fields; Density section shows Comfortable/Cozy/Compact; switching Density visibly retightens chips/rows app-wide (Compact) without touching margins/gaps. Per-token override on a font size live-updates.
4. **Lint guard:** add a stray `text-[10px]` to a non-allowlisted file → `./equin check --eslint` fails; `--fix` rewrites it to `text-3xs`. Existing allowlisted files still pass.
5. **Exemplars unchanged visually** (Comfortable defaults equal the old hard-coded values): screenshot queue-view / gantt before+after with `e2e/screenshot.mjs`.
6. `./equin check` green (incl. `plugins-doc-in-sync`, `migrations-in-sync`).
