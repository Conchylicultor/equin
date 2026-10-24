# Categorical color palette token group + remove no-hardcoded-colors allow-list

## Context

The `no-hardcoded-colors` check
(`plugins/framework/plugins/tooling/plugins/checks/plugins/no-hardcoded-colors/check/index.ts`)
forbids raw Tailwind color-scale utility classes (`bg-emerald-600`, `text-amber-500`,
`dark:bg-red-950`, …) in plugin code, steering everyone toward the semantic theme tokens
(`success`/`warning`/`info`/`destructive`/`muted`). To cope with code that legitimately needs
many *distinct* hues, it keeps a hand-maintained `ALLOWED_PATHS` list (~29 files) that are exempt.

That allow-list is the wrong escape hatch. It conflates two unrelated situations and lets real
violations hide behind a path prefix:

1. **Genuine categorical palettes** — N visually-distinct hues assigned to categories/indices
   (Gantt phases, model tiers, runtime/HTTP-method badges, the avatar & conversation-category
   hash-palettes). These have a real need the semantic tokens can't serve, but they should draw
   from a *themeable palette*, not from hardcoded Tailwind scales.
2. **Plain semantic misuse** — `error`=red, load-bearing=amber, "auto" trigger=sky, git-status
   badges, etc. These should simply use the existing semantic tokens and never needed an exemption.

The chart token group (`--chart-1..5`) is themeable and is the right structural model — but its
values are a monochromatic blue→indigo ramp (all hue ≈252–266), perfect for stacked series and
useless for telling categories apart. So we can't reuse `chart` for categorical, but we *can*
copy its infrastructure.

**Outcome:** introduce a first-class, themeable **`categorical`** token group (10 distinct hues,
modeled byte-for-byte on the `chart` plugin), migrate every categorical consumer to it, fix the
semantic-misuse files to use existing semantic tokens, then **delete `ALLOWED_PATHS` entirely** so
the check has zero exemptions. Decided with the user: new dedicated token group + full migration,
executed via parallel subagents.

## Design

### 1. New token group: `plugins/ui/plugins/tokens/plugins/categorical/`

Mirror the `chart` plugin's file structure exactly (the working precedent):

| chart file | categorical equivalent |
|---|---|
| `package.json` | name `@singularity/plugin-ui-tokens-categorical`, desc "Categorical color palette token group with switchable presets." |
| `shared/group.ts` | `defineTokenGroup("categorical", { "categorical-1": {default, label:"Categorical 1"}, … "categorical-10": … })`; export `CategoricalTokenValues` |
| `shared/config.ts` | `categoricalConfig` (preset + light/dark overrides) — identical shape |
| `shared/index.ts` | re-export group/config/type |
| `server/index.ts` | `id: "ui-tokens-categorical"`, `ConfigV2.Register({ descriptor: categoricalConfig })` |
| `web/slots.ts` | `Categorical.Preset` slot, `CategoricalPresetContribution` |
| `web/presets.ts` | `defaultPreset` with the 10 hues (light + dark — NOT identical: see below) |
| `web/internal/config.ts` | re-export `categoricalConfig` |
| `web/components/categorical-picker.tsx` | copy of `ChartPicker`, `KEYS = categorical-1..10` |
| `web/components/categorical-section.tsx` | copy of `ChartSection`, swap `chartGroup`/`chartConfig`/`Chart` → categorical |
| `web/index.ts` | copy of chart's; contributes `Categorical.Preset`, `ConfigV2.WebRegister`, `DynamicEnum.Options`, `ThemeEngine.TokenGroup`, `ThemeEngine.VariantGroup`, `ThemeCustomizer.Section` |

The plugin auto-registers (no registry edits): `web.generated.ts` regenerates on build, and the
group self-registers with the injector via its `ThemeEngine.TokenGroup` contribution
(collection-consumer separation — `ThemeInjector` already iterates
`ThemeEngine.TokenGroup.useContributions()`).

**Palette hues** — 10 distinct, ordered to match the existing avatar / conversation-category named
palette (sky, emerald, amber, rose, violet, indigo, teal, pink, orange, slate) so the migration is
near-visually-neutral. Unlike `chart`, light ≠ dark: each token gets a mid-tone light value
(readable as `text-` on a `/15` tint and usable as a solid swatch) and a lighter dark value
(readable on dark surfaces). Starting values (implementer may fine-tune for contrast):

