# UI Component Theming System

## Context

We want a plugin-based UI component system where visual components (segmented progress bar, buttons, tabs, etc.) are theme-agnostic. Consumers call `<SegmentedProgressBar />` and the active visual variant is injected via the plugin contribution system. Designers implement variants as sub-plugins. The first use case is the conversation progress bar with two designs (dots, segmented bar) from `research/2026-05-07-conversations-progress-bar-designs.md`.

## Architecture

### Answers to open questions

| Question | Answer |
|---|---|
| **Folder structure** | `plugins/ui/` umbrella; `plugins/ui/plugins/theme-engine/` for central settings; `plugins/ui/plugins/<component>/` for each component with variant sub-plugins |
| **Where the chosen theme lives** | Per-component config field via `defineConfig({ variant: "dots" })` stored in the `config` table (per-worktree Postgres, propagates via DB fork) |
| **How the theme gets injected** | Each component defines a `Variant` slot; variant sub-plugins contribute renderers; the component reads active variant ID from config and picks the matching contribution |
| **Typing** | End-to-end typed via generic `<T extends string>` on the public component — `activeStep` is constrained to match step IDs at the call site |
| **Granularity** | v1: variant selection (pick a renderer). v2: per-variant token customization (CSS custom properties). v3: theme presets (named bundles of variant + token choices across all components) |

### Layers

```
Layer 3 (future): Per-token fine-grained overrides (color pickers, radius sliders)
Layer 2 (done): Token customization — CSS vars overridden via token group presets
Layer 1 (done): Variant selection — pick which renderer draws the component
```

### Dependency graph

```
conversation-progress → @plugins/ui/plugins/segmented-progress-bar/web  (SegmentedProgressBar component)
                              ↓ (reads config)
                        @plugins/config/web  (useConfigValues)

dots variant → @plugins/ui/plugins/segmented-progress-bar/web  (slot import)
segmented variant → @plugins/ui/plugins/segmented-progress-bar/web  (slot import)

segmented-progress-bar → @plugins/ui/plugins/theme-engine/web  (VariantGroup slot)
theme-engine → @plugins/config/web  (Config.Section)
```

No cycles. Theme-engine never imports from component plugins.

## Folder structure

```
plugins/ui/
  web/index.ts                                       # umbrella plugin (label only)
  plugins/
    theme-engine/
      web/
        index.ts                                     # plugin def; contributes Config.Section
        slots.ts                                     # ThemeEngine.VariantGroup slot
        components/variant-settings.tsx              # Settings section: renders all VariantGroup pickers
      shared/index.ts                                # (empty for now; future: preset types)
    segmented-progress-bar/
      shared/
        index.ts                                     # SegmentedProgressBarProps, Step types
      web/
        index.ts                                     # plugin def; exports SegmentedProgressBar + slot; contributes VariantGroup
        slots.ts                                     # SegmentedProgressBar.Variant slot
        components/
          segmented-progress-bar.tsx                 # public <SegmentedProgressBar /> component
          variant-picker.tsx                         # picker UI contributed to ThemeEngine.VariantGroup
        internal/
          config.ts                                  # defineConfig({ variant: "dots" })
      server/
        index.ts                                     # minimal: registers config descriptor
      plugins/
        dots/
          web/
            index.ts                                 # contributes SegmentedProgressBar.Variant
            components/dots-renderer.tsx             # moved from conversation-progress
        segmented/
          web/
            index.ts                                 # contributes SegmentedProgressBar.Variant
            components/segmented-renderer.tsx        # new, from research doc
```

## Detailed design

### 1. Typed props — `plugins/ui/plugins/segmented-progress-bar/shared/index.ts`

```ts
export interface Step {
  id: string;
  label: string;
}

export interface SegmentedProgressBarProps<T extends string = string> {
  steps: readonly { id: T; label: string }[];
  activeStep: T;
  compact?: boolean;
}
```

The generic `T` provides end-to-end type safety: when consumers pass a `const` steps array, TypeScript infers `T` from the step IDs and constrains `activeStep` to match. The `= string` default keeps the slot's `ComponentType<SegmentedProgressBarProps>` usable without explicit instantiation.

