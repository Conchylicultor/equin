# config_v2: colorField

## Context

config_v2's field type system is missing a `colorField` for arbitrary CSS color
selection. It's needed by theme tokens (currently using raw text fields) and
future structured data like custom status colors. The `color-picker` primitive
already provides a `ColorPickerPopover` component — this field type wraps it
into the config_v2 slot-based field system.

`avatarField` already exists and is working — only `colorField` is needed.

## Implementation

Create `plugins/config_v2/plugins/fields/plugins/color/` following the exact
pattern of `enum` and `avatar` field types.

### Files

#### 1. `core/internal/color.ts` — Type token, interface, factory

- `colorFieldType = defineFieldType<string>("color")` — value is a hex string
- `ColorFieldDef` extends `FieldDef<string>` with optional `swatches?: readonly string[]` and `showAlpha?: boolean`
- `colorField(opts?)` factory — schema is `z.string()`, default `"#000000"`
- `meta` built inline (`{ label, description, placeholder }`) matching `enum`'s pattern

Reference: `plugins/config_v2/plugins/fields/plugins/enum/core/internal/enum.ts`

#### 2. `core/index.ts` — Barrel

Re-exports: `colorField`, `colorFieldType`, `type ColorFieldDef`

Reference: `plugins/config_v2/plugins/fields/plugins/enum/core/index.ts`

#### 3. `web/components/color-renderer.tsx` — Renderer

- Imports `ColorPickerPopover` from `@plugins/primitives/plugins/color-picker/web`
- Horizontal layout (`flex items-start justify-between gap-4 py-3`) matching `avatar-renderer.tsx` — compact trigger widget on the right, label/description on the left
- Reads `swatches` and `showAlpha` from `field as ColorFieldDef`
- Label/description inlined (no `FieldHeader` import — it's private to primitives)

Reference: `plugins/config_v2/plugins/fields/plugins/avatar/web/components/avatar-renderer.tsx`

#### 4. `web/index.ts` — Plugin barrel

- `id: "config-v2-fields-color"`
- `contributions: [Fields.Renderer(ColorRenderer)]`

Reference: `plugins/config_v2/plugins/fields/plugins/avatar/web/index.ts`

#### 5. `package.json`

```json
{
  "name": "@singularity/plugin-config_v2-fields-color",
  "private": true,
  "description": "Color field type for config_v2: hex color with a popover picker."
}
```

#### 6. `CLAUDE.md`

Usage example showing `colorField({ label, default, swatches, showAlpha })`.

### Key decisions

- **Value type is `string` (hex)** — matches `ColorPickerPopover`'s in/out format. No `Color` class in the config layer.
- **Schema is `z.string()`** — no hex regex validation. The picker normalizes to hex; over-constraining would reject valid CSS colors stored by other means.
- **Default is `"#000000"`** — explicit valid hex avoids `Color.fromCss("")` fallback behavior.
- **No server barrel** — no server-side logic needed (unlike `avatar` which has a svgNodes resolver).
- **`swatches` frozen** — `Object.freeze([...opts.swatches])` prevents shared-reference mutation.

### No manual registration needed

Plugin discovery is automatic via codegen during `./equin build`. No
registry file edits required.

## Verification

1. `./equin build` — should discover the new plugin and build cleanly
2. Add a test config using `colorField` to an existing plugin (or temporarily to a debug plugin)
3. Open Settings in the UI — the color field should render with the popover picker
4. Pick a color, verify it persists across page reloads
5. `./equin check` — all checks pass