```
                 light                        dark
categorical-1  oklch(0.68 0.14 230)  /  oklch(0.78 0.13 230)   # sky
categorical-2  oklch(0.70 0.15 160)  /  oklch(0.80 0.14 160)   # emerald
categorical-3  oklch(0.75 0.15 70)   /  oklch(0.83 0.14 70)    # amber
categorical-4  oklch(0.65 0.20 15)   /  oklch(0.75 0.17 15)    # rose
categorical-5  oklch(0.60 0.20 295)  /  oklch(0.72 0.17 295)   # violet
categorical-6  oklch(0.55 0.20 270)  /  oklch(0.70 0.16 270)   # indigo
categorical-7  oklch(0.70 0.12 190)  /  oklch(0.80 0.11 190)   # teal
categorical-8  oklch(0.68 0.20 350)  /  oklch(0.78 0.17 350)   # pink
categorical-9  oklch(0.70 0.17 50)   /  oklch(0.80 0.15 50)    # orange
categorical-10 oklch(0.55 0.03 250)  /  oklch(0.70 0.03 250)   # slate
```

### 2. Wire the Tailwind utility classes — `app.css`

`@theme inline` is hand-written and is the ONLY file requiring a manual edit
(`plugins/framework/plugins/web-core/web/theme/app.css`). Add, alongside the `--color-chart-*` block:

```css
@theme inline {
  --color-categorical-1: var(--categorical-1);
  … through --color-categorical-10 …
}
```

And add fallback defaults (used before `ThemeInjector` runs) to BOTH the `:root` and `.dark` blocks:

```css
:root { --categorical-1: oklch(0.68 0.14 230); … }
.dark { --categorical-1: oklch(0.78 0.13 230); … }
```

After this, `bg-categorical-3`, `text-categorical-3`, `border-categorical-3`, `bg-categorical-3/15`
all work, and `var(--categorical-3)` works in inline styles.

### 3. Register in global presets — `plugins/ui/plugins/tokens/web/index.ts`

Add `categorical: "default"` to the `groups` map of all three `ThemeEngine.GlobalPreset`
contributions (default, ocean, warm), matching how `chart: "default"` is listed.

### 4. Consumer migration

Two usage classes. **Firm requirement: zero matched hardcoded classes remain.** Consolidation of
duplicates is done where a natural owner exists; where none does, files migrate to the shared
`categorical-N` tokens independently (still removes the hardcoding).

**Convention for tinted chips:** replace the four-shade `bg-X-100 text-X-700 dark:bg-X-900/60
dark:text-X-300` pattern with `bg-categorical-N/15 text-categorical-N` (solid swatches → `bg-categorical-N`).
This is a small, intentional visual change (single-hue tint, matching the chart/shadcn idiom).

#### 4a. Categorical → `categorical-N`

