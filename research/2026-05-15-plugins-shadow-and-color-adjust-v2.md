# Shadow Token Group + Color Adjust Transform Layer (v2)

v1 → v2: Shadow redesigned to match how tweakcn actually works. Token schema is the 8 Tailwind output tiers with fully-composed box-shadow strings, not the 6 raw input parameters. Presets compute tier strings via `buildShadowTiers()` from 6 input params using tweakcn's `getShadowMap` algorithm. `@theme inline` uses the self-reference trick. Color-adjust unchanged from v1.

## Context

The theme engine has 5 token groups (color-palette, sidebar-palette, chart, shape, typography) with tweakcn parity for those categories. Two capabilities remain:

1. **Shadow** — tweakcn exposes 6 shadow input parameters, bakes them into 8 fully-composed `box-shadow` strings (one per Tailwind tier), and overrides Tailwind's `--shadow-*` theme variables. No other shadcn theme tool does shadow theming.

2. **Color adjustments** — a global oklch transform (hueShift, saturationScale, lightnessScale) applied to all color tokens. Creates grayscale, muted, vibrant, hue-rotated effects without authoring new presets.

---

## Feature 1: Shadow Token Group

New plugin at `plugins/ui/plugins/tokens/plugins/shadow/`.

### Key insight: tokens are output tiers, not input parameters

tweakcn stores the 6 raw parameters (`shadow-color`, `shadow-opacity`, etc.) as `:root` CSS vars for reference only — Tailwind doesn't consume them. What Tailwind consumes are the 8 composed `--shadow-*` tier variables. Our token group follows the same approach: the schema defines the 8 output tiers, and a `buildShadowTiers()` helper computes them from the 6 input parameters.

### Schema (`shared/group.ts`)

Quoted hyphenated keys pass through `camelToKebab` unchanged (same pattern as `chart`'s `"chart-1"` → `--chart-1`):

```ts
export const shadowGroup = defineTokenGroup("shadow", {
  "shadow-2xs": { default: "0 1px 0 0 oklch(0 0 0 / 0.05)" },
  "shadow-xs":  { default: "0 1px 3px 0px oklch(0 0 0 / 0.05)" },
  "shadow-sm":  { default: "0 1px 3px 0px oklch(0 0 0 / 0.10), 0 1px 2px -1px oklch(0 0 0 / 0.10)" },
  "shadow":     { default: "0 1px 3px 0px oklch(0 0 0 / 0.10), 0 1px 2px -1px oklch(0 0 0 / 0.10)" },
  "shadow-md":  { default: "0 1px 3px 0px oklch(0 0 0 / 0.10), 0 2px 4px -1px oklch(0 0 0 / 0.10)" },
  "shadow-lg":  { default: "0 1px 3px 0px oklch(0 0 0 / 0.10), 0 4px 6px -1px oklch(0 0 0 / 0.10)" },
  "shadow-xl":  { default: "0 1px 3px 0px oklch(0 0 0 / 0.10), 0 8px 10px -1px oklch(0 0 0 / 0.10)" },
  "shadow-2xl": { default: "0 1px 3px 0px oklch(0 0 0 / 0.25)" },
});
```

Generated CSS vars: `--shadow-2xs`, `--shadow-xs`, `--shadow-sm`, `--shadow`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, `--shadow-2xl` — exactly what Tailwind v4's shadow utilities expect.

### Shadow tier computation (`shared/shadow-map.ts`)

Replicates tweakcn's `getShadowMap` algorithm. Exported from `shared/` so preset contributors (via the `Shadow.Preset` slot) can use it:

```ts
export interface ShadowParams {
  color: string;    // oklch LCH channels, e.g. "0 0 0"
  opacity: number;  // base opacity, e.g. 0.1
  blur: string;     // e.g. "3px"
  spread: string;   // e.g. "0px"
  offsetX: string;  // e.g. "0"
  offsetY: string;  // e.g. "1px"
}

export function buildShadowTiers(p: ShadowParams): ShadowTokenValues {
  const c = (mult: number) => `oklch(${p.color} / ${(p.opacity * mult).toFixed(2)})`;
  const spread2 = /* spread - 1px */;

  return {
    "shadow-2xs": `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(0.5)}`,
    "shadow-xs":  `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(0.5)}`,
    "shadow-sm":  `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(1.0)}, ${p.offsetX} 1px 2px ${spread2} ${c(1.0)}`,
    "shadow":     `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(1.0)}, ${p.offsetX} 1px 2px ${spread2} ${c(1.0)}`,
    "shadow-md":  `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(1.0)}, ${p.offsetX} 2px 4px ${spread2} ${c(1.0)}`,
    "shadow-lg":  `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(1.0)}, ${p.offsetX} 4px 6px ${spread2} ${c(1.0)}`,
    "shadow-xl":  `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(1.0)}, ${p.offsetX} 8px 10px ${spread2} ${c(1.0)}`,
    "shadow-2xl": `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(2.5)}`,
  };
}
```