Example at the call site:
```ts
const STEPS = [
  { id: "research", label: "Research" },
  { id: "design", label: "Design" },
] as const;

<SegmentedProgressBar steps={STEPS} activeStep="research" />  // ✓ — T inferred as "research" | "design"
<SegmentedProgressBar steps={STEPS} activeStep="invalid" />   // ✗ — type error
```

### 2. Variant slot — `plugins/ui/plugins/segmented-progress-bar/web/slots.ts`

```ts
import { defineSlot } from "@core";
import type { ComponentType } from "react";
import type { SegmentedProgressBarProps } from "../shared";

export interface SegmentedProgressBarVariantContribution {
  id: string;
  label: string;
  component: ComponentType<SegmentedProgressBarProps>;
}

export const SegmentedProgressBar = {
  Variant: defineSlot<SegmentedProgressBarVariantContribution>("ui.segmented-progress-bar.variant"),
};
```

Standard `defineSlot` — same pattern as `FilePane.Renderer` and `JsonlViewer.EventRenderer`. Variant renderers accept `SegmentedProgressBarProps` (with `T = string` — the internal dispatch erases the generic since all variant implementations must handle arbitrary steps).

### 3. Config — `plugins/ui/plugins/segmented-progress-bar/web/internal/config.ts`

```ts
import { defineConfig } from "@plugins/config/shared";

export const segmentedProgressBarConfig = defineConfig({
  variant: { default: "dots", label: "Segmented Progress Bar style" },
});
```

Single `string` scalar field. Stored in the config table as `ui-segmented-progress-bar.variant`.

### 4. Public component — `plugins/ui/plugins/segmented-progress-bar/web/components/segmented-progress-bar.tsx`

```tsx
import { useConfigValues } from "@plugins/config/web";
import { SegmentedProgressBar as Slots } from "../slots";
import { segmentedProgressBarConfig } from "../internal/config";
import type { SegmentedProgressBarProps } from "../../shared";

const PLUGIN_ID = "ui-segmented-progress-bar";

export function SegmentedProgressBar<T extends string>(props: SegmentedProgressBarProps<T>) {
  const variants = Slots.Variant.useContributions();
  const { variant: activeId } = useConfigValues(segmentedProgressBarConfig, PLUGIN_ID);
  const active = variants.find((v) => v.id === activeId) ?? variants[0] ?? null;
  if (!active) return null;
  const Renderer = active.component;
  return <Renderer {...(props as SegmentedProgressBarProps)} />;
}
```

The generic `T` on the public API provides compile-time safety for consumers. The internal dispatch widens to `string` (via the cast) since variant renderers are registered dynamically and handle any steps array.

### 5. Dots variant — `plugins/ui/plugins/segmented-progress-bar/plugins/dots/web/components/dots-renderer.tsx`

Direct adaptation of the existing `ProgressDots` from `conversation-progress`, rewritten to accept `SegmentedProgressBarProps`. Computes `currentIndex = steps.findIndex(s => s.id === activeStep)`. Same visual output.

### 6. Segmented variant — `plugins/ui/plugins/segmented-progress-bar/plugins/segmented/web/components/segmented-renderer.tsx`

From `research/2026-05-07-conversations-progress-bar-designs.md` Design 2, adapted to generic props. In compact mode, renders the same 40px bar (already compact). In non-compact, same 40px bar.

### 7. ThemeEngine.VariantGroup slot — `plugins/ui/plugins/theme-engine/web/slots.ts`

```ts
import { defineSlot } from "@core";
import type { ComponentType } from "react";

export interface VariantGroupContribution {
  componentId: string;
  componentLabel: string;
  component: ComponentType;
}

export const ThemeEngine = {
  VariantGroup: defineSlot<VariantGroupContribution>("ui.theme-engine.variant-group"),
};
```

Each component plugin contributes a picker. The theme-engine Settings section renders all pickers.

