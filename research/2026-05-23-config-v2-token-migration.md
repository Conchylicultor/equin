# Config v2: Token Group Plugin Migration

## Context

Six token group plugins (shape, chart, typography, sidebar-palette, color-palette, shadow) store their theme settings via config v1 (DB-backed). Their `overrides` and `params` fields store `Record<string, string>` as JSON strings — opaque blobs that bypass config's type system. Migrating to config_v2 gives: typed JSONC files on disk, git-layer team defaults, reactive `useConfig` hooks, and human/agent-editable config files.

The seventh token plugin (`color-adjust`) is already on config_v2 but is a `ColorTransform` contributor, not a `TokenGroup` — it didn't need the overrides pattern.

## Design model

Every theme value follows the same pattern:

1. **Presets define defaults** — background color, shadow opacity, border radius, etc.
2. **Config stores user overrides** — only values the user explicitly changed
3. **Theme resolution merges and computes** — preset baseline + overrides → final CSS vars

For most groups, step 3 is a simple merge (the override IS the final CSS value). For shadow, step 3 includes a computation: 6 params (opacity, blur, ...) → 8 CSS shadow tiers via `buildShadowTiers()`. This computation belongs in the resolution layer, not at write time.

### Current code vs this model

The current code violates this model for shadow. Shadow pre-computes the CSS tiers at **write time** in `shadow-section.tsx` and stores both `params` (user intent) AND `overrides` (pre-computed CSS) in config. This exists because the ThemeInjector is dumb — it only knows how to merge, not compute. The fix: add an optional `resolve` function to `TokenGroupContribution` so each group can define its own resolution step.

## Blockers discovered

### 1. objectField doesn't support sparse values

Token overrides are sparse — `{}` means "no overrides." But objectField's Zod schema requires all declared keys. Missing keys cause `safeParse` to fail, and `readTypedConfig` falls back to full defaults.

**Fix:** In `object.ts` line 38, wrap each sub-field schema with `.default(f.defaultValue)`:
```ts
subShape[key] = field.schema.default(field.defaultValue);
```
Safe: no existing plugin uses objectField yet.

### 2. ThemeInjector hardcodes config v1 API

`theme-injector.tsx:51` calls `useConfigValues(group.configDescriptor, group.pluginId)` (v1). `TokenGroupContribution.configDescriptor` is typed as v1 `ConfigDescriptor`. Both must be updated to v2.

### 3. theme-customizer uses v1 imperative writes in a loop

`theme-customizer.tsx:31` calls `setConfigValue(...)` in a for-loop. v2's `useSetConfig` is a hook (can't call in loops). Solution: use `useConfigRegistrations()` to get `storePath` per descriptor, then call `fetchEndpoint(setConfigField, ...)` directly.

### 4. No `resolve` step in ThemeInjector

ThemeInjector does a flat merge for all groups. Shadow needs a computation step (params → CSS tiers). Currently shadow works around this by pre-computing at write time and storing redundant data (`params` + `overrides`).

## Implementation

### Phase 1: Framework primitives

#### 1a. Fix objectField `.default()` wrapping

**File:** `plugins/config_v2/plugins/fields/plugins/object/core/internal/object.ts`

Line 38: `subShape[key] = field.schema;` → `subShape[key] = field.schema.default(field.defaultValue);`

This makes all objectField sub-fields resilient to missing keys — they get their declared defaults instead of causing parse failures. Empty string `""` default for textField sub-fields means "not overridden."

### Phase 2: ThemeEngine bridge

#### 2a. Update `TokenGroupContribution` interface

**File:** `plugins/ui/plugins/theme-engine/web/slots.ts`

```ts
// Before:
import type { ConfigDescriptor } from "@plugins/config/core";
export interface TokenGroupContribution {
  id: string;
  label: string;
  descriptor: TokenGroupDescriptor;
  usePresets: () => TokenGroupPreset[];
  configDescriptor: ConfigDescriptor;
  pluginId: string;
}

// After:
import type { ConfigDescriptor } from "@plugins/config_v2/core";
export interface TokenGroupContribution {
  id: string;
  label: string;
  descriptor: TokenGroupDescriptor;
  usePresets: () => TokenGroupPreset[];
  configDescriptor: ConfigDescriptor;
  // pluginId removed — v2 doesn't need it
  resolve?: (
    preset: TokenGroupPreset,
    overrides: Record<string, unknown>,
  ) => { light: Record<string, string>; dark: Record<string, string> };
}
```

`resolve` is optional. When absent, ThemeInjector does the default merge. When present, the group controls how overrides become final CSS values.

#### 2b. Update ThemeInjector

**File:** `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx`