The second layer per tier uses fixed offsetY/blur values (matching tweakcn's algorithm) with `spread - 1px` and the same color. `shadow-2xs`, `shadow-xs`, and `shadow-2xl` are single-layer.

### Config (`shared/config.ts`)

```ts
export const shadowConfig = defineConfig({
  preset: { default: "default", label: "Shadow preset" },
});
```

### Presets (`web/presets.ts`)

Each preset calls `buildShadowTiers(params)` and wraps with `both()`:

| Preset | color | opacity | blur | spread | offsetX | offsetY |
|--------|-------|---------|------|--------|---------|---------|
| `default` | 0 0 0 | 0.1 | 3px | 0px | 0 | 1px |
| `none` | 0 0 0 | 0 | 0px | 0px | 0 | 0px |
| `elevated` | 0 0 0 | 0.15 | 8px | 1px | 0 | 4px |
| `heavy` | 0 0 0 | 0.25 | 20px | 4px | 0 | 8px |

All presets use `both()` (mode-independent). Future presets can provide different light/dark by calling `buildShadowTiers` separately per mode.

### Slot (`web/slots.ts`)

```ts
export const Shadow = {
  Preset: defineSlot<ShadowPresetContribution>("ui.shadow.preset", {
    docLabel: (p) => p.label,
  }),
};
```

### Web plugin (`web/index.ts`)

Plugin id: `ui-tokens-shadow`. Contributions: preset slot entries, `ThemeEngine.TokenGroup`, `ThemeEngine.VariantGroup`.

### Server plugin (`server/index.ts`)

`Config.Field(shadowConfig)`.

### Picker component (`web/components/shadow-picker.tsx`)

Preset buttons with a swatch div showing a `box-shadow` preview using the preset's `"shadow"` tier value inline.

### Tailwind v4 bridge (`web/src/theme/app.css`)

**`:root`** and **`.dark`**: static fallback values matching the default preset's composed tier strings.

**`@theme inline`**: self-reference trick — tells Tailwind to read from `:root` at runtime:

```css
@theme inline {
  --shadow-2xs: var(--shadow-2xs);
  --shadow-xs: var(--shadow-xs);
  --shadow-sm: var(--shadow-sm);
  --shadow: var(--shadow);
  --shadow-md: var(--shadow-md);
  --shadow-lg: var(--shadow-lg);
  --shadow-xl: var(--shadow-xl);
  --shadow-2xl: var(--shadow-2xl);
}
```

This is not circular — `@theme inline` defines Tailwind's build-time template; `:root` provides the runtime value. Same pattern tweakcn uses.

### Global presets

Add `shadow: "default"` to all three `GlobalPreset` entries in `plugins/ui/plugins/tokens/web/index.ts`.

### Color-adjust interaction

The color-adjust transform (Feature 2) will try to match oklch values inside shadow tier strings. Shadow colors are typically `oklch(0 0 0 / alpha)` — lightness 0, chroma 0. Scaling these has no visible effect (0 * anything = 0), so shadows stay black under color adjustments. If a custom preset uses a non-neutral shadow color, the transform applies correctly. This is the right behavior with no special-casing needed.

---

## Feature 2: Color Adjust Transform Layer

*Unchanged from v1.* New plugin at `plugins/ui/plugins/tokens/plugins/color-adjust/`.

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

**Transform utility**: `plugins/ui/plugins/theme-engine/web/internal/transform.ts` — owned by theme-engine so ThemeInjector can import it without crossing plugin boundaries.

```ts
const OKLCH_RE = /oklch\(([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)((?:\s*\/\s*[^)]+)?)\)/;

export function transformOklch(value: string, adj: ColorAdjustment): string {
  const m = value.match(OKLCH_RE);
  if (!m) return value;
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

Non-color values don't match the oklch regex and pass through. Shadow tier strings contain multiple `oklch(...)` segments — the regex matches the first one. Need `replaceAll` or `replace` with global flag instead of `match` for shadow strings. Updated approach:

```ts
export function transformOklch(value: string, adj: ColorAdjustment): string {
  return value.replace(OKLCH_RE_GLOBAL, (match, l, c, h, alpha) => {
    const L = Math.min(1, Math.max(0, parseFloat(l) * adj.lightnessScale));
    const C = Math.max(0, parseFloat(c) * adj.saturationScale);
    const H = (((parseFloat(h) + adj.hueShift) % 360) + 360) % 360;
    return `oklch(${L.toFixed(4)} ${C.toFixed(4)} ${H.toFixed(2)}${alpha ?? ""})`;
  });
}
```

This handles multi-oklch values (shadow tiers with two layers) correctly.

### ThemeInjector modification

`plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx`:

```tsx
const DEFAULT_ADJUSTMENT: ColorAdjustment = { hueShift: 0, saturationScale: 1, lightnessScale: 1 };
const ColorAdjustContext = createContext<ColorAdjustment>(DEFAULT_ADJUSTMENT);

function WithAdjustment({ contrib, children }: {
  contrib: ColorTransformContribution;
  children: React.ReactNode;
}) {
  const adj = contrib.useAdjustment();
  return <ColorAdjustContext.Provider value={adj}>{children}</ColorAdjustContext.Provider>;
}

function GroupStyle({ group }: { group: TokenGroupContribution }) {
  const adjustment = useContext(ColorAdjustContext);
  const presets = group.usePresets();
  const config = useConfigValues(group.configDescriptor, group.pluginId) as { preset: string };
  const active = presets.find((p) => p.id === config.preset) ?? presets[0] ?? null;

  useLayoutEffect(() => {
    if (!active) return;
    const id = `theme-engine-${group.id}`;
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) { el = document.createElement("style"); el.id = id; document.head.appendChild(el); }
    const light = buildVarsBlock(group.descriptor, transformValues(active.light, adjustment));
    const dark = buildVarsBlock(group.descriptor, transformValues(active.dark, adjustment));
    el.textContent = `:root {\n${light}\n}\n.dark {\n${dark}\n}`;
    return () => el.remove();
  }, [active, group.descriptor, group.id, adjustment]);

  return null;
}