### 8. Variant picker — `plugins/ui/plugins/segmented-progress-bar/web/components/variant-picker.tsx`

Small React component that:
- Calls `SegmentedProgressBar.Variant.useContributions()` to list available variants
- Calls `useConfigValues(segmentedProgressBarConfig, PLUGIN_ID)` to get the active selection
- Renders a radio group / select
- Calls `setConfigValue("ui-segmented-progress-bar.variant", id)` on change

Contributed to `ThemeEngine.VariantGroup` by the segmented-progress-bar plugin.

### 9. Migration of conversation-progress

Replace direct `<ProgressDots>` calls with the generic component:

```tsx
// progress-bar-toolbar.tsx / progress-bar-row.tsx
import { SegmentedProgressBar } from "@plugins/ui/plugins/segmented-progress-bar/web";
import { PHASE_ORDER, PHASE_LABELS } from "../../shared/schemas";

const STEPS = PHASE_ORDER.map(p => ({ id: p, label: PHASE_LABELS[p] }));
//    ^? readonly { id: "research" | "design" | "implementation" | "pushed"; label: string }[]

// In component — activeStep is typed to ConversationPhase, which matches step IDs:
<SegmentedProgressBar steps={STEPS} activeStep={progress.phase} compact={compact} />
```

Delete `progress-dots.tsx` from `conversation-progress` (the code moves to dots variant plugin).

### 10. Server config registration — `plugins/ui/plugins/segmented-progress-bar/server/index.ts`

```ts
import type { PluginDefinition } from "@core";
import { segmentedProgressBarConfig } from "../web/internal/config";

export default {
  id: "ui-segmented-progress-bar",
  config: segmentedProgressBarConfig,
} satisfies PluginDefinition;
```

Minimal server barrel — just registers the config field so the PATCH endpoint validates it.

## Implementation order

1. `plugins/ui/web/index.ts` — umbrella plugin definition
2. `plugins/ui/plugins/theme-engine/web/slots.ts` — VariantGroup slot
3. `plugins/ui/plugins/theme-engine/web/components/variant-settings.tsx` — settings section
4. `plugins/ui/plugins/theme-engine/web/index.ts` — plugin def with Config.Section
5. `plugins/ui/plugins/segmented-progress-bar/shared/index.ts` — generic props types
6. `plugins/ui/plugins/segmented-progress-bar/web/internal/config.ts` — config descriptor
7. `plugins/ui/plugins/segmented-progress-bar/web/slots.ts` — Variant slot
8. `plugins/ui/plugins/segmented-progress-bar/web/components/segmented-progress-bar.tsx` — public component
9. `plugins/ui/plugins/segmented-progress-bar/web/components/variant-picker.tsx` — settings picker
10. `plugins/ui/plugins/segmented-progress-bar/web/index.ts` — plugin def
11. `plugins/ui/plugins/segmented-progress-bar/server/index.ts` — config registration
12. `plugins/ui/plugins/segmented-progress-bar/plugins/dots/web/` — dots renderer (move from conversation-progress)
13. `plugins/ui/plugins/segmented-progress-bar/plugins/segmented/web/` — segmented renderer (new)
14. Update `conversation-progress` toolbar/row to use `<SegmentedProgressBar />`
15. Delete old `progress-dots.tsx`
16. Add `package.json` for each new plugin directory

## Verification

1. `./equin build` succeeds (no import errors, config registered)
2. Visit `http://<worktree>.localhost:9000` — progress bars render with dots variant (default)
3. Open Settings → UI Component Variants → change Segmented Progress Bar to "Segmented"
4. Verify the toolbar and sidebar row both switch to the segmented bar
5. Reload the page — selection persists
6. `./equin check` passes (plugin boundaries, eslint)
7. Type-check: passing an invalid `activeStep` string produces a compile error

---

## Level 2: CSS Token Groups

### What this layer adds

Level 1 selected *which renderer* draws a component. Level 2 controls *which values* the renderer uses — border radius, colors, spacing — via CSS custom properties. The result is global theming (switch "ocean" for the whole app) and per-app scoping (the Deploy app always looks "corporate" regardless of the global setting).

