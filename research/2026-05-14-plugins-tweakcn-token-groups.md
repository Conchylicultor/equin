# tweakcn Token Group Parity

## Context

The current theme-engine token groups (color-palette, shape, sidebar-palette) are a subset of what tweakcn presets include. Importing a tweakcn preset would silently lose: chart colors (chart-1..5), destructive-foreground, sidebar-primary/fg, spacing, and typography tokens (font-sans/serif/mono, letter-spacing). Shadows are excluded from this scope — they can be added later.

This plan adds 2 new token group sub-plugins and patches 3 existing ones so that every tweakcn field (minus shadows) has a home.

## Changes

### 1. Patch: `color-palette` — add `destructiveForeground`

**Files to modify:**

`plugins/ui/plugins/tokens/plugins/color-palette/shared/group.ts` — add after `destructive`:
```ts
destructiveForeground: { default: "oklch(1 0 0)", label: "Destructive text" },
```

`plugins/ui/plugins/tokens/plugins/color-palette/web/presets.ts` — add to all 3 presets:
- All light: `destructiveForeground: "oklch(1 0 0)"`
- All dark: `destructiveForeground: "oklch(0.985 0 0)"`

> Fixes a real bug: `text-destructive-foreground` is used in `web/src/components/plugin-load-errors.tsx` but `--destructive-foreground` was never defined.

### 2. Patch: `sidebar-palette` — add `sidebarPrimary`, `sidebarPrimaryForeground`

**Files to modify:**

`plugins/ui/plugins/tokens/plugins/sidebar-palette/shared/group.ts` — add after `sidebarForeground`:
```ts
sidebarPrimary: { default: "oklch(0.205 0 0)", label: "Sidebar primary" },
sidebarPrimaryForeground: { default: "oklch(0.985 0 0)", label: "Sidebar primary text" },
```

`plugins/ui/plugins/tokens/plugins/sidebar-palette/web/presets.ts` — add to both presets:
- default light: `sidebarPrimary: "oklch(0.205 0 0)"`, `sidebarPrimaryForeground: "oklch(0.985 0 0)"`
- default dark: `sidebarPrimary: "oklch(0.488 0.243 264.376)"`, `sidebarPrimaryForeground: "oklch(0.985 0 0)"`
- warm light: `sidebarPrimary: "oklch(0.205 0 0)"`, `sidebarPrimaryForeground: "oklch(0.985 0 0)"`
- warm dark: `sidebarPrimary: "oklch(0.488 0.243 264.376)"`, `sidebarPrimaryForeground: "oklch(0.985 0 0)"`

### 3. Patch: `shape` — add `spacing`

**Files to modify:**

`plugins/ui/plugins/tokens/plugins/shape/shared/group.ts` — add after `radius`:
```ts
spacing: { default: "0.25rem", label: "Base spacing" },
```

`plugins/ui/plugins/tokens/plugins/shape/web/presets.ts` — add `spacing: "0.25rem"` to all 4 presets' `both()` calls.

### 4. New plugin: `chart`

5 color tokens: `chart-1` through `chart-5`.

**Key detail:** `camelToKebab` only dashes before uppercase letters. Use quoted string keys `"chart-1"` etc. — they pass through unchanged, producing `--chart-1` through `--chart-5`.

Default values (same light/dark — chart colors are mode-independent in tweakcn):
```
chart-1: oklch(0.81 0.10 252)
chart-2: oklch(0.62 0.19 260)
chart-3: oklch(0.55 0.22 263)
chart-4: oklch(0.49 0.22 264)
chart-5: oklch(0.42 0.18 266)
```

Uses the `both()` helper (like shape) since light === dark.

**Picker swatch:** 5 colored circles in a row per preset button.

**Files to create** (follow exact pattern of color-palette/shape/sidebar-palette):
```
plugins/ui/plugins/tokens/plugins/chart/
  package.json                              # @singularity/plugin-ui-tokens-chart
  shared/group.ts                           # defineTokenGroup("chart", { "chart-1": ..., ... })
  shared/config.ts                          # defineConfig({ preset: ... })
  shared/index.ts                           # re-exports
  web/slots.ts                              # Chart.Preset slot at "ui.chart.preset"
  web/presets.ts                            # builtInPresets with both() helper
  web/index.ts                              # id: "ui-tokens-chart"
  web/internal/config.ts                    # re-export from ../../shared
  web/components/chart-picker.tsx           # 5-dot swatch per preset
  server/index.ts                           # Config.Field(chartConfig)
```

### 5. New plugin: `typography`

4 tokens: `fontSans`, `fontSerif`, `fontMono`, `letterSpacing`.

Default values (mode-independent, uses `both()` helper):
```
fontSans:        'Inter Variable', sans-serif
fontSerif:       ui-serif, Georgia, Cambria, "Times New Roman", Times, serif
fontMono:        'Cascadia Code Variable', monospace
letterSpacing:   0em
```

