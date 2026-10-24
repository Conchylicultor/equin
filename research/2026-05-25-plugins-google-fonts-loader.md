# Dynamic Google Fonts Loading for Typography Presets

## Context

tweakcn presets specify custom fonts (e.g. `'Poppins', sans-serif`) via `fontSans`/`fontMono`/`fontSerif` tokens. When imported, these values get written as CSS variables (`--font-sans: 'Poppins', sans-serif;`) by the ThemeInjector, but the actual font files never load — the browser falls back to the generic family permanently. This plan adds a sub-plugin that dynamically loads referenced Google Fonts when a typography preset is applied, and cleans up when switching away.

## Design

### Location

New sub-plugin: `plugins/ui/plugins/tokens/plugins/typography/plugins/google-fonts/`

Rationale: The concern is purely about typography token values. It sits under the typography group as a modular sub-plugin that can be toggled without affecting anything else. It works for any `PresetSource` (tweakcn or future sources).

### Mechanism

A `Core.Root` component that:
1. Reads the active typography config (`useConfig(typographyConfig)`) and resolves the active preset (same logic as `GroupStyle` in theme-injector.tsx)
2. Extracts font family names from the three font tokens (`fontSans`, `fontSerif`, `fontMono`) across both light and dark modes
3. Filters out system/generic/bundled fonts via a static exclusion set
4. Optionally skips fonts already available via `document.fonts.check()`
5. Injects `<link rel="stylesheet">` tags into `<head>` for each font needing load
6. Removes stale `<link>` tags when the preset changes (surgical diff — only add/remove what changed)

Google Fonts URL: `https://fonts.googleapis.com/css2?family=Font+Name:wght@100..900&display=swap`

The `&display=swap` parameter ensures `font-display: swap` in the returned `@font-face` rules — the browser renders with the fallback immediately and swaps to the web font once loaded (controlled FOUT, no FOIT).

### Race condition handling

The ThemeInjector writes `--font-sans: 'Poppins', sans-serif` via `useLayoutEffect` (synchronous, before paint). The font loader runs in a parallel `useEffect` (async, after paint). Between these two moments, the browser sees the CSS variable referencing "Poppins" but the font isn't loaded yet — thanks to `font-display: swap`, it renders with `sans-serif` and swaps when Poppins arrives. This is the expected behavior.

## File Structure

```
plugins/ui/plugins/tokens/plugins/typography/plugins/google-fonts/
├── package.json
└── web/
    ├── index.ts                         Plugin definition, Core.Root contribution
    └── internal/
        ├── parse-font-families.ts       Pure: CSS font-family string → font name[]
        ├── should-load-font.ts          Pure: font name → boolean (needs Google Fonts?)
        └── google-fonts-loader.tsx       React component (returns null, manages <link> tags)
```

No server/shared/core — purely client-side DOM side effects.

## Implementation Details

### `parse-font-families.ts`

```ts
const GENERIC_FAMILIES = new Set([
  "sans-serif", "serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
  "math", "emoji", "-apple-system", "BlinkMacSystemFont",
]);

export function parseFontFamilies(cssFontFamily: string): string[] {
  return cssFontFamily
    .split(",")
    .map(s => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(s => s && !GENERIC_FAMILIES.has(s));
}
```

Input: `"'Poppins', sans-serif"` → Output: `["Poppins"]`
Input: `"'Fira Code', monospace"` → Output: `["Fira Code"]`

### `should-load-font.ts`

```ts
const BUNDLED_FONTS = new Set(["Inter Variable", "Cascadia Code Variable"]);
const SYSTEM_FONTS = new Set([
  "Georgia", "Cambria", "Times New Roman", "Times",
  "Arial", "Helvetica", "Verdana", "Tahoma",
  "Trebuchet MS", "Impact", "Comic Sans MS",
  "Courier New", "Lucida Console", "Monaco", "Consolas",
  "Segoe UI", "Roboto",  // common OS fonts
]);

export function shouldLoadFont(familyName: string): boolean {
  if (BUNDLED_FONTS.has(familyName)) return false;
  if (SYSTEM_FONTS.has(familyName)) return false;
  if (document.fonts.check(`16px "${familyName}"`)) return false;
  return true;
}
```