### The constraint, reframed

`web/src/theme/CLAUDE.md` says: plugins consume tokens, never define them. Only `web/src/theme/app.css` may declare CSS custom properties.

Level 2 extends this rule, not breaks it: **`app.css` remains the static default layer; the theme-engine plugin is the sole authorized runtime injector.** It owns a single `<style id="theme-engine">` element in `<head>`. No other plugin injects CSS vars. Individual token-group plugins declare their variables and preset values to the theme-engine, which resolves and injects everything in one place.

### Key concepts

| Concept | Definition |
|---|---|
| **Token group** | A named set of CSS custom properties with a shared semantic concern (e.g. `color-palette` owns `--primary`, `--background`, `--muted`, …) |
| **Token group preset** | A named set of concrete values for all variables in a group (e.g. `ocean`: `--primary: oklch(0.55 0.18 230)`) |
| **Global theme preset** | A bundle that selects one preset per token group atomically (e.g. `minimal`: `{ color-palette: "slate", shape: "flat" }`) |
| **Theme scope** | A React subtree where specific token groups are overridden — used by app shells to pin a visual identity independent of the global setting |
| **`defineTokenGroup`** | Framework primitive (lives in `theme-engine/shared`) that declares a group's variable schema; returns a typed descriptor and contributes the group to the theme-engine |

### Token group examples (mapping to the existing shadcn tokens in `app.css`)

The 20+ existing custom properties in `app.css` map naturally to three groups:

**`color-palette`** — semantic palette: `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--border`, `--input`, `--ring`, `--destructive`

**`shape`** — geometry: `--radius` (all Tailwind radius variants derive from this via `calc()`)

**`sidebar-palette`** — sidebar-specific: `--sidebar`, `--sidebar-foreground`, `--sidebar-border`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-ring`

Tailwind utility classes (`bg-primary`, `text-muted-foreground`, `rounded-md`) reference these custom properties via the `@theme inline` block in `app.css`. Updating the CSS vars at runtime is picked up automatically by those classes.

### `defineTokenGroup` primitive

Lives in `plugins/ui/plugins/theme-engine/shared/index.ts` alongside the ThemeEngine slot types. Token-group plugins import from `@plugins/ui/plugins/theme-engine/shared`.

```ts
// theme-engine/shared/index.ts
export interface TokenGroupField {
  default: string;    // initial value (matches app.css :root baseline)
  label?: string;     // shown in fine-grained override UI (v3)
}

export type TokenGroupSchema = Record<string, TokenGroupField>;

export interface TokenGroupDescriptor<T extends TokenGroupSchema> {
  id: string;
  schema: T;
  vars: { [K in keyof T]: string };  // field → CSS var name, e.g. vars.primary === "--primary"
}

export function defineTokenGroup<T extends TokenGroupSchema>(
  id: string,
  schema: T,
): TokenGroupDescriptor<T>;
```

Example — color-palette group:

```ts
// plugins/ui/plugins/tokens/plugins/color-palette/shared/index.ts
import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/shared";

export const colorPaletteGroup = defineTokenGroup("color-palette", {
  primary:            { default: "oklch(0.44 0.09 240)", label: "Primary" },
  primaryForeground:  { default: "oklch(0.985 0 0)",     label: "On primary" },
  background:         { default: "oklch(1 0 0)",          label: "Background" },
  foreground:         { default: "oklch(0.145 0 0)",      label: "Text" },
  muted:              { default: "oklch(0.97 0 0)",       label: "Muted surface" },
  mutedForeground:    { default: "oklch(0.556 0 0)",      label: "Muted text" },
  border:             { default: "oklch(0.922 0 0)",      label: "Border" },
  // … remaining shadcn tokens
});