export function ThemeInjector() {
  const groups = ThemeEngine.TokenGroup.useContributions();
  const colorTransforms = ThemeEngine.ColorTransform.useContributions();
  const groupStyles = groups.map((g) => <GroupStyle key={g.id} group={g} />);

  if (colorTransforms.length === 0) return <>{groupStyles}</>;
  return <WithAdjustment contrib={colorTransforms[0]}>{groupStyles}</WithAdjustment>;
}
```

### Config (`shared/config.ts`)

```ts
export const colorAdjustConfig = defineConfig({
  preset: { default: "default", label: "Color adjust preset" },
  hueShift: { default: 0, label: "Hue shift" },
  saturationScale: { default: 1, label: "Saturation" },
  lightnessScale: { default: 1, label: "Lightness" },
});
```

### Presets

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

### Picker component

Preset chips + 3 sliders (Hue Shift: -180..180 step 1, Saturation: 0..2 step 0.05, Lightness: 0.2..2 step 0.05). Clicking a preset writes all 4 config fields. Sliders read/write via `useConfigValues`/`setConfigValue`.

### Global presets

Add `"color-adjust": "default"` to all three GlobalPreset entries.

---

## File inventory

### New files

**Shadow plugin** (9 files):
- `plugins/ui/plugins/tokens/plugins/shadow/package.json`
- `plugins/ui/plugins/tokens/plugins/shadow/shared/group.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/shared/shadow-map.ts` — `buildShadowTiers()` + `ShadowParams`
- `plugins/ui/plugins/tokens/plugins/shadow/shared/config.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/shared/index.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/web/index.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/web/slots.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/web/presets.ts`
- `plugins/ui/plugins/tokens/plugins/shadow/web/components/shadow-picker.tsx`
- `plugins/ui/plugins/tokens/plugins/shadow/server/index.ts`

**Color-adjust plugin** (8 files):
- `plugins/ui/plugins/tokens/plugins/color-adjust/package.json`
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

- `plugins/ui/plugins/theme-engine/web/slots.ts` — add `ColorAdjustment`, `ColorTransformContribution`, `ThemeEngine.ColorTransform` slot
- `plugins/ui/plugins/theme-engine/web/index.ts` — export new types
- `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx` — ColorAdjustContext, WithAdjustment wrapper, transformValues in GroupStyle
- `plugins/ui/plugins/tokens/web/index.ts` — add `shadow` and `color-adjust` to all GlobalPreset groups
- `web/src/theme/app.css` — add shadow fallback values to `:root`/`.dark`, add `@theme inline` self-reference entries for all 8 shadow tiers

---

## Implementation order

1. **Shadow token group** — all new files, app.css updates, GlobalPreset updates
2. **ThemeEngine slot + transform** — add `ColorTransform` slot, create `transform.ts`, modify ThemeInjector
3. **Color-adjust plugin** — all new files, GlobalPreset updates
4. `./equin build`

## Verification

1. `./equin build` succeeds
2. Open `http://<worktree>.localhost:9000`, go to Settings
3. **Shadow**: "Shadow" picker in UI Themes. Switching presets changes shadow appearance on components using `shadow-*` utilities. Inspect `:root` confirms `--shadow-sm`, `--shadow-md`, etc. contain composed box-shadow strings.
4. **Color Adjust**: Picker with preset chips and sliders. "Grayscale" removes all color. "Vibrant" intensifies. Hue Shift slider rotates colors in real-time. Inspect `:root` oklch values change with slider movement.
5. Global presets still work — "Ocean" applies all groups including shadow=default and color-adjust=default.
6. Shadow + color-adjust interaction: adjusting color has no visible effect on default black shadows (0 * scale = 0).