### `google-fonts-loader.tsx`

```tsx
export function GoogleFontsLoader() {
  // 1. Read config + resolve active preset (mirrors GroupStyle logic)
  const config = useConfig(typographyConfig);
  const presets = useTokenGroupPresets("typography", Typography.Preset.useContributions());
  const active = presets.find(p => p.id === config.preset) ?? presets[0];

  // 2. Compute all needed font names from light + dark values
  const fontsToLoad = useMemo(() => {
    if (!active) return [];
    const allValues = [active.light, active.dark];
    // Also include non-empty overrides
    const ov = config.overrides as { light?: Record<string, string>; dark?: Record<string, string> };
    if (ov.light) allValues.push(ov.light);
    if (ov.dark) allValues.push(ov.dark);

    const fontNames = new Set<string>();
    for (const values of allValues) {
      for (const key of ["fontSans", "fontSerif", "fontMono"]) {
        const val = values[key];
        if (val) parseFontFamilies(val).forEach(f => fontNames.add(f));
      }
    }
    return [...fontNames].filter(shouldLoadFont).sort();
  }, [active, config.overrides]);

  // 3. Manage <link> tags
  useEffect(() => {
    const prefix = "google-fonts-";
    const existing = new Map<string, HTMLLinkElement>();
    document.querySelectorAll<HTMLLinkElement>(`link[data-google-font]`)
      .forEach(el => existing.set(el.dataset.googleFont!, el));

    const needed = new Set(fontsToLoad);

    // Remove stale
    for (const [name, el] of existing) {
      if (!needed.has(name)) el.remove();
    }

    // Add new
    for (const name of needed) {
      if (existing.has(name)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.dataset.googleFont = name;
      link.href = `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, "+")}:wght@100..900&display=swap`;
      document.head.appendChild(link);
    }
  }, [fontsToLoad]);

  return null;
}
```

### `web/index.ts`

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { GoogleFontsLoader } from "./internal/google-fonts-loader";

export default {
  id: "ui-tokens-typography-google-fonts",
  name: "UI: Typography Google Fonts Loader",
  description: "Loads Google Fonts dynamically for typography presets referencing custom web fonts.",
  contributions: [
    Core.Root({ component: GoogleFontsLoader }),
  ],
} satisfies PluginDefinition;
```

## Key Files to Modify

| File | Action |
|------|--------|
| `plugins/ui/plugins/tokens/plugins/typography/plugins/google-fonts/web/index.ts` | Create — plugin definition |
| `plugins/ui/plugins/tokens/plugins/typography/plugins/google-fonts/web/internal/parse-font-families.ts` | Create — CSS parser |
| `plugins/ui/plugins/tokens/plugins/typography/plugins/google-fonts/web/internal/should-load-font.ts` | Create — font filter |
| `plugins/ui/plugins/tokens/plugins/typography/plugins/google-fonts/web/internal/google-fonts-loader.tsx` | Create — Core.Root component |
| `plugins/ui/plugins/tokens/plugins/typography/plugins/google-fonts/package.json` | Create — workspace package |
| Root `package.json` workspaces | May need to add the new plugin path |

The `./equin build` codegen step should auto-register the plugin in the generated registry.

## Graceful Degradation

- If a font isn't on Google Fonts, the `<link>` returns an empty/minimal stylesheet. The CSS cascade falls through to the next font in the stack. No error handling needed.
- If the network is unavailable, `font-display: swap` means the fallback font renders immediately; the web font loads whenever connectivity returns (or never — no visible breakage).

## Verification

1. Run `./equin build` to deploy
2. Open the app, import a tweakcn theme that uses a custom font (e.g. one using Poppins)
3. Apply the typography preset — verify `<link data-google-font="Poppins">` appears in `<head>`
4. Verify the font renders correctly (DevTools → Elements → Computed style → font-family shows Poppins)
5. Switch to the "Default" preset — verify the `<link>` tag is removed
6. Switch back — verify the font loads again
