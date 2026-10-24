# Dynamic Enum Field Type for config_v2

## Context

Nine config fields (progress bar variant, theme preset, 7 token presets) use `textField` where valid values come from runtime slot contributions. The existing `enumField` bakes options at definition time — can't work when plugins dynamically register/unregister options. The settings UI renders these as freeform text inputs instead of dropdowns.

Core tension: config descriptors live in `core/`/`shared/` (imported by server), but option sources are web-only slot contributions. Hooks can't live in core.

## Design

New field type plugin: `plugins/config_v2/plugins/fields/plugins/dynamic-enum/`

### Core (`core/`) — no web dependencies

- `dynamicEnumFieldType = defineFieldType<string>("dynamic-enum")`
- `dynamicEnumField({ default, label, display? })` — marker type, `z.string()` schema
- No `useOptions`, no hooks — importable by server unchanged

### Web (`web/`) — slot-based options resolution

**Slot**: `DynamicEnum.Options` — plugins contribute `{ field: FieldDef, useOptions: () => EnumOption[] }`

```ts
export const DynamicEnum = {
  Options: defineSlot<DynamicEnumOptionsContribution>(
    "config-v2.fields.dynamic-enum.options",
  ),
};
```

**Matching**: by `FieldDef` **reference equality**. The contribution holds the exact same frozen object from `myConfig.fields.variant`. The renderer receives the same object as its `field` prop. `contributions.find(c => c.field === field)` — no string IDs needed.

**Renderer**: `DynamicEnumRenderer` calls `DynamicEnum.Options.useContributions()`, finds the matching provider, delegates to `ResolvedEnum` (separate component so `useOptions()` is unconditional). Falls back to text input if no provider matched.

### Consumer migration pattern

Each consumer needs two minimal changes:

**1. Config def** (`core/` or `shared/`): `textField(...)` → `dynamicEnumField(...)`

```ts
// Before
variant: textField({ default: "dots", label: "Progress bar variant" })
// After
variant: dynamicEnumField({ default: "dots", label: "Progress bar variant" })
```

**2. Web barrel**: add one `DynamicEnum.Options` contribution

```ts
DynamicEnum.Options({
  field: segmentedProgressBarConfig.fields.variant,
  useOptions: () =>
    SegmentedProgressBar.Variant.useContributions().map(v => ({
      value: v.id, label: v.label,
    })),
}),
```

## All 9 consumers

| Plugin | Config file | Field | Options slot |
|--------|-------------|-------|-------------|
| `segmented-progress-bar` | `core/config.ts` | `variant` | `SegmentedProgressBar.Variant` |
| `theme-engine` | `core/config.ts` | `globalPreset` | `ThemeEngine.GlobalPreset` |
| `chart` | `shared/config.ts` | `preset` | `Chart.Preset` |
| `color-palette` | `shared/config.ts` | `preset` | `ColorPalette.Preset` |
| `shadow` | `shared/config.ts` | `preset` | `Shadow.Preset` |
| `shape` | `shared/config.ts` | `preset` | `Shape.Preset` |
| `sidebar-palette` | `shared/config.ts` | `preset` | `SidebarPalette.Preset` |
| `typography` | `shared/config.ts` | `preset` | `Typography.Preset` |
| `color-adjust` | `shared/config.ts` | `preset` | `ColorAdjust.Preset` |

## Files to create

```
plugins/config_v2/plugins/fields/plugins/dynamic-enum/
  package.json
  core/
    index.ts                           — re-exports
    internal/dynamic-enum.ts           — defineFieldType, factory, types
  web/
    index.ts                           — barrel: Fields.Renderer + re-exports DynamicEnum
    internal/slots.ts                  — DynamicEnum.Options slot definition
    components/dynamic-enum-renderer.tsx — renderer (radio/dropdown/text fallback)
```

## Files to modify

- 9 config definitions: `textField` → `dynamicEnumField` import swap
- 9 web barrels: add `DynamicEnum.Options(...)` contribution + import

## Key decisions

- **`z.string()` schema**: server can't resolve options, so no server-side validation against the option set. The dropdown constrains the UI; the schema stays permissive.
- **Reference equality matching**: no string IDs, no registration coordination. Same import = same object reference.
- **Graceful degradation**: no provider → text input fallback. Works during SSR, tests, or if a plugin is disabled.
- **Bespoke pickers stay**: the rich visual pickers in theme-customizer (color swatches, shadow previews) are untouched — they're the primary UI. The dynamic-enum dropdown appears in the generic settings pane as a proper selector.
- **Auto-discovery**: plugin placed under `fields/plugins/` — build auto-discovers it, no manual registry edit.

## Verification

1. `./equin build` succeeds
2. Settings → Config → progress bar variant shows radio with "Dots" / "Segmented" (not text input)
3. Settings → Config → theme preset shows dropdown with "Default" / "Ocean" / "Warm"
4. Token preset fields show dropdowns with their contributed presets
5. Changing value via dropdown actually switches the variant/preset
6. Reset button reverts to default
7. `./equin check` passes

## Key reference files

- Enum field (pattern to follow): `plugins/config_v2/plugins/fields/plugins/enum/core/internal/enum.ts`
- Enum renderer (RadioGroup/DropdownSelect): `plugins/config_v2/plugins/fields/plugins/enum/web/components/enum-renderer.tsx`
- Fields slot (Fields.Renderer): `plugins/config_v2/plugins/fields/web/internal/slots.ts`
- Field type docs: `plugins/config_v2/plugins/fields/CLAUDE.md`
- FieldRenderer dispatch: `plugins/config_v2/plugins/fields/web/internal/field-renderer.tsx`
- ThemeEngine slots (usePresets precedent): `plugins/ui/plugins/theme-engine/web/slots.ts`
