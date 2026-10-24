# Color Picker Primitive

## Context

No color picker exists in the codebase. The avatar plugin has an inline swatch row tightly coupled to avatar semantics, and theme token pickers use preset selectors. A general-purpose color picker primitive would serve both existing and future use cases (custom theme colors, annotation colors, chart series colors, etc.).

The codebase already uses OKLCH for theme tokens (`app.css`), making it the natural internal color space. The picker will be zero-dependency (no npm additions) — pure canvas, CSS gradients, and pointer events.

## Design

### Internal color model: `Color` class

OKLCH-based immutable value class with static constructors and serializers:

```ts
class Color {
  readonly l: number;  // lightness [0, 1]
  readonly c: number;  // chroma [0, ~0.4]
  readonly h: number;  // hue [0, 360)
  readonly alpha: number;

  static fromHex(hex: string): Color
  static fromOklch(l: number, c: number, h: number, alpha?: number): Color
  static fromCss(css: string): Color | null

  toHex(): string       // "#rrggbb" or "#rrggbbaa"
  toOklch(): string     // "oklch(L C H)"
  toHsl(): string
  withAlpha(a: number): Color
  equals(other: Color): boolean
}
```

Conversion chain: OKLCH ↔ OKLab ↔ linear sRGB ↔ gamma sRGB ↔ hex. All formulas from CSS Color Level 4.

### Composable sub-components

Each usable independently or composed into the full `ColorPicker`:

| Component | Description | Key props |
|-----------|-------------|-----------|
| `ColorArea` | 2D canvas gradient (X=chroma, Y=lightness). 64×64 pixel sampling for accurate OKLCH. | `hue, lightness, chroma, onChange(l, c)` |
| `HueSlider` | Horizontal 0-360° CSS gradient strip with thumb. | `value, onChange(hue)` |
| `AlphaSlider` | Checkerboard + color→transparent gradient with thumb. | `color, alpha, onChange(alpha)` |
| `ColorInput` | Hex text input with preview swatch. Validates on blur/Enter, reverts on invalid. | `color, onChange(color)` |
| `SwatchGrid` | Preset swatch buttons with ring selection (matches avatar pattern). | `colors[], value?, onChange(color)` |
| `ColorPicker` | Full assembly: optional swatches + area + hue + optional alpha + input. | `value (CSS string), onChange, swatches?, showAlpha?` |
| `ColorPickerPopover` | Popover-wrapped picker. Default trigger is a colored swatch button. | Same as ColorPicker + `children?` |

### Shared `useColorDrag` hook

Pointer-capture-based drag for area + sliders. Normalizes position to `[0,1]` in both axes. Handles `pointerdown/move/up/cancel` via `setPointerCapture`.

## File layout

```
plugins/primitives/plugins/color-picker/
├── package.json                          # @singularity/plugin-primitives-color-picker
└── web/
    ├── index.ts                          # PluginDefinition + barrel exports
    └── internal/
        ├── color.ts                      # Color utility class (OKLCH math)
        ├── use-color-drag.ts             # Shared pointer-drag hook
        ├── color-area.tsx                # 2D saturation/lightness canvas
        ├── hue-slider.tsx               # Hue strip slider
        ├── alpha-slider.tsx             # Alpha slider with checkerboard
        ├── color-input.tsx              # Hex text input + preview swatch
        ├── swatch-grid.tsx              # Preset color grid
        ├── color-picker.tsx             # Assembled full picker
        └── color-picker-popover.tsx     # Popover wrapper
```

## Rendering approach

- **ColorArea**: 64×64 `<canvas>` with pixel-by-pixel OKLCH sampling (accurate, performant). Redraws only when `hue` changes. CSS stretches to container size. Positioned thumb overlay.
- **HueSlider**: `linear-gradient(to right, oklch(0.6 0.25 0), ..., oklch(0.6 0.25 360))` with 7 stops. No canvas.
- **AlphaSlider**: Inline-styled checkerboard CSS pattern, overlaid gradient div.
- **Thumbs**: `size-4 rounded-full border-2 border-white ring-1 ring-black/30` — visible on any background.
- **Swatch selection**: `scale-110 ring-2 ring-ring ring-offset-1 ring-offset-background` (identical to avatar-picker).

## Key reference files

- `plugins/primitives/plugins/avatar/web/components/avatar-picker.tsx` — popover layout, swatch ring pattern
- `plugins/primitives/plugins/avatar/web/internal/colors.ts` — color palette structure
- `plugins/primitives/plugins/popover/web/index.ts` — barrel pattern
- `plugins/primitives/plugins/section-label/web` — section headers inside picker

## Verification

1. `./equin build` — TypeScript compiles, plugin auto-discovered
2. `./equin check --plugin-boundaries` — no forbidden imports
3. Playwright screenshot of the picker in light + dark mode
4. Interactive test: open popover, drag color area, verify hex input updates, type hex, verify area updates
5. Edge cases: out-of-gamut OKLCH clamps correctly, invalid hex reverts, `showAlpha=false` hides alpha slider