// colorPaletteGroup.vars.primary === "--primary"
// colorPaletteGroup.vars.mutedForeground === "--muted-foreground"
// (camelCase field → kebab-case CSS var, prefixed with --)
```

Components consume via CSS (no JS import needed):
```css
.button { background-color: var(--primary); color: var(--primary-foreground); }
```

Or via the typed helper to avoid typos:
```tsx
style={{ color: colorPaletteGroup.vars.mutedForeground }}  // "var(--muted-foreground)"
```

### Token group plugin structure

Each group is a plugin under `plugins/ui/plugins/tokens/plugins/<group-name>/`. The canonical example is `color-palette`:

```
plugins/ui/plugins/tokens/plugins/color-palette/
  shared/
    index.ts        # colorPaletteGroup descriptor, ColorPalettePreset type
  web/
    index.ts        # plugin def — contributes ThemeEngine.TokenGroup + ThemeEngine.VariantGroup
    slots.ts        # ColorPalette.Preset slot
    internal/
      config.ts     # defineConfig({ preset: "default" })
    components/
      color-palette-picker.tsx   # select + preview for ThemeEngine.VariantGroup
    presets.ts      # built-in presets contributed to ColorPalette.Preset
```

`slots.ts`:
```ts
import { defineSlot } from "@core";
import type { ColorPaletteTokenValues } from "../shared";

export interface ColorPalettePreset {
  id: string;
  label: string;
  light: ColorPaletteTokenValues;   // values for :root (light mode)
  dark: ColorPaletteTokenValues;    // values for .dark scope
}

export const ColorPalette = {
  Preset: defineSlot<ColorPalettePreset>("ui.color-palette.preset"),
};
```

`presets.ts` (built-in presets, contributed directly in the plugin):
```ts
import { ColorPalette } from "./slots";

ColorPalette.Preset.contribute({
  id: "default",   label: "Default",
  light: { primary: "oklch(0.44 0.09 240)", /* … */ },
  dark:  { primary: "oklch(0.65 0.12 240)", /* … */ },
});
ColorPalette.Preset.contribute({
  id: "ocean",  label: "Ocean",
  light: { primary: "oklch(0.55 0.18 230)", /* … */ },
  dark:  { primary: "oklch(0.70 0.18 230)", /* … */ },
});
```

`web/index.ts` contributes to two theme-engine slots:
```ts
// Registers group with the injector
ThemeEngine.TokenGroup.contribute({
  id: "color-palette",
  label: "Color Palette",
  descriptor: colorPaletteGroup,
  getPresetsHook: () => ColorPalette.Preset.useContributions(),
  configDescriptor: colorPaletteConfig,
  pluginId: "ui-color-palette",
});

// Registers a picker in the Settings pane
ThemeEngine.VariantGroup.contribute({
  componentId: "color-palette",
  componentLabel: "Color Palette",
  component: ColorPalettePicker,
});
```

### Preset extensibility: slots, not sub-plugins

Third-party plugins extend the preset list by contributing to the `ColorPalette.Preset` slot — no new directories needed:

```ts
// In any plugin's index.ts:
import { ColorPalette } from "@plugins/ui/plugins/tokens/plugins/color-palette/web";

