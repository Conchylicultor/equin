# tweakcn Preset Adapter Plugin

## Context

The theme engine supports token groups (color-palette, sidebar-palette, shape, shadow, chart, typography) with typed presets that drive CSS variable injection. Presets are contributed via a static slot system — contributions are collected once at boot and never change. We want users to import themes from [tweakcn.com](https://tweakcn.com) and have them appear as live presets across all token groups.

The core challenge: the slot system is static (`PluginProvider` collects contributions via `useMemo` and never re-evaluates), but imported themes arrive at runtime. The solution is a **hook-carrier slot** — a static contribution that carries a React hook which produces dynamic data at render time, modeled after the existing `DynamicEnum.Options.useOptions` and `ColorTransformContribution.useAdjustment` patterns.

## tweakcn → equin Mapping

tweakcn's `cssVars` structure maps 1:1 to our 6 token groups (kebab → camelCase conversion):

| tweakcn source | Token group | # tokens | Notes |
|---|---|---|---|
| `light/dark` colors (background, card-foreground, …) | `color-palette` | 19 | kebab → camelCase |
| `light/dark` sidebar-* | `sidebar-palette` | 8 | kebab → camelCase |
| `theme.radius` + `light.spacing` | `shape` | 2 | radius in `theme`, spacing in `light` only |
| `light/dark` shadow-* | `shadow` | 8 | kebab keys pass through verbatim |
| `light/dark` chart-* | `chart` | 5 | kebab keys pass through verbatim |
| `theme` font-* + `light.tracking-normal` | `typography` | 4 | font-sans→fontSans; tracking-normal→letterSpacing |

All tweakcn color values are oklch — same format our groups use. Shape and typography tokens come from `cssVars.theme` (mode-independent), applied identically to both light and dark.

## Architecture

### Plugin location

`plugins/ui/plugins/tweakcn/` — sibling to `tokens` and `theme-engine` under the `ui` umbrella.

### File structure

```
plugins/ui/plugins/tweakcn/
├── package.json
├── core/
│   ├── index.ts                    # barrel
│   └── endpoints.ts                # defineEndpoint declarations
├── shared/
│   ├── index.ts                    # barrel
│   ├── convert.ts                  # tweakcn JSON → per-group preset conversion
│   └── types.ts                    # TweakcnTheme, StoredThemeRow types
├── server/
│   ├── index.ts                    # ServerPluginDefinition
│   └── internal/
│       ├── tables.ts               # tweakcn_themes drizzle table
│       ├── handle-list.ts          # GET /api/tweakcn/themes
│       ├── handle-import.ts        # POST /api/tweakcn/themes
│       └── handle-delete.ts        # DELETE /api/tweakcn/themes/:id
└── web/
    ├── index.ts                    # PluginDefinition
    └── components/
        └── tweakcn-section.tsx      # ThemeCustomizer section UI
```

### 1. ThemeEngine extension — `PresetSource` slot

Add a new slot to `plugins/ui/plugins/theme-engine/web/slots.ts`:

```ts
export interface PresetSourceContribution {
  usePresets: (groupId: string) => TokenGroupPreset[];
}

export const ThemeEngine = {
  // ... existing slots ...
  PresetSource: defineSlot<PresetSourceContribution>(
    "ui.theme-engine.preset-source",
    { docLabel: () => "Preset Source" },
  ),
};
```

### 2. ThemeInjector modification — merge dynamic presets

In `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx`, modify `GroupStyle` to merge dynamic presets from `PresetSource` contributions alongside the group's static `usePresets()`:

```ts
function GroupStyle({ group, presetSources }: {
  group: TokenGroupContribution;
  presetSources: PresetSourceContribution[];
}) {
  const adjustment = useContext(ColorAdjustContext);
  const staticPresets = group.usePresets();
  // Each source's usePresets is a hook — call count is fixed since
  // PresetSource contributions are static slot entries.
  const dynamicPresets = presetSources.flatMap(s => s.usePresets(group.id));
  const presets = [...staticPresets, ...dynamicPresets];
  const config = useConfig(group.configDescriptor) as { preset: string; overrides: Record<string, unknown> };
  const active = presets.find((p) => p.id === config.preset) ?? presets[0] ?? null;
  // ... rest unchanged ...
}
```

And in `ThemeInjector`, read the sources once and pass them down:

```ts
export function ThemeInjector() {
  const groups = ThemeEngine.TokenGroup.useContributions();
  const presetSources = ThemeEngine.PresetSource.useContributions();
  const colorTransforms = ThemeEngine.ColorTransform.useContributions();
  const groupStyles = groups.map((g) => (
    <GroupStyle key={g.id} group={g} presetSources={presetSources} />
  ));
  // ... rest unchanged ...
}
```

**Hooks invariant**: `presetSources` is a static array (slot contributions never change). Calling `s.usePresets(group.id)` in `flatMap` calls a fixed number of hooks per render — React is satisfied. Add an eslint-disable comment for the hooks-in-loop rule.

### 3. DynamicEnum integration — imported presets in pickers

`DynamicEnum.Options` uses `find()` so only one contribution per config field is consumed. We cannot add a second one from tweakcn. Instead, modify each group plugin's existing `DynamicEnum.Options.useOptions` hook to merge from `ThemeEngine.PresetSource`:

```ts
// In each of the 6 group plugins' web/index.ts:
DynamicEnum.Options({
  field: colorPaletteConfig.fields.preset,
  useOptions: () => {
    const staticOpts = ColorPalette.Preset.useContributions()
      .map((p) => ({ value: p.id, label: p.label }));
    const sources = ThemeEngine.PresetSource.useContributions();
    const dynamicOpts = sources
      .flatMap((s) => s.usePresets("color-palette"))
      .map((p) => ({ value: p.id, label: p.label }));
    return [...staticOpts, ...dynamicOpts];
  },
}),
```

This changes 6 files — one per token group. The change is small: extend the `useOptions` lambda.

### 4. DB schema

`plugins/ui/plugins/tweakcn/server/internal/tables.ts`:

```ts
export const _tweakcnThemes = pgTable("tweakcn_themes", {
  id: text("id").primaryKey(),                    // UUID
  tweakcnId: text("tweakcn_id").notNull().unique(), // e.g. "catppuccin"
  label: text("label").notNull(),                  // display name from JSON
  rawJson: jsonb("raw_json").notNull(),            // full fetched JSON for re-conversion
  presets: jsonb("presets").notNull(),              // converted per-group presets
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

`presets` column stores the converted output as:
```ts
{
  "color-palette": { light: Record<string,string>, dark: Record<string,string> },
  "sidebar-palette": { light: ..., dark: ... },
  "shape": { light: ..., dark: ... },
  "shadow": { light: ..., dark: ... },
  "chart": { light: ..., dark: ... },
  "typography": { light: ..., dark: ... },
}
```

### 5. Server endpoints

All in `plugins/ui/plugins/tweakcn/core/endpoints.ts`:

```ts
export const listTweakcnThemes = defineEndpoint({
  route: "GET /api/tweakcn/themes",
  response: z.array(TweakcnThemeSchema),
});

export const importTweakcnTheme = defineEndpoint({
  route: "POST /api/tweakcn/themes",
  body: z.object({ themeId: z.string() }),
  response: TweakcnThemeSchema,
});

export const deleteTweakcnTheme = defineEndpoint({
  route: "DELETE /api/tweakcn/themes/:id",
  response: z.object({ ok: z.boolean() }),
});
```

**Import handler** (`handle-import.ts`):
1. Fetch `https://tweakcn.com/r/themes/${themeId}.json`
2. Validate the response shape (has `cssVars.light`, `cssVars.dark`, `cssVars.theme`)
3. Run through the conversion layer → per-group presets
4. Upsert into `tweakcn_themes` (ON CONFLICT on `tweakcn_id` → update)
5. Notify the `tweakcnThemesResource` (live-state) so UI updates
6. Return the stored row

### 6. Conversion logic

`plugins/ui/plugins/tweakcn/shared/convert.ts`:

Converts the raw tweakcn JSON into per-group preset maps. The conversion is a static mapping — no runtime inference needed:

```ts
export function convertTweakcnTheme(raw: TweakcnRawJson): PerGroupPresets {
  const { light, dark, theme } = raw.cssVars;
  return {
    "color-palette": {
      light: {
        background: light.background,
        foreground: light.foreground,
        card: light.card,
        cardForeground: light["card-foreground"],
        // ... all 19 keys
      },
      dark: { /* same mapping against dark */ },
    },
    "sidebar-palette": {
      light: {
        sidebar: light.sidebar,
        sidebarForeground: light["sidebar-foreground"],
        // ... all 8 keys
      },
      dark: { /* same */ },
    },
    "shape": {
      light: { radius: theme.radius, spacing: light.spacing },
      dark: { radius: theme.radius, spacing: light.spacing },
    },
    "shadow": {
      light: pickKeys(light, SHADOW_KEYS),     // "shadow-2xs" etc. — verbatim
      dark: pickKeys(dark, SHADOW_KEYS),
    },
    "chart": {
      light: pickKeys(light, CHART_KEYS),      // "chart-1" etc. — verbatim
      dark: pickKeys(dark, CHART_KEYS),
    },
    "typography": {
      light: {
        fontSans: theme["font-sans"],
        fontSerif: theme["font-serif"],
        fontMono: theme["font-mono"],
        letterSpacing: light["tracking-normal"],
      },
      dark: {
        fontSans: theme["font-sans"],
        fontSerif: theme["font-serif"],
        fontMono: theme["font-mono"],
        letterSpacing: light["tracking-normal"], // tracking-normal only in light
      },
    },
  };
}
```

### 7. Web plugin — dynamic preset contribution

`plugins/ui/plugins/tweakcn/web/index.ts`:

```ts
export default {
  id: "ui-tweakcn",
  name: "UI: Tweakcn",
  description: "Imports tweakcn themes as dynamic presets across all token groups.",
  contributions: [
    ThemeEngine.PresetSource({
      usePresets: (groupId: string): TokenGroupPreset[] => {
        const { data } = useEndpoint(listTweakcnThemes, {});
        if (!data) return [];
        return data
          .filter((t) => groupId in t.presets)
          .map((t) => ({
            id: `tweakcn:${t.tweakcnId}`,
            label: t.label,
            light: t.presets[groupId].light,
            dark: t.presets[groupId].dark,
          }));
      },
    }),
    ThemeCustomizer.Section({
      id: "tweakcn",
      label: "Import from tweakcn",
      component: TweakcnSection,
    }),
  ],
} satisfies PluginDefinition;
```

The `usePresets` hook calls `useEndpoint` (TanStack Query) which fetches from the server. When a new theme is imported, `invalidates: [listTweakcnThemes]` triggers a refetch, and all consumers (ThemeInjector, pickers) re-render with the new presets.

Preset IDs are prefixed with `tweakcn:` to avoid collisions with built-in preset IDs.

### 8. UI — ThemeCustomizer section

`plugins/ui/plugins/tweakcn/web/components/tweakcn-section.tsx`:

- Text input for the tweakcn theme ID (parsed from URL if full URL pasted)
- "Import" button → `useEndpointMutation(importTweakcnTheme, { invalidates: [listTweakcnThemes] })`
- List of imported themes, each with:
  - Color dot preview (sample the `background` + `primary` colors)
  - Label
  - "Apply" button → sets each group's `preset` config field to `tweakcn:<id>` via `fetchEndpoint(setConfigField)`, following the exact same pattern as `GlobalPresetPicker.handleChange` in `theme-customizer.tsx`
  - "Delete" button → `useEndpointMutation(deleteTweakcnTheme, { invalidates: [listTweakcnThemes] })`

### 9. Live-state resource

Define `tweakcnThemesResource` with `mode: "invalidate"` (the payload is too large for push). `listTweakcnThemes` endpoint result is cached by TanStack Query and invalidated when the resource notifies.

## Files Modified in Existing Plugins

| File | Change |
|---|---|
| `plugins/ui/plugins/theme-engine/web/slots.ts` | Add `PresetSourceContribution` interface + `ThemeEngine.PresetSource` slot |
| `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx` | Pass `presetSources` to `GroupStyle`; merge dynamic presets before finding active |
| `plugins/ui/plugins/tokens/plugins/color-palette/web/index.ts` | Extend `DynamicEnum.Options.useOptions` to merge from `PresetSource` |
| `plugins/ui/plugins/tokens/plugins/sidebar-palette/web/index.ts` | Same |
| `plugins/ui/plugins/tokens/plugins/shape/web/index.ts` | Same |
| `plugins/ui/plugins/tokens/plugins/shadow/web/index.ts` | Same |
| `plugins/ui/plugins/tokens/plugins/chart/web/index.ts` | Same |
| `plugins/ui/plugins/tokens/plugins/typography/web/index.ts` | Same |

## Verification

1. `./equin build` — migration generates for `tweakcn_themes`, no check failures
2. Import a theme: POST to `/api/tweakcn/themes` with `{ themeId: "catppuccin" }` — verify response has all 6 groups with correct camelCase keys
3. Persistence: restart server → GET `/api/tweakcn/themes` returns the theme
4. CSS injection: apply imported theme → inspect `<style id="theme-engine-color-palette">` — oklch values from tweakcn are injected
5. Picker visibility: open ThemeCustomizer Color Palette section → `tweakcn:catppuccin` appears as an option
6. Delete: remove theme → preset disappears from pickers, CSS falls back to previous preset
7. Upsert idempotency: import same ID twice → one row, not two
8. `./equin check --plugin-boundaries` — no boundary violations