These match the current hardcoded values in `app.css`, so no visual change on default preset.

**Picker swatch:** "Aa" text sample rendered in `p.light.fontSans`.

**Files to create:**
```
plugins/ui/plugins/tokens/plugins/typography/
  package.json                              # @singularity/plugin-ui-tokens-typography
  shared/group.ts                           # defineTokenGroup("typography", { fontSans: ..., ... })
  shared/config.ts                          # defineConfig({ preset: ... })
  shared/index.ts                           # re-exports
  web/slots.ts                              # Typography.Preset slot at "ui.typography.preset"
  web/presets.ts                            # builtInPresets with both() helper
  web/index.ts                              # id: "ui-tokens-typography"
  web/internal/config.ts                    # re-export from ../../shared
  web/components/typography-picker.tsx      # font-sample swatch
  server/index.ts                           # Config.Field(typographyConfig)
```

### 6. `app.css` — add new variables + comment

**`@theme` block (non-inline) for fonts:**

Fonts must move from `@theme inline` to a separate `@theme` block. With `@theme inline`, Tailwind bakes literal values into utilities (`font-family: 'Inter Variable', sans-serif`), making runtime overrides by the theme-injector invisible. With `@theme` (non-inline), Tailwind emits CSS custom properties and utilities use `var(--font-sans)`, so the theme-injector's `:root` overrides flow through.

```css
@theme {
    --font-sans: 'Inter Variable', sans-serif;
    --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
    --font-mono: 'Cascadia Code Variable', monospace;
}
```

Remove the `--font-sans` and `--font-mono` lines from `@theme inline`. Keep `--font-heading: var(--font-sans)` in `@theme inline` — it's an alias that should track the dynamic value.

**`@theme inline` additions:**
```css
    --color-destructive-foreground: var(--destructive-foreground);
    --color-sidebar-primary: var(--sidebar-primary);
    --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
    --color-chart-1: var(--chart-1);
    --color-chart-2: var(--chart-2);
    --color-chart-3: var(--chart-3);
    --color-chart-4: var(--chart-4);
    --color-chart-5: var(--chart-5);
    --tracking-normal: var(--letter-spacing);
```

No `--spacing` bridge needed — Tailwind v4 uses `--spacing` natively as its base multiplier. The theme-injector sets it directly on `:root`.

**`:root` block** — add comment + new variables after existing ones:
```css
/* Default theme values — overridden at runtime by ThemeInjector. */
:root {
    /* ... existing vars unchanged ... */
    --destructive-foreground: oklch(1 0 0);
    --sidebar-primary: oklch(0.205 0 0);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --chart-1: oklch(0.81 0.10 252);
    --chart-2: oklch(0.62 0.19 260);
    --chart-3: oklch(0.55 0.22 263);
    --chart-4: oklch(0.49 0.22 264);
    --chart-5: oklch(0.42 0.18 266);
    --letter-spacing: 0em;
    --spacing: 0.25rem;
}
```

**`.dark` block** — same comment + new variables:
```css
.dark {
    /* ... existing vars unchanged ... */
    --destructive-foreground: oklch(0.985 0 0);
    --sidebar-primary: oklch(0.488 0.243 264.376);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --chart-1: oklch(0.81 0.10 252);
    --chart-2: oklch(0.62 0.19 260);
    --chart-3: oklch(0.55 0.22 263);
    --chart-4: oklch(0.49 0.22 264);
    --chart-5: oklch(0.42 0.18 266);
    --letter-spacing: 0em;
    --spacing: 0.25rem;
}
```

Note: `--font-sans`, `--font-serif`, `--font-mono` do NOT need `:root`/`.dark` entries because the `@theme` (non-inline) block already emits them as CSS custom properties on `:root`. Adding them again would be redundant.

### 7. Tokens umbrella — wire new groups into global presets

`plugins/ui/plugins/tokens/web/index.ts` — add `chart: "default"` and `typography: "default"` to all 3 global presets.

## Implementation order

1. Patches (1–3) — low risk, modify existing files
2. `app.css` (6) — add all new vars + restructure font declarations
3. Chart plugin (4) — 10 new files
4. Typography plugin (5) — 10 new files
5. Tokens umbrella (7) — wire into global presets
6. `bun install` + `./equin build`

## Verification

1. `./equin build` succeeds
2. Open the app → Settings → UI Themes → verify all 5 token groups appear (Color Palette, Shape, Sidebar Palette, Chart, Typography)
3. Switch global presets (Default, Ocean, Warm) — verify all groups update
4. Inspect computed styles in browser dev tools:
   - `--chart-1` through `--chart-5` present on `:root`
   - `--destructive-foreground` present on `:root` (fixes the bug)
   - `--sidebar-primary` / `--sidebar-primary-foreground` present
   - `--font-sans` / `--font-serif` / `--font-mono` present and dynamic
   - `--letter-spacing` present
   - `--spacing` present
5. Toggle dark mode — verify dark values apply
6. `./equin check` passes