| File(s) | Mapping |
|---|---|
| `debug/.../profiling/build/.../build-section.tsx` + `build/build-profiling/.../build-profiling-section.tsx` (dup, 8 phases) | preflight→1, setup→9, codegen→3, database→? keep order; assign the 8 phases to categorical-1..8 (same map in both files) |
| `debug/.../profiling/boot/.../boot-section.tsx` (6 phases) | each phase → categorical-1..6 |
| `debug/.../profiling/stats/.../stats-section.tsx` (3 phases) | categorical-1..3 |
| `tasks/task-graph/.../task-graph.tsx` `GROUP_PALETTE` (4, by depth) | categorical-1..4; edge stroke (satisfied/unsatisfied) → `var(--success)` / `var(--muted-foreground)` (semantic, see 4b) |
| `conversations/model-provider/.../family-class.ts` (canonical model tier) | opus→categorical-5(violet), sonnet→categorical-1(sky), haiku→categorical-2(emerald). **Consolidate:** export `familyClass` (already exported) as the single source. |
| `…/jsonl-viewer/tool-call/agent/.../agent-tool-view.tsx` `modelColors` + `…/workflow/web/components/workflow-node-card.tsx` `MODEL_COLORS` | DELETE local maps; import `familyClass` from `@plugins/conversations/plugins/model-provider/web`. Fixes the opus purple-vs-amber inconsistency. agent-type badge → categorical-6(indigo). |
| `…/workflow/web/components/workflow-tool-view.tsx` + `workflow-graph.tsx` (indigo phase/workflow badges) | categorical-6(indigo); emphasis borders dep→categorical-3, dependent→categorical-1; truncation warning → `warning` (semantic) |
| `plugin-meta/plugin-view/public-api/.../public-api-section.tsx` (`RUNTIME_COLORS` 5, `CATEGORY_STYLES` 4, `METHOD_COLORS` 6) + `runtimes-section.tsx` (3) | runtimes web→1, server→2, central→5, core→3, shared→9 — **consolidate** into a shared `RUNTIME_COLORS` exported from the `plugin-view` barrel; `runtimes-section` imports it. category hook→6, comp→1, type→10, val→9. methods GET→2, POST→1, PUT/PATCH→3, DELETE→4, WS→5. |
| `apps/forge/catalog/.../routes-table.tsx` `METHOD_COLORS` (dup of public-api) | same method map. No natural shared owner across plugin-meta↔forge → migrate to identical `categorical-N` constants in place (de-hardcode is firm; dedup not forced). |
| `active-data/attempt/.../attempt-chip.tsx` | completed→categorical-5(purple); in_progress `bg-[oklch(...)]`→`bg-info`; pushed→`success` (already), abandoned→`muted` |
| `debug/memory/.../memory-panel.tsx` | reference→categorical-5; rest already semantic |
| `review/plugin-changes/api-changes/.../api-changes-summary.tsx` | "API" badge → categorical-5 |
| `conversations/summary/.../phase-styles.ts` | design_review→categorical-1, implementation_review→categorical-6; clarification→`warning`, executing→`success`, investigating/other→`muted` |
| `primitives/avatar/web/internal/colors.ts` (`AVATAR_COLORS`, 10 named keys) | keep named-key API (persisted); remap each value to `bg-categorical-N/15 text-categorical-N` in palette order sky=1…slate=10 |
| `conversations/conversation-category/web/internal/colors.ts` (`COLOR_PALETTE`, 10 named keys, persisted) | keep named keys; swatch → `bg-categorical-N` in same order |

#### 4b. Semantic misuse → existing tokens (no palette)

| File(s) | Fix |
|---|---|
| `debug/claude-cli-calls/.../call-row.tsx` | red error → `destructive` |
| `debug/.../profiling/push/push-gantt/.../push-gantt.tsx` | outcomes: success→`success`, failed_rebase/failed_push→`destructive`, failed_checks→`warning`, error→`muted`; timeline: wait→`warning`, build→`info`, build-failed→`info` (dim via `/70`), interrupted→`destructive` |
| `build/build-popover-content.tsx` + `build/build-info/.../build-info.tsx` | trigger auto→`info`, manual/superseded→`muted` |
| `code-explorer/.../file-tree.tsx` | folder icon `text-sky-500` → `text-info` |
| `plugin-meta/plugin-view/sub-plugins/.../sub-plugins-section.tsx` + `plugin-view/.../plugin-detail.tsx` | load-bearing amber → `warning` |
| git-status badges: `…/code/docs-button/.../doc-row.tsx` (`STATUS_DOT`), `review/code-review/.../review-file-row.tsx` + `review/plugin-changes/file-changes/.../file-changes-section.tsx` (`STATUS_BADGE`, dup) | **Consolidate** a shared `GIT_STATUS_DOT` + `GIT_STATUS_BADGE` exported from the `code` plugin web barrel (where `EditedFileStatus` lives, `…/code/core`). Map: modified→`info`, added/untracked→`success`, deleted→`destructive`, renamed→categorical-5, copied→categorical-3, clean→`muted`. The two review-side files import the shared maps. |

### 5. Update the check itself — `no-hardcoded-colors/check/index.ts`

- **Delete the entire `ALLOWED_PATHS` array** and the `ALLOWED_PATHS.some(...)` + `research/` filter
  lines (the grep is already scoped to `plugins/**`, so the `research/` skip is dead code).
