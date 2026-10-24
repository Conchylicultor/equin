# Theme Customization Pane

## Context

Theme customization currently lives inside a `Config.Section` in the Settings pane. It shows a `GlobalPresetPicker` (3 buttons) and per-group pickers (small button rows / sliders). Token values are invisible — you can't see hex codes, swatches, or what each token controls. Only a minimal subset of all values is exposed.

**Goal**: Create a dedicated, extensible pane (inspired by tweakcn) that gives full control over every theme token. Each token group plugin registers its own section. Users can see and edit individual token values via color pickers and text inputs.

## Design

### New plugin: `theme-customizer`

Location: `plugins/ui/plugins/theme-engine/plugins/theme-customizer/`

Sub-plugin of theme-engine. Owns the pane and the extensible section slot. Token group plugins contribute sections.

### Extensible section slot

Uses `defineDetailSections<{ search: string }>("theme-customizer")` — same pattern as TaskDetail and PluginView. The `search` prop is passed to every section so they can filter token rows.

### Per-token overrides (config)

Each token group's config gains an `overrides` field (default `"{}"`):

```ts
export const colorPaletteConfig = defineConfig({
  preset: { default: "default", label: "Color Palette preset" },
  overrides: { default: "{}", label: "Color Palette overrides" },
});
```

The value is a JSON string: `{ light?: Record<string, string>, dark?: Record<string, string> }`.

**ThemeInjector** merges overrides onto the active preset before transforming:
```ts
const overrides = JSON.parse((config.overrides as string) || "{}");
const lightValues = { ...active.light, ...(overrides.light ?? {}) };
const darkValues = { ...active.dark, ...(overrides.dark ?? {}) };
```

### Pane layout

```
┌─ PaneChrome: "Theme Customizer" ─────────────┐
│ [Global preset buttons: Default Ocean Warm]   │
│ [🔍 Search tokens...]                         │
│───────────────────────────────────────────────│
│ ▼ COLOR PALETTE          [Default ▾] [Reset]  │
│   ▼ PRIMARY                                   │
│     ● Background  #818cf8  [tweak ↗]          │
│     ● Foreground  #1e1b18  [tweak ↗]          │
│   ▼ SECONDARY                                 │
│     ● Background  #484441  ...                 │
│   ▼ ACCENT  ...                               │
│   ▼ BASE  ...                                 │
│   ...                                         │
│ ▼ SIDEBAR PALETTE        [Default ▾] [Reset]  │
│   ...                                         │
│ ▼ CHART                  [Default ▾] [Reset]  │
│ ▼ SHAPE                  [Default ▾]          │
│ ▼ SHADOW                 [Default ▾]          │
│ ▼ TYPOGRAPHY             [Default ▾]          │
│ ▼ COLOR ADJUST           [Default ▾]          │
└───────────────────────────────────────────────┘
```

Each token row: color swatch (clickable → `ColorPickerPopover`) + label + hex input (editable) + reset button (if overridden).

### Navigation

Add a "Customize" button in the existing `VariantSettings` Config.Section that calls `openPane(themeCustomizerPane, {}, { mode: "root" })`.

## Files

### New files

```
plugins/ui/plugins/theme-engine/plugins/theme-customizer/
├── package.json
├── web/
│   ├── index.ts                      — Plugin definition, Pane.Register
│   ├── slots.ts                      — defineDetailSections<{ search: string }>
│   ├── panes.ts                      — Pane.define
│   └── components/
│       ├── theme-customizer.tsx       — Pane body: global presets + search + Host
│       └── token-row.tsx              — Shared: swatch + label + hex input + reset
```

**Section components** (one per token group):
```
plugins/ui/plugins/tokens/plugins/color-palette/web/components/color-palette-section.tsx
plugins/ui/plugins/tokens/plugins/sidebar-palette/web/components/sidebar-palette-section.tsx
plugins/ui/plugins/tokens/plugins/chart/web/components/chart-section.tsx
plugins/ui/plugins/tokens/plugins/shape/web/components/shape-section.tsx
plugins/ui/plugins/tokens/plugins/shadow/web/components/shadow-section.tsx
plugins/ui/plugins/tokens/plugins/typography/web/components/typography-section.tsx
plugins/ui/plugins/tokens/plugins/color-adjust/web/components/color-adjust-section.tsx
```

### Modified files

| File | Change |
|------|--------|
| `theme-engine/web/components/theme-injector.tsx` | Export `ColorAdjustContext`. Merge overrides onto preset before transform. |
| `theme-engine/web/index.ts` | Re-export `ColorAdjustContext`, `transformValues` |
| `theme-engine/web/components/variant-settings.tsx` | Add "Customize" button with `openPane` |
| `tokens/plugins/color-palette/shared/config.ts` | Add `overrides` field |
| `tokens/plugins/sidebar-palette/shared/config.ts` | Add `overrides` field |
| `tokens/plugins/chart/shared/config.ts` | Add `overrides` field |
| `tokens/plugins/shape/shared/config.ts` | Add `overrides` field |
| `tokens/plugins/shadow/shared/config.ts` | Add `overrides` field |
| `tokens/plugins/typography/shared/config.ts` | Add `overrides` field |
| Each token group `web/index.ts` (6 files) | Add `ThemeCustomizer.Section` contribution |