- Replace `useConfigValues` (v1) with `useConfig` (v2)
- Remove `JSON.parse(config.overrides)` — overrides is now a structured object
- Add `resolve` dispatch:

```ts
const config = useConfig(group.configDescriptor) as { preset: string; overrides: Record<string, unknown> };
const active = presets.find((p) => p.id === config.preset) ?? presets[0];

let mergedLight: Record<string, string>;
let mergedDark: Record<string, string>;

if (group.resolve) {
  ({ light: mergedLight, dark: mergedDark } = group.resolve(active, config.overrides));
} else {
  // Default: overrides is { light: Record<string,string>, dark: Record<string,string> }
  const ov = config.overrides as { light: Record<string, string>; dark: Record<string, string> };
  mergedLight = { ...active.light };
  mergedDark = { ...active.dark };
  for (const [k, v] of Object.entries(ov.light)) {
    if (v !== "") mergedLight[k] = v;
  }
  for (const [k, v] of Object.entries(ov.dark)) {
    if (v !== "") mergedDark[k] = v;
  }
}
```

Empty string `""` means "not overridden" — skip it and use the preset value.

#### 2c. Update theme-customizer global preset write

**File:** `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx`

In `GlobalPresetPicker`:
```ts
const registrations = useConfigRegistrations();

// In handleChange, replace setConfigValue with:
const reg = registrations.find((r) => r.descriptor === group.configDescriptor);
if (reg) {
  void fetchEndpoint(setConfigField, {}, {
    body: { storePath: reg.storePath, key: "preset", value: groupPresetId }
  });
}
```

### Phase 3: Migrate token plugins

Order by complexity: **shape → chart → typography → sidebar-palette → color-palette → shadow**.

#### Per-plugin template (all except shadow)

Config sub-fields are derived from the token group descriptor — no duplication:

**`shared/config.ts`:**
```ts
import { defineConfig } from "@plugins/config_v2/core";
import { textField } from "@plugins/config_v2/plugins/fields/plugins/primitives/core";
import { objectField } from "@plugins/config_v2/plugins/fields/plugins/object/core";
import { shapeGroup } from "./group";

// Derive sub-fields from the token group schema — single source of truth
const tokenSubFields = Object.fromEntries(
  Object.entries(shapeGroup.schema).map(
    ([key, { label }]) => [key, textField({ default: "", label })]
  )
);

export const shapeConfig = defineConfig({
  fields: {
    preset: textField({ default: "default", label: "Shape preset" }),
    overrides: objectField({
      label: "Token overrides",
      subFields: {
        light: objectField({ subFields: tokenSubFields }),
        dark: objectField({ subFields: tokenSubFields }),
      },
    }),
  },
});
```

Default `""` (empty string) = "not overridden, use preset value." Non-empty = user override.

**`server/index.ts`** — `Config.Field(config)` → `ConfigV2.Register({ descriptor: config })`

**`web/index.ts`** — add `ConfigV2.WebRegister({ descriptor: config })`, remove `pluginId` from `TokenGroup` contribution

**`web/components/*-section.tsx`:**
- `useConfigValues(config, PLUGIN_ID)` → `useConfig(config)`
- `setConfigValue(\`${PLUGIN_ID}.x\`, v)` → `setConfig("x", v)` via `useSetConfig(config)`
- Remove all `JSON.parse`/`JSON.stringify`
- `config.overrides` is now `{ light: { [token]: string }, dark: { [token]: string } }` directly
- `isOverridden(key)` = `config.overrides.light[key] !== ""`
- Remove `PLUGIN_ID` constant

**`web/components/*-picker.tsx`** — same read/write API swap

**`web/components/*-header-dots.tsx`** (color-palette, sidebar-palette only) — same read API swap

#### Shadow-specific handling

Shadow is unified with the same model. No more separate `params` field — shadow's "overrides" ARE the params. The `resolve` function computes the CSS tiers.

**`shared/config.ts`:**
```ts
import { defineConfig } from "@plugins/config_v2/core";
import { textField } from "@plugins/config_v2/plugins/fields/plugins/primitives/core";
import { objectField } from "@plugins/config_v2/plugins/fields/plugins/object/core";

export const shadowConfig = defineConfig({
  fields: {
    preset: textField({ default: "default", label: "Shadow preset" }),
    overrides: objectField({
      label: "Shadow parameters",
      subFields: {
        color: textField({ default: "", label: "Color" }),
        opacity: textField({ default: "", label: "Opacity" }),
        blur: textField({ default: "", label: "Blur" }),
        spread: textField({ default: "", label: "Spread" }),
        offsetX: textField({ default: "", label: "Offset X" }),
        offsetY: textField({ default: "", label: "Offset Y" }),
      },
    }),
  },
});
```

No light/dark split — shadow params are mode-agnostic (both modes get the same computed tiers). All defaults are `""` (use preset value).

