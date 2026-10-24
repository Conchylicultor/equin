# Semantic Status Tokens

## Context

The theme token system defines `--destructive` (used ~108x) but has **no `--success`, `--warning`, or `--info` semantic tokens**. Feature plugins compensate by hardcoding raw Tailwind color literals (~150 status-semantic occurrences like `bg-emerald-600`, `text-amber-500`) plus ~100 manual `dark:` overrides. These ignore the active theme and break under tweakcn community presets and the light/dark engine.

The fix: define the missing tokens in the existing `color-palette` group (where `destructive` already lives), migrate the status-semantic offenders, and add a `./equin check` guardrail to prevent regression.

## Step 1 — Define tokens in `color-palette` group

Add 6 new entries to `defineTokenGroup()` after `destructiveForeground`, before `border`:

**`plugins/ui/plugins/tokens/plugins/color-palette/shared/group.ts`**

```ts
success: { default: "oklch(0.53 0.18 142)", label: "Success" },
successForeground: { default: "oklch(1 0 0)", label: "Success text" },
warning: { default: "oklch(0.72 0.17 60)", label: "Warning" },
warningForeground: { default: "oklch(0.145 0 0)", label: "Warning text" },
info: { default: "oklch(0.54 0.16 232)", label: "Info" },
infoForeground: { default: "oklch(1 0 0)", label: "Info text" },
```

`ColorPaletteTokenValues` derives from the schema automatically — no separate type update needed.

## Step 2 — Update all three built-in presets

**`plugins/ui/plugins/tokens/plugins/color-palette/web/presets.ts`**

Add the 6 keys to each of `defaultPreset`, `oceanPreset`, `warmPreset` (both light and dark). TypeScript enforces completeness via `ColorPaletteTokenValues`.

| Token | Light | Dark |
|---|---|---|
| `success` | `oklch(0.53 0.18 142)` | `oklch(0.72 0.16 142)` |
| `successForeground` | `oklch(1 0 0)` | `oklch(0.145 0 0)` |
| `warning` | `oklch(0.72 0.17 60)` | `oklch(0.78 0.14 60)` |
| `warningForeground` | `oklch(0.145 0 0)` | `oklch(0.145 0 0)` |
| `info` | `oklch(0.54 0.16 232)` | `oklch(0.72 0.14 232)` |
| `infoForeground` | `oklch(1 0 0)` | `oklch(0.985 0 0)` |

Status tokens stay consistent across presets (Default/Ocean/Warm) — their meaning is fixed, unlike `primary` which shifts with the theme personality.

## Step 3 — Wire through `app.css`

**`plugins/framework/plugins/web-core/web/theme/app.css`**

Three insertion points:

**`@theme inline {}` block** — after `--color-destructive-foreground`:
```css
--color-success: var(--success);
--color-success-foreground: var(--success-foreground);
--color-warning: var(--warning);
--color-warning-foreground: var(--warning-foreground);
--color-info: var(--info);
--color-info-foreground: var(--info-foreground);
```

**`:root {}` block** — after `--destructive-foreground`:
```css
--success: oklch(0.53 0.18 142);
--success-foreground: oklch(1 0 0);
--warning: oklch(0.72 0.17 60);
--warning-foreground: oklch(0.145 0 0);
--info: oklch(0.54 0.16 232);
--info-foreground: oklch(1 0 0);
```

**`.dark {}` block** — after `--destructive-foreground`:
```css
--success: oklch(0.72 0.16 142);
--success-foreground: oklch(0.145 0 0);
--warning: oklch(0.78 0.14 60);
--warning-foreground: oklch(0.145 0 0);
--info: oklch(0.72 0.14 232);
--info-foreground: oklch(0.985 0 0);
```

After this, Tailwind classes `bg-success`, `text-success`, `text-success-foreground`, `bg-warning`, `text-info`, etc. are all available.

## Step 3b — Surface in ThemeCustomizer UI

**`plugins/ui/plugins/tokens/plugins/color-palette/web/components/color-palette-section.tsx`**

The `GROUPS` array (line 27) controls which tokens are visible and editable in the ThemeCustomizer. Tokens not listed here exist at the CSS/Tailwind level but aren't surfaced to the user. Add three entries after the "Destructive" group:

```ts
{ label: "Success", keys: ["success", "successForeground"] },
{ label: "Warning", keys: ["warning", "warningForeground"] },
{ label: "Info", keys: ["info", "infoForeground"] },
```

This lets users override status colors per-token, see the live swatch dots in the collapsible headers, and search them by label or CSS variable name.

## Step 4 — Update tweakcn convert map

**`plugins/ui/plugins/tweakcn/core/convert.ts`**

Add 6 entries to `COLOR_PALETTE_MAP` (tweakcn themes don't define these keys today — `pick()` silently skips absent keys, so the `group.ts` defaults act as fallback):

```ts
success: "success",
"success-foreground": "successForeground",
warning: "warning",
"warning-foreground": "warningForeground",
info: "info",
"info-foreground": "infoForeground",
```

Update comment from `// color-palette: 19 tokens` to `// color-palette: 25 tokens`.

## Step 5 — Migrate status-semantic offenders

### Classification rule

| Semantic meaning | Token to use |
|---|---|
| Success / done / passed / added / positive | `text-success`, `bg-success/10` |
| Warning / pending / held / caution / need-action | `text-warning`, `bg-warning/10` |
| Info / in-progress / running / informational | `text-info`, `bg-info/10` |
| Error / failed / deleted / destructive | `text-destructive`, `bg-destructive/10` |
| Neutral / muted / blocked | `text-muted-foreground`, `bg-muted` |

Diff colors (green +additions, red −deletions) → `text-success` / `text-destructive` — no dedicated diff tokens needed.

### 5a. `plugins/tasks/plugins/task-status/web/components/task-status.tsx`

Single source of truth for task status. Replace `STATUS_META` color strings:

| Status | Before | After |
|---|---|---|
| `in_progress` icon | `text-blue-600 dark:text-blue-400` | `text-info` |
| `need_action` icon | `text-orange-500 dark:text-orange-400` | `text-warning` |
| `need_action` badge | `bg-orange-500/15 text-orange-700 dark:text-orange-300` | `bg-warning/15 text-warning` |
| `done` icon | `text-emerald-600 dark:text-emerald-400` | `text-success` |
| `held` icon | `text-amber-600 dark:text-amber-400` | `text-warning` |
| `held` badge | `bg-amber-500/15 text-amber-700 dark:text-amber-300` | `bg-warning/15 text-warning` |
| `blocked` icon | `text-zinc-500 dark:text-zinc-400` | `text-muted-foreground` |
| `blocked` badge | `bg-zinc-500/15 text-zinc-700 dark:text-zinc-300` | `bg-muted text-muted-foreground` |

### 5b. `plugins/build/plugins/build-info/web/components/build-info.tsx`

Replace StatusBadge inline colors:

| State | Before (light + dark) | After |
|---|---|---|
| Running | `bg-amber-100 … dark:text-amber-300` | `bg-warning/10 text-warning` |
| Success | `bg-emerald-100 … dark:text-emerald-300` | `bg-success/10 text-success` |
| Failed | `bg-red-100 … dark:text-red-300` | `bg-destructive/10 text-destructive` |

Leave `auto` trigger badge (sky) as categorical — file stays in allowlist for that.

### 5c. `plugins/debug/plugins/queue/web/components/queue-view.tsx`

Replace `STATE_STYLES` map:
- `pending` → `bg-info/10 text-info`
- `running` → `bg-warning/10 text-warning`
- `retrying` → `bg-warning/15 text-warning`
- `dead` → `bg-destructive/10 text-destructive`

Plus error text, matched/unmatched event badges, error background.

### 5d. `plugins/debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx`

Local `StatusBadge` re-implements task status colors. Replace with semantic tokens (or import from `task-status` if boundary rules allow). Also fix DirtyIndicator (green→`text-success`, amber→`text-warning`) and confirmation row (amber→`bg-warning/5 text-warning`).

### 5e. Diff color files (4 files)

- `plugins/review/plugins/code-review/web/components/review-file-row.tsx`
- `plugins/review/plugins/plugin-changes/plugins/file-changes/web/components/file-changes-section.tsx`
- `plugins/review/plugins/code-review/web/components/code-review-section.tsx`
- `plugins/review/plugins/code-review/web/components/code-review-summary.tsx`

Replace `+additions` text (`text-emerald-600 dark:text-emerald-400`) → `text-success`.
Replace `−deletions` text (`text-red-600 dark:text-red-400`) → `text-destructive`.
Replace `added`/`untracked` badge (`bg-emerald-500/15 …`) → `bg-success/15 text-success`.
Replace `deleted` badge (`bg-red-500/15 …`) → `bg-destructive/15 text-destructive`.

Also `plugins/review/plugins/plugin-changes/plugins/api-changes/web/components/api-changes-section.tsx` — `text-green-*` / `text-red-*` → `text-success` / `text-destructive`.

Leave `modified` (blue), `renamed` (violet), `copied` (amber) as categorical — these files stay in allowlist for those.

### 5f. LEVEL_BG/LEVEL_ICON_CLASS in `review-file-row.tsx`

The `careful`/`critical` warning-level colors are status-semantic:
- `careful` (amber) → `bg-warning/10`, icon → `text-warning`
- `critical` (red) → `bg-destructive/10`, icon → `text-destructive`

## Step 6 — Add guardrail check

**New plugin:** `plugins/framework/plugins/tooling/plugins/checks/plugins/no-hardcoded-colors/`

### Files to create

- `check/index.ts` — the check implementation
- `CLAUDE.md` — plugin reference stub
- `package.json` — workspace package

### Check implementation

Pattern: `rg` search for raw Tailwind color-scale classes (`(bg|text|border|…)-(red|amber|emerald|…)-\d{2,3}`) across `plugins/`, filtering out `ALLOWED_PATHS`. Matches the existing `no-raw-websocket` check structure.

### ALLOWED_PATHS (files with legitimate categorical data-viz colors)

```
# Token definitions (these define the values)
plugins/ui/plugins/tokens/
plugins/framework/plugins/web-core/web/theme/

# Gantt phase palettes (categorical: each step needs a distinct hue)
plugins/debug/plugins/profiling/plugins/build/web/components/build-section.tsx
plugins/debug/plugins/profiling/plugins/boot/web/components/boot-section.tsx
plugins/debug/plugins/profiling/plugins/stats/web/components/stats-section.tsx
plugins/debug/plugins/profiling/plugins/push/plugins/push-gantt/web/components/push-gantt.tsx
plugins/build/plugins/build-profiling/web/components/build-profiling-section.tsx

# Other categorical palettes
plugins/conversations/plugins/summary/web/components/phase-styles.ts
plugins/debug/plugins/claude-cli-calls/web/components/call-row.tsx
plugins/plugin-meta/plugins/plugin-view/plugins/public-api/web/components/public-api-section.tsx
plugins/apps/plugins/forge/plugins/catalog/web/components/categories/routes-table.tsx

# Files with remaining categorical colors after status-semantic migration
plugins/review/plugins/code-review/web/components/review-file-row.tsx
plugins/review/plugins/plugin-changes/plugins/file-changes/web/components/file-changes-section.tsx
plugins/build/plugins/build-info/web/components/build-info.tsx
```

Note: this is the initial set. Running the check after migration may surface additional files needing either migration or allowlisting.

### Hint message

Points agents to the semantic token alternatives: success/warning/info/destructive/muted. Tells them to add to ALLOWED_PATHS with a comment if the color is genuinely categorical data-viz.

## Execution order

1. Steps 1+2 together (group.ts + presets.ts) — TS enforces completeness
2. Step 3 (app.css) — can run in parallel with step 1
3. Step 4 (tweakcn convert.ts) — independent
4. Steps 5a–5f (migrations) — depend on step 3
5. Step 6 (check plugin) — last, after migrations, so it starts green
6. `./equin build` — regenerates check.generated.ts, deploys

## Verification

1. **TypeScript** — `./equin check --typescript` enforces preset completeness
2. **CSS variables** — DevTools: `getComputedStyle(root).getPropertyValue('--success')` returns oklch
3. **Tailwind classes** — `bg-success` resolves to the expected green in browser
4. **Theme switching** — Default/Ocean/Warm × light/dark: migrated components maintain readable contrast
5. **Tweakcn presets** — status tokens fall back to defaults when tweakcn theme doesn't define them
6. **Guardrail** — `./equin check --no-hardcoded-colors` passes with 0 violations
7. **Visual spot-check** — task status icons, build badges, queue state chips, diff +/− counters all look correct
