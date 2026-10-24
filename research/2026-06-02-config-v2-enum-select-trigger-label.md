# Fix: Enum/DynamicEnum dropdown trigger shows raw value instead of label

## Context

The `config_v2` enum and dynamic-enum field renderers use a shadcn `<Select>` that wraps
`@base-ui/react/select`. Base-ui's `Select.Value` (the collapsed trigger text) resolves
the displayed label from the `items` prop on `Select.Root` — not from the `<SelectItem>`
children, which are unmounted when the popup is closed. Without `items`, the trigger falls
back to rendering the raw stored value (e.g. `"opus-4-8"`) instead of the human label
(e.g. `"Opus 4.8"`). The open option list is unaffected because those children are
mounted and carry their own text.

The pattern to fix this already exists: `model-select.tsx` passes
`items={Record<string, string>}` (a `value → label` map) to `<Select>`.

## Files to change

| File | What to change |
|---|---|
| `plugins/config_v2/plugins/fields/plugins/enum/web/components/enum-renderer.tsx` | `DropdownSelect`: derive `items` map from `options`, pass to `<Select>` |
| `plugins/config_v2/plugins/fields/plugins/dynamic-enum/web/components/dynamic-enum-renderer.tsx` | `DropdownSelect`: derive `items` map from `options`, pass to `<Select>` |

## Reference

- Canonical fix pattern: `plugins/conversations/plugins/model-provider/web/components/model-select.tsx` lines 49–54
- Base-ui type: `Select.Root.Props.items?: Record<string, ReactNode> | ...` — JSDoc confirms it populates `Select.Value` when the popup is unmounted
- `EnumOption` shape: `{ value: string; label: string }` (always normalized before reaching renderer — `core/internal/enum.ts:10`)
- `DynamicEnumOption` shape: also `{ value: string; label: string }` (from `dynamic-enum/web/internal/slots.ts`)

## Implementation

### `enum-renderer.tsx` — `DropdownSelect` function

```diff
 function DropdownSelect({ options, value, onChange }) {
+  const items = Object.fromEntries(options.map((opt) => [opt.value, opt.label]));
   return (
     <Select
+      items={items}
       value={value}
       onValueChange={(v) => { if (v !== null) onChange(v); }}
     >
```

### `dynamic-enum-renderer.tsx` — `DropdownSelect` function

Identical change — same `options` shape, same one-liner.

## Verification

1. `./equin build`
2. Open Settings → any enum field rendered as a dropdown (e.g. "Default model" in Model Provider settings, or any `enumField` with ≥4 options).
3. The collapsed trigger must show the human label, not the raw value string.
4. Opening the dropdown still shows all options with their labels (no regression).