**`web/index.ts`** — provides `resolve` on the `TokenGroup` contribution:
```ts
ThemeEngine.TokenGroup({
  id: "shadow",
  label: "Shadow",
  descriptor: shadowGroup,         // 8 CSS tier keys → --shadow-2xs, etc.
  usePresets: () => Shadow.Preset.useContributions(),
  configDescriptor: shadowConfig,
  resolve: (preset, overrides) => {
    const shadowPreset = preset as ShadowPreset;
    const baseParams = shadowPreset.params ?? DEFAULT_PARAMS;
    const merged = { ...baseParams };
    const ov = overrides as Record<string, string>;
    for (const [key, value] of Object.entries(ov)) {
      if (value !== "") {
        (merged as Record<string, unknown>)[key] =
          key === "opacity" ? parseFloat(value) : value;
      }
    }
    const tiers = buildShadowTiers(merged);
    return { light: tiers, dark: tiers };
  },
})
```

**`web/components/shadow-section.tsx`:**
- Reads `config.overrides` as `{ color: string, opacity: string, ... }` (all strings, `""` = not overridden)
- `isOverridden(key)` = `config.overrides[key] !== ""`
- Writes: `setConfig("overrides", { ...config.overrides, opacity: "0.2" })`
- Reset: `setConfig("overrides", { color: "", opacity: "", blur: "", ... })` (all empty = use preset)
- No more `writeParams` dual-write, no more `buildShadowTiers` at write time
- The `resolve` function handles computation at read time in the injector

**Shadow preset type** stays extended with `params?: ShadowParams` — the `resolve` function reads `preset.params` to get the baseline. The preset's `light`/`dark` fields are still pre-computed (for display in the preset picker UI).

### Phase 4: Build and verify

1. `./equin build` — generates `config/ui/tokens/<name>/config.origin.jsonc` for each plugin
2. `./equin check` — verify all checks pass

## JSONC file format (after migration)

### Color-palette (with overrides)
`~/.singularity/config/<worktree>/ui/tokens/color-palette/config.jsonc`:
```jsonc
// @hash abc123def456
{
  "preset": "ocean",
  "overrides": {
    "light": {
      "primary": "oklch(0.5 0.1 200)",
      "background": ""
    },
    "dark": {}
  }
}
```

### Shadow (with param overrides)
`~/.singularity/config/<worktree>/ui/tokens/shadow/config.jsonc`:
```jsonc
// @hash abc123def456
{
  "preset": "default",
  "overrides": {
    "opacity": "0.2",
    "blur": "5px"
  }
}
```

### Origin (defaults — all empty)
`config/ui/tokens/shape/config.origin.jsonc`:
```jsonc
// @hash abc123def456
{
  "preset": "default",
  "overrides": {
    "light": {
      "radius": "",
      "spacing": ""
    },
    "dark": {
      "radius": "",
      "spacing": ""
    }
  }
}
```

## Files to modify

### Framework edits (1)
- `plugins/config_v2/plugins/fields/plugins/object/core/internal/object.ts` — `.default()` fix

### ThemeEngine edits (3)
- `plugins/ui/plugins/theme-engine/web/slots.ts` — v2 ConfigDescriptor, drop pluginId, add resolve
- `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx` — v2 API, resolve dispatch, `""` filtering
- `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx` — useConfigRegistrations + fetchEndpoint

### Per token plugin (×6, ~4-5 files each ≈ 28 files)
- `shared/config.ts`
- `server/index.ts`
- `web/index.ts`
- `web/components/*-section.tsx`
- `web/components/*-picker.tsx`
- `web/components/*-header-dots.tsx` (2 plugins only)

## Risks

**Data migration:** Existing v1 config values (in DB) are silently lost — v2 reads from JSONC files. Acceptable for a dev tool; users reconfigure via the theme customizer.

**All-or-nothing deployment:** ThemeInjector must switch to v2 API at the same time all 6 plugins register `ConfigV2.WebRegister`. Cannot deploy partially.

**Shadow resolve performance:** `buildShadowTiers` now runs on every render (read-time) instead of once at write-time. The function is pure arithmetic on 6 params → 8 strings, so this is negligible. If needed, memoize inside the resolve function.

## Verification

1. `./equin build` and `./equin check` pass
2. Theme customizer opens without errors
3. Per-group preset switching works
4. Global preset switching cascades to all groups
5. Individual token overrides persist across page reload
6. Light/dark mode toggle applies overrides to correct mode
7. Shadow parameter editor (color, opacity, blur, spread, offset) works
8. Reset shadow params restores preset defaults
9. Header dots render correct colors (color-palette, sidebar-palette)
10. JSONC origin files exist in `config/` after build
