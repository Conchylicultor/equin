# Shadow Token Group + Color Adjust Transform Layer

## Context

The theme engine has 5 token groups (color-palette, sidebar-palette, chart, shape, typography) with full tweakcn parity for those categories. Two capabilities remain missing:

1. **Shadow** — tweakcn exposes 6 shadow parameters (`shadow-color`, `shadow-opacity`, `shadow-blur`, `shadow-spread`, `shadow-offset-x`, `shadow-offset-y`) that compose into Tailwind's `shadow-*` utilities. Currently the codebase has zero shadow CSS variables; all shadows use Tailwind's built-in defaults.

2. **Color adjustments** — tweakcn exposes a global HSL post-processing transform (`hueShift`, `saturationScale`, `lightnessScale`) applied uniformly to all color tokens. This creates effects like grayscale, muted, vibrant, or hue-rotated themes without authoring new presets. Since our colors are already oklch, the transform maps directly to oklch channels (L/C/H) with no color-space conversion needed.

## Feature 1: Shadow Token Group

New plugin at `plugins/ui/plugins/tokens/plugins/shadow/`. Follows the same structure as `shape/` exactly.

### Schema (`shared/group.ts`)

```ts
export const shadowGroup = defineTokenGroup("shadow", {
  shadowColor:   { default: "oklch(0 0 0)", label: "Shadow color" },
  shadowOpacity: { default: "0.1",          label: "Shadow opacity" },
  shadowBlur:    { default: "3px",          label: "Shadow blur" },
  shadowSpread:  { default: "0px",          label: "Shadow spread" },
  shadowOffsetX: { default: "0px",          label: "Horizontal offset" },
  shadowOffsetY: { default: "1px",          label: "Vertical offset" },
});
```

Generated CSS vars: `--shadow-color`, `--shadow-opacity`, `--shadow-blur`, `--shadow-spread`, `--shadow-offset-x`, `--shadow-offset-y`.

`shadowColor` is per-mode (light/dark can differ). The other 5 are mode-independent (use `both()` helper).

### Config (`shared/config.ts`)

```ts
export const shadowConfig = defineConfig({
  preset: { default: "default", label: "Shadow preset" },
});
```

### Presets (`web/presets.ts`)

| Preset | opacity | blur | spread | offsetX | offsetY | color |
|--------|---------|------|--------|---------|---------|-------|
| `default` | 0.1 | 3px | 0px | 0px | 1px | oklch(0 0 0) |
| `none` | 0 | 0px | 0px | 0px | 0px | oklch(0 0 0) |
| `elevated` | 0.15 | 8px | 1px | 0px | 4px | oklch(0 0 0) |
| `heavy` | 0.25 | 20px | 4px | 0px | 8px | oklch(0 0 0) |

All presets use the same value for light/dark except `shadowColor` which could differ per-mode in future presets. Initial presets use `oklch(0 0 0)` for both.

### Slot (`web/slots.ts`)

```ts
export const Shadow = {
  Preset: defineSlot<ShadowPresetContribution>("ui.shadow.preset", {
    docLabel: (p) => p.label,
  }),
};
```

### Web plugin (`web/index.ts`)

Contributions:
- `...builtInPresets.map(p => Shadow.Preset(p))`
- `ThemeEngine.TokenGroup({ id: "shadow", ... })` — registers with ThemeInjector
- `ThemeEngine.VariantGroup({ componentId: "shadow", ... })` — registers picker in settings UI

Plugin id: `ui-tokens-shadow`.

### Server plugin (`server/index.ts`)

Just `Config.Field(shadowConfig)`.

### Picker component (`web/components/shadow-picker.tsx`)

Renders preset buttons with a small swatch showing a `box-shadow` preview composed from the preset's values. Pattern: copy `shape-picker.tsx`, replace swatch rendering.

### Tailwind v4 bridge (`web/src/theme/app.css`)

Add shadow fallbacks to `:root` and `.dark`, then compose into Tailwind shadow tiers in `@theme inline`:

```css
/* In @theme inline: */
--shadow-2xs: 0 calc(var(--shadow-offset-y) * 0.5) 0 0
  color-mix(in oklch, var(--shadow-color) calc(var(--shadow-opacity) * 50%), transparent);
--shadow-xs: 0 var(--shadow-offset-y) calc(var(--shadow-blur) * 0.33) 0
  color-mix(in oklch, var(--shadow-color) calc(var(--shadow-opacity) * 50%), transparent);
--shadow-sm: var(--shadow-offset-x) var(--shadow-offset-y) calc(var(--shadow-blur) * 0.5) var(--shadow-spread)
  color-mix(in oklch, var(--shadow-color) calc(var(--shadow-opacity) * 80%), transparent);
--shadow: var(--shadow-offset-x) var(--shadow-offset-y) var(--shadow-blur) var(--shadow-spread)
  color-mix(in oklch, var(--shadow-color) calc(var(--shadow-opacity) * 100%), transparent);
--shadow-md: var(--shadow-offset-x) calc(var(--shadow-offset-y) * 2) calc(var(--shadow-blur) * 2) calc(var(--shadow-spread) + 1px)
  color-mix(in oklch, var(--shadow-color) calc(var(--shadow-opacity) * 100%), transparent);
--shadow-lg: var(--shadow-offset-x) calc(var(--shadow-offset-y) * 4) calc(var(--shadow-blur) * 4) calc(var(--shadow-spread) + 2px)
  color-mix(in oklch, var(--shadow-color) calc(var(--shadow-opacity) * 100%), transparent);
--shadow-xl: var(--shadow-offset-x) calc(var(--shadow-offset-y) * 8) calc(var(--shadow-blur) * 6) calc(var(--shadow-spread) + 3px)
  color-mix(in oklch, var(--shadow-color) calc(var(--shadow-opacity) * 100%), transparent);
--shadow-2xl: var(--shadow-offset-x) calc(var(--shadow-offset-y) * 12) calc(var(--shadow-blur) * 10) calc(var(--shadow-spread) + 4px)
  color-mix(in oklch, var(--shadow-color) calc(var(--shadow-opacity) * 150%), transparent);
```

This replaces Tailwind's built-in shadow defaults with themeable versions. `calc()` and `color-mix()` in `@theme inline` resolve at browser runtime (same pattern as the existing `--radius-sm: calc(var(--radius) * 0.6)`).

### Global presets

Add `shadow: "default"` to all three `GlobalPreset` entries in `plugins/ui/plugins/tokens/web/index.ts`.

---

## Feature 2: Color Adjust Transform Layer

New plugin at `plugins/ui/plugins/tokens/plugins/color-adjust/`. Unlike token groups, this doesn't define CSS variables — it's a transform layer that modifies color token values before they're written to the DOM.

### Architecture

**New slot**: `ThemeEngine.ColorTransform` in `plugins/ui/plugins/theme-engine/web/slots.ts`.

```ts
export interface ColorAdjustment {
  hueShift: number;        // -180 to 180 (degrees, maps to oklch H)
  saturationScale: number; // 0 to 2 (multiplier on oklch C)
  lightnessScale: number;  // 0.2 to 2 (multiplier on oklch L)
}

export interface ColorTransformContribution {
  useAdjustment: () => ColorAdjustment;
}
```

The contribution's `useAdjustment` is a React hook (calls `useConfigValues` internally). ThemeInjector calls it from within a React component tree.

**Transform utility**: `plugins/ui/plugins/theme-engine/web/internal/transform.ts` — owned by theme-engine (not color-adjust), since ThemeInjector needs to import it without crossing plugin boundaries.

```ts
const OKLCH_RE = /oklch\(([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)((?:\s*\/\s*[^)]+)?)\)/;

export function transformOklch(value: string, adj: ColorAdjustment): string {
  const m = value.match(OKLCH_RE);
  if (!m) return value; // not a color string, pass through unchanged
  const L = Math.min(1, Math.max(0, parseFloat(m[1]) * adj.lightnessScale));
  const C = Math.max(0, parseFloat(m[2]) * adj.saturationScale);
  const H = (((parseFloat(m[3]) + adj.hueShift) % 360) + 360) % 360;
  const alpha = m[4] ?? "";
  return `oklch(${L.toFixed(4)} ${C.toFixed(4)} ${H.toFixed(2)}${alpha})`;
}

export function transformValues(
  values: Record<string, string>,
  adj: ColorAdjustment,
): Record<string, string> {
  if (adj.hueShift === 0 && adj.saturationScale === 1 && adj.lightnessScale === 1) {
    return values; // identity — skip parsing
  }
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, transformOklch(v, adj)]),
  );
}
```