ColorPalette.Preset.contribute({
  id: "brand-blue",
  label: "Brand Blue",
  light: { primary: "oklch(0.48 0.21 262)", primaryForeground: "oklch(0.98 0 0)", /* … */ },
  dark:  { primary: "oklch(0.62 0.21 262)", /* … */ },
});
```

Sub-plugins would be overkill here — a preset is pure data (no React components, no logic). The slot contribution pattern handles this cleanly and keeps `plugins/ui/plugins/tokens/plugins/color-palette/presets/` from becoming an unbounded flat list.

### Global theme presets (bundles)

The theme-engine exposes a `ThemeEngine.GlobalPreset` slot for full-app theme bundles:

```ts
export interface GlobalThemePreset {
  id: string;
  label: string;
  groups: Partial<Record<string, string>>;  // groupId → presetId
}
```

Example contributions (from within theme-engine or a companion plugin):
```ts
ThemeEngine.GlobalPreset.contribute({
  id: "default",   label: "Default",
  groups: { "color-palette": "default", "shape": "default" },
});
ThemeEngine.GlobalPreset.contribute({
  id: "ocean",     label: "Ocean",
  groups: { "color-palette": "ocean", "shape": "rounded" },
});
ThemeEngine.GlobalPreset.contribute({
  id: "minimal",   label: "Minimal",
  groups: { "color-palette": "slate", "shape": "sharp" },
});
```

Selecting a global preset atomically sets all per-group preset config values. Per-group pickers still override the bundle's selection.

### CSS injection architecture

Theme-engine renders one `ThemeInjector` component at the app root. It:

1. Reads all `ThemeEngine.TokenGroup` contributions
2. For each group, reads the active preset id from config (`useConfigValues`)
3. Reads the matching preset from the group's preset slot contributions
4. Merges all groups into two CSS variable maps: `{ light, dark }`
5. Renders a single `<style>` element with `:root { … }` and `.dark { … }` blocks

```tsx
// theme-engine/web/components/theme-injector.tsx
function ThemeInjector() {
  const groups = ThemeEngine.TokenGroup.useContributions();
  const css = useResolvedCSS(groups);   // hooks into config + presets per group
  return <style id="theme-engine">{css}</style>;
}
```

Generated output:
```css
:root {
  --primary: oklch(0.55 0.18 230);         /* ocean preset */
  --primary-foreground: oklch(0.98 0 0);
  --radius: 0.5rem;                        /* sharp shape preset */
  /* … */
}
.dark {
  --primary: oklch(0.70 0.18 230);
  /* … */
}
```

This `<style>` tag has higher specificity-position than `app.css` (injected later in `<head>`) so it overrides the static defaults. The static defaults in `app.css` serve as the fallback if the theme-engine hasn't hydrated yet.

### Per-app theme scoping

Apps override token groups for their own subtree via a `<ThemeScope>` component exported from `@plugins/ui/plugins/theme-engine/web`:

```tsx
// plugins/apps/deploy/plugins/shell/web/components/deploy-shell-root.tsx
import { ThemeScope } from "@plugins/ui/plugins/theme-engine/web";

export function DeployShellRoot({ children }) {
  return (
    <ThemeScope presets={{ "color-palette": "corporate" }}>
      {children}
    </ThemeScope>
  );
}
```

`ThemeScope` resolves the named presets to concrete CSS var values and renders a `<div style={cssVars}>` wrapper. CSS variable inheritance does the rest — all descendants inside the scope use the overridden values, while components outside are unaffected.

```tsx
// theme-engine/web/components/theme-scope.tsx
export function ThemeScope({
  presets,
  overrides,
  children,
}: {
  presets?: Partial<Record<string, string>>;   // groupId → presetId
  overrides?: Record<string, string>;          // "--css-var" → value
  children: ReactNode;
}) {
  const cssVars = useResolvedScopeVars(presets, overrides);
  return <div style={cssVars as CSSProperties}>{children}</div>;
}
```

App shells declare their theme statically — no config needed for per-app identity. The global preset picker in Settings only affects components outside any `ThemeScope`.

### Settings UI additions

The theme-engine Settings section is extended to three levels:

```
Settings → UI Themes
  ┌─────────────────────────────────────────────────┐
  │ Theme                                           │
  │  ┌────────────────────────────────────────┐    │
  │  │ Default ▾  (GlobalPreset slot picker)  │    │
  │  └────────────────────────────────────────┘    │
  │                                                 │
  │ Color Palette      [Default ▾]  ← VariantGroup  │
  │ Shape              [Default ▾]  ← VariantGroup  │
  │ Sidebar Palette    [Default ▾]  ← VariantGroup  │
  │                                                 │
  │ Progress Bar style [Dots ▾]     ← Level 1       │
  └─────────────────────────────────────────────────┘