- The check file currently self-matches via the literal examples in its `hint`
  (`bg-emerald-600, text-amber-500, dark:bg-red-950`). Rewrite those examples so they don't match
  the regex (e.g. `bg-<color>-<shade>`), and update the closing hint line from "add the file to
  `ALLOWED_PATHS`" to: *"For categorical data-viz (Gantt phase, model tier, runtime badge, …) use
  the categorical palette: `bg-categorical-1` … `bg-categorical-10` / `text-categorical-N` (themeable
  via the ui-tokens-categorical group)."*
- **Harden (recommended):** extend the detector to also flag Tailwind-named colors smuggled through
  `var(--color-<name>-<shade>)` (task-graph) and arbitrary `bg-[oklch(...)]` (attempt-chip), so the
  migrated patterns can't silently regress. Both are being removed in 4a; catching them keeps the
  invariant. Add a second grep/pattern; keep `--color-categorical-*`, `--color-chart-*`, and the
  semantic `--color-*` tokens legal.
- Update `no-hardcoded-colors/CLAUDE.md` prose to mention the categorical palette as the sanctioned
  route for multi-hue needs.

## Critical files

- **New:** `plugins/ui/plugins/tokens/plugins/categorical/**` (mirror of `…/chart/**`)
- **Edit:** `plugins/framework/plugins/web-core/web/theme/app.css` (`@theme inline` + `:root`/`.dark`)
- **Edit:** `plugins/ui/plugins/tokens/web/index.ts` (3 global presets)
- **Edit:** `plugins/framework/plugins/tooling/plugins/checks/plugins/no-hardcoded-colors/check/index.ts` (+ its CLAUDE.md)
- **Edit:** 29 consumer files listed in §4 (canonical owners: `model-provider/web`, `plugin-view`
  barrel, `code` plugin web barrel)

## Execution via subagents

Phase A (single agent, careful — load-bearing infra): build the `categorical` token group,
edit `app.css` + global presets, run `./equin build`, confirm `bg-categorical-N` renders.
Phases B/C run only after A lands (consumers depend on the tokens existing).

Phase B (parallel subagents, each owns an independent file group; `model: "sonnet"`):
1. Profiling/build Gantt (build-section, build-profiling-section, boot, stats)
2. Model tier consolidation (family-class + agent-tool-view + workflow/* )
3. plugin-meta (public-api, runtimes, sub-plugins, plugin-detail) + forge routes-table
4. Git-status consolidation (code barrel + doc-row + review-file-row + file-changes-section)
5. Avatar + conversation-category palettes
6. Remaining categorical (task-graph, attempt-chip, memory-panel, api-changes-summary, phase-styles)
7. Semantic-only fixes (call-row, push-gantt, build-popover-content, build-info, file-tree)

Phase C (single agent): delete `ALLOWED_PATHS`, update check + CLAUDE.md, run
`./equin build` (runs the check) and `./equin check --no-hardcoded-colors`.

## Verification

1. `./equin build` succeeds (regenerates `web.generated.ts` incl. categorical, runs checks).
2. `./equin check` is green — in particular `no-hardcoded-colors` passes with an empty/removed
   allow-list, and the manual git-grep for the color pattern over `plugins/**/*.{ts,tsx}` returns
   ONLY token-definition files (oklch literals, which don't match) — i.e. effectively zero offenders.
3. Visit `http://<worktree>.localhost:9000`:
   - Theme settings → a new **Categorical** section appears with the 10-swatch preset picker and
     per-token editor (parity with the Chart section).
   - Spot-check migrated surfaces in light AND dark mode: profiling Gantt (debug app), a conversation
     toolbar model chip, plugin-view runtime/method/category badges (forge), avatars, conversation
     category chips, review file-status badges, build popover trigger badge.
   - Confirm editing a `categorical-N` override (or switching preset) live-updates every consuming
     surface — proves they all read the shared token, not a hardcoded color.
4. Sanity: model tier color is now consistent across the model chip, agent tool view, and workflow
   node cards (opus no longer purple-in-one-place / amber-in-another).