Non-color values (like `0.625rem`, `0.25rem`) don't match the oklch regex and pass through untouched, so the transform is safe to apply to all token groups indiscriminately.

### ThemeInjector modification

`plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx` — the core change:

```tsx
// New: context for color adjustment
const DEFAULT_ADJUSTMENT: ColorAdjustment = { hueShift: 0, saturationScale: 1, lightnessScale: 1 };
const ColorAdjustContext = createContext<ColorAdjustment>(DEFAULT_ADJUSTMENT);

// WithAdjustment calls the contribution's hook (React-rules-compliant)
function WithAdjustment({ contrib, children }: {
  contrib: ColorTransformContribution;
  children: React.ReactNode;
}) {
  const adj = contrib.useAdjustment();
  return <ColorAdjustContext.Provider value={adj}>{children}</ColorAdjustContext.Provider>;
}

// GroupStyle reads adjustment from context
function GroupStyle({ group }: { group: TokenGroupContribution }) {
  const adjustment = useContext(ColorAdjustContext);
  // ... existing preset resolution ...
  // Apply transform before buildVarsBlock:
  const light = buildVarsBlock(group.descriptor, transformValues(active.light, adjustment));
  const dark = buildVarsBlock(group.descriptor, transformValues(active.dark, adjustment));
  // ... write to <style> tag ...
}

// ThemeInjector wraps groups in the adjustment provider
export function ThemeInjector() {
  const groups = ThemeEngine.TokenGroup.useContributions();
  const colorTransforms = ThemeEngine.ColorTransform.useContributions();
  const groupStyles = groups.map(g => <GroupStyle key={g.id} group={g} />);

  if (colorTransforms.length === 0) {
    return <>{groupStyles}</>;
  }
  return <WithAdjustment contrib={colorTransforms[0]}>{groupStyles}</WithAdjustment>;
}
```

Key design: `WithAdjustment` is a separate component so the hook call is unconditional within it. If no `ColorTransform` contribution exists (plugin not loaded), the default identity adjustment flows through context and `transformValues` short-circuits.

### Config (`shared/config.ts`)

```ts
export const colorAdjustConfig = defineConfig({
  preset: { default: "default", label: "Color adjust preset" },
  hueShift: { default: 0, label: "Hue shift" },
  saturationScale: { default: 1, label: "Saturation" },
  lightnessScale: { default: 1, label: "Lightness" },
});
```

`defineConfig` supports `number` defaults (verified: `kindOf` returns `"number"` for finite numbers).

### Presets (`web/presets.ts`)

```ts
interface ColorAdjustPreset {
  id: string;
  label: string;
  hueShift: number;
  saturationScale: number;
  lightnessScale: number;
}
```

| Preset | hueShift | saturation | lightness |
|--------|----------|------------|-----------|
| `default` | 0 | 1 | 1 |
| `grayscale` | 0 | 0 | 1 |
| `muted` | 0 | 0.6 | 1 |
| `vibrant` | 0 | 1.4 | 1 |
| `dimmer` | 0 | 1 | 0.8 |
| `brighter` | 0 | 1 | 1.2 |
| `warm-shift` | 30 | 0.5 | 0.95 |
| `hue-60` | 60 | 1 | 1 |
| `hue-neg-60` | -60 | 1 | 1 |
| `hue-120` | 120 | 1 | 1 |
| `hue-neg-120` | -120 | 1 | 1 |
| `invert-hue` | 180 | 1 | 1 |

### Slot (`web/slots.ts`)

```ts
export const ColorAdjust = {
  Preset: defineSlot<ColorAdjustPresetContribution>("ui.color-adjust.preset", {
    docLabel: (p) => p.label,
  }),
};
```

### Web plugin (`web/index.ts`)