```

The global preset picker calls `setConfigValue` for all group keys atomically when changed. Per-group pickers update their own key only, breaking out of the bundle.

Per-token fine-grained overrides (color pickers, radius sliders) are Layer 3 — deferred.

### Cross-component token dependencies

Components declare CSS var dependencies implicitly through their stylesheets. The token group division acts as a contract:

| Token group | Used by |
|---|---|
| `color-palette` | Buttons, badges, inputs, progress bars — anything with color |
| `shape` | Buttons, cards, dialogs, badges — anything rounded |
| `sidebar-palette` | Sidebar items, sidebar header, nav groups |

No JS-level import is required between, say, `Button` and `color-palette`. The CSS var names (`--primary`, `--radius`) are the interface. The token group plugin just injects the values; the Button component reads them via `var(--primary)` in its CSS.

If a plugin needs TypeScript-safe access to a CSS var name (to avoid typos in `style` props):
```ts
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/shared";
// colorPaletteGroup.vars.primary === "var(--primary)"
```

### Folder structure additions

```
plugins/ui/
  plugins/
    theme-engine/                         # extended from Level 1
      shared/
        index.ts                          # NEW: defineTokenGroup, TokenGroupDescriptor, ThemeEngine slot types
      web/
        index.ts                          # extended: also contributes ThemeRoot to app layout
        slots.ts                          # extended: + TokenGroup slot, GlobalPreset slot
        components/
          theme-injector.tsx              # NEW: renders <style id="theme-engine"> in <head>
          theme-scope.tsx                 # NEW: <ThemeScope> per-app override wrapper
          global-preset-picker.tsx        # NEW: top-level bundle dropdown
          variant-settings.tsx            # extended: adds global picker above per-group pickers
    tokens/                               # NEW umbrella
      web/
        index.ts                          # umbrella plugin def (label only)
      plugins/
        color-palette/
          shared/index.ts                 # colorPaletteGroup descriptor, ColorPalettePreset type
          web/
            index.ts                      # contributes ThemeEngine.TokenGroup + ThemeEngine.VariantGroup
            slots.ts                      # ColorPalette.Preset slot
            internal/config.ts            # defineConfig({ preset: "default" })
            components/
              color-palette-picker.tsx    # preset select with color swatches preview
            presets.ts                    # default, ocean, slate, warm built-in presets
        shape/
          shared/index.ts                 # shapeGroup descriptor (just --radius)
          web/
            index.ts
            slots.ts                      # Shape.Preset slot
            internal/config.ts
            components/shape-picker.tsx   # visual radius preview
            presets.ts                    # sharp, default, rounded, pill
        sidebar-palette/
          shared/index.ts
          web/
            index.ts
            slots.ts                      # SidebarPalette.Preset slot
            internal/config.ts
            components/sidebar-palette-picker.tsx
            presets.ts
```

### Open questions

| Question | Options | Recommendation |
|---|---|---|
| **Dark mode per preset** | (a) Each preset ships `{ light, dark }` — two value sets / (b) dark mode is a separate overlay layer that the user can also theme | (a) for v1 — simplest; each preset author knows their intended dark values. Dark overlay adds complexity for marginal gain. |
| **Config scope** | Per-worktree (existing config plugin) vs user-level (same user, all worktrees) | Per-worktree for v1 — consistent with all other config. A future user-level config primitive can upgrade this. |
| **Flash of default theme** | The static `app.css` defaults show until `ThemeInjector` hydrates | Mitigate: `ThemeInjector` reads config synchronously if config is already cached (live-state TanStack Query). Acceptable for v1; CSS `@starting-style` or SSR would be the full fix. |
| **`app.css` baseline drift** | If defaults in `app.css` diverge from preset `default` values, the FODT flash is visible | Keep `app.css` in sync with the `default` preset's light values. Add a CI check (`./equin check --tokens-in-sync`) that compares them. |
| **App scope declaration** | (a) Wrap in `<ThemeScope>` in the shell component (code) / (b) Contribute to `ThemeEngine.AppScope` slot (data) | (a) for v1 — simpler, no extra slot, more explicit. (b) useful only if we need the theme-engine to enumerate all app scopes, e.g., for a preview thumbnail. |
| **Token group boundary** | Some tokens like `--card` overlap color and surface concerns | Accept fuzzy boundaries for v1 — group tokens by how they're *overridden together* (a palette swap changes all colors), not by their semantic role. |