## Implementation order

1. **Theme-customizer plugin scaffold** — package.json, slots.ts, panes.ts, web/index.ts. Empty pane, registered.

2. **Export internals from theme-engine** — `ColorAdjustContext` (make it a named export in theme-injector.tsx), `transformValues`. Re-export both from theme-engine/web/index.ts.

3. **Config overrides infrastructure** — Add `overrides` field to each token group's config. Update ThemeInjector to merge overrides onto active preset before transform.

4. **Main pane component** — theme-customizer.tsx: global preset picker (adapted from variant-settings.tsx), SearchInput, `<ThemeCustomizer.Host search={search} />`. Add "Customize" button to variant-settings.tsx.

5. **TokenRow component** — Shared display/edit component:
   - For color values: circular swatch (clickable → `ColorPickerPopover`), editable hex input. Use `Color.fromCss(oklchValue).toHex()` for display, `Color.fromCss(hex).toOklch()` on edit → write as override.
   - For non-color values: text input with the raw CSS value.
   - Reset button appears when token has an override.

6. **Color palette section** — 19 tokens in 9 collapsible sub-groups (Primary, Secondary, Accent, Base, Card, Popover, Muted, Destructive, Border & Input). Preset picker row + token list. Reads active preset + overrides, applies color-adjust transform via `useContext(ColorAdjustContext)`.

7. **Sidebar palette section** — 8 tokens in 4 sub-groups.

8. **Chart section** — 5 color tokens, flat list.

9. **Shape section** — 2 tokens (radius, spacing). Text input with a visual preview rectangle showing the border-radius.

10. **Shadow section** — 8 shadow tiers. Text input with a visual preview box showing the box-shadow.

11. **Typography section** — 4 tokens. Text input with "Aa" font preview.

12. **Color-adjust section** — Wraps existing `ColorAdjustPicker` (sliders + presets).

## Key patterns to follow

**Token value resolution** (each section component):
```ts
const config = useConfigValues(groupConfig, PLUGIN_ID);
const presets = GroupSlot.Preset.useContributions();
const adjustment = useContext(ColorAdjustContext);
const active = presets.find(p => p.id === config.preset) ?? presets[0];
const overrides = JSON.parse((config.overrides as string) || "{}");
const lightValues = transformValues({ ...active.light, ...(overrides.light ?? {}) }, adjustment);
const darkValues = transformValues({ ...active.dark, ...(overrides.dark ?? {}) }, adjustment);
```

**Writing an override**:
```ts
function setOverride(key: string, mode: "light" | "dark", value: string) {
  const current = JSON.parse((config.overrides as string) || "{}");
  if (!current[mode]) current[mode] = {};
  current[mode][key] = value;
  void setConfigValue(`${PLUGIN_ID}.overrides`, JSON.stringify(current));
}
```

**Resetting an override**:
```ts
function resetOverride(key: string, mode: "light" | "dark") {
  const current = JSON.parse((config.overrides as string) || "{}");
  if (current[mode]) delete current[mode][key];
  if (current[mode] && Object.keys(current[mode]).length === 0) delete current[mode];
  void setConfigValue(`${PLUGIN_ID}.overrides`, JSON.stringify(current));
}
```

**ColorPickerPopover wiring** (for color tokens):
```tsx
<ColorPickerPopover
  value={Color.fromCss(computedValue)?.toHex() ?? computedValue}
  onChange={(hex) => {
    const oklch = Color.fromCss(hex)?.toOklch();
    if (oklch) setOverride(tokenKey, currentMode, oklch);
  }}
/>
```

**Import paths** (cross-plugin):
- `ThemeCustomizer` slot: `@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web`
- `ColorAdjustContext`, `transformValues`: `@plugins/ui/plugins/theme-engine/web`
- `ColorPickerPopover`, `Color`: `@plugins/primitives/plugins/color-picker/web`
- `Collapsible` etc: `@plugins/primitives/plugins/collapsible/web`
- `SearchInput`: `@plugins/primitives/plugins/search/web`
- `Pane`, `PaneChrome`, `openPane`: `@plugins/primitives/plugins/pane/web`

## Verification

1. `./equin build` succeeds
2. Settings → UI Themes → "Customize" button opens the theme customizer pane
3. All 7 sections render with correct current token values
4. Switching global preset updates all section values live
5. Clicking a color swatch opens ColorPickerPopover; editing the color updates the theme live
6. Editing a hex input updates the theme live
7. Reset button clears an individual override
8. Color-adjust sliders reflect in all displayed values (via ColorAdjustContext)
9. Search filters token rows across all sections
10. Preset name shows "*" indicator when overrides exist