Contributions:
- `...builtInPresets.map(p => ColorAdjust.Preset(p))`
- `ThemeEngine.ColorTransform({ useAdjustment: () => { ... useConfigValues ... } })`
- `ThemeEngine.VariantGroup({ componentId: "color-adjust", componentLabel: "Color Adjust", component: ColorAdjustPicker })`

Plugin id: `ui-tokens-color-adjust`.

### Picker component (`web/components/color-adjust-picker.tsx`)

Two sections:
1. **Preset chips** — row of buttons, one per preset. Clicking writes all 4 config fields (preset, hueShift, saturationScale, lightnessScale).
2. **Sliders** — three range inputs for fine-tuning:
   - Hue Shift: -180 to 180, step 1
   - Saturation: 0 to 2, step 0.05
   - Lightness: 0.2 to 2, step 0.05

Sliders read/write via `useConfigValues(colorAdjustConfig, PLUGIN_ID)` and `setConfigValue`.

### Global presets

Add `"color-adjust": "default"` to all three GlobalPreset entries in `plugins/ui/plugins/tokens/web/index.ts`.

---

## File inventory

### New files

**Shadow plugin** (8 files):
- `plugins/ui/plugins/tokens/plugins/shadow/package.json`
- `plugins/ui/plugins/tokens/plugins/shadow/shared/group.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/shared/config.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/shared/index.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/web/index.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/web/slots.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/web/presets.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/web/components/shadow-picker.tsx`
- `plugins/ui/plugins/tokens/plugins/shadow/server/index.ts`

**Color-adjust plugin** (9 files):
- `plugins/ui/plugins/tokens/plugins/color-adjust/package.json`
- `plugins/ui/plugins/tokens/plugins/color-adjust/shared/types.ts`
- `plugins/ui/plugins/tokens/plugins/color-adjust/shared/config.ts`
- `plugins/ui/plugins/tokens/plugins/color-adjust/shared/index.ts`
- `plugins/ui/plugins/tokens/plugins/color-adjust/web/index.ts`
- `plugins/ui/plugins/tokens/plugins/color-adjust/web/slots.ts`
- `plugins/ui/plugins/tokens/plugins/color-adjust/web/presets.ts`
- `plugins/ui/plugins/tokens/plugins/color-adjust/web/components/color-adjust-picker.tsx`
- `plugins/ui/plugins/tokens/plugins/color-adjust/server/index.ts`

**Theme engine additions** (1 new file):
- `plugins/ui/plugins/theme-engine/web/internal/transform.ts`

### Modified files

- `plugins/ui/plugins/theme-engine/web/slots.ts` — add `ColorAdjustment` type, `ColorTransformContribution` interface, `ThemeEngine.ColorTransform` slot
- `plugins/ui/plugins/theme-engine/web/index.ts` — export new types
- `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx` — add ColorAdjustContext, WithAdjustment, transform application
- `plugins/ui/plugins/tokens/web/index.ts` — add `shadow` and `color-adjust` to all GlobalPreset groups
- `web/src/theme/app.css` — add shadow fallbacks to `:root`/`.dark`, add shadow tier composition to `@theme inline`

---

## Implementation order

1. **Shadow token group** — all new files, then app.css updates, then GlobalPreset updates
2. **ThemeEngine slot + transform** — add `ColorTransform` slot, create `transform.ts`, modify ThemeInjector
3. **Color-adjust plugin** — all new files, then GlobalPreset updates
4. `./equin build` — auto-generates plugin registries, applies migrations (none needed — no DB schema), builds frontend and server

## Verification

1. `./equin build` succeeds
2. Open `http://<worktree>.localhost:9000`, go to Settings
3. **Shadow**: "Shadow" picker appears in UI Themes section. Switching presets changes shadow appearance on cards/popovers using `shadow` utilities. Inspect element confirms `--shadow-color`, `--shadow-blur` etc. in `:root`.
4. **Color Adjust**: "Color Adjust" picker appears with preset chips and sliders. Selecting "Grayscale" removes all color. Selecting "Vibrant" intensifies colors. Dragging Hue Shift slider rotates all colors in real-time. Inspect element confirms oklch values in `:root` change as sliders move.
5. Global presets still work — selecting "Ocean" applies all groups including shadow=default and color-adjust=default.
