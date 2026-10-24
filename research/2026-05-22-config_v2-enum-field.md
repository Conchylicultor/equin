# config_v2: enumField

## Context

The config_v2 vision doc lists `enumField` as a planned field type — "dropdown or radio group from a fixed set." Currently missing. Plugins that need single-choice-from-N (e.g. log level, theme variant) have no config_v2 field type for this; they'd need to fall back to a plain `textField` with no validation or guided UI.

## Design

### Core factory

New sub-plugin: `plugins/config_v2/plugins/fields/plugins/enum/`

**`core/internal/enum.ts`** — follows the multiline-text pattern:

```ts
import { z } from "zod";
import { defineFieldType, type FieldDef, type FieldMeta } from "@plugins/config_v2/core";

// Callers can pass strings or value/label pairs
type EnumOptionInput = string | { value: string; label: string };

// Normalized internal shape
interface EnumOption { value: string; label: string }

const enumFieldType = defineFieldType<string>("enum");

interface EnumFieldDef extends FieldDef<string> {
  readonly type: typeof enumFieldType;
  readonly options: readonly EnumOption[];
  readonly display?: "radio" | "dropdown";
}

function enumField(opts: FieldMeta & {
  options: EnumOptionInput[];
  default?: string;
  display?: "radio" | "dropdown";
}): EnumFieldDef
```

- Normalizes `string` inputs to `{ value: s, label: s }` at factory time.
- Throws if `options` is empty.
- Zod schema: `z.enum(values as [string, ...string[]])` — validates value is one of the allowed options.
- Default: `opts.default ?? options[0].value`.

**`core/index.ts`** — re-exports `enumField`, `enumFieldType`, `EnumFieldDef`, `EnumOption`.

### Web renderer

**`web/components/enum-renderer.tsx`**:

- Casts `field as EnumFieldDef` to access `options` and `display`.
- Rendering mode: `display === "radio" || (display !== "dropdown" && options.length <= 3)` → radio; else dropdown.
- **Dropdown**: Uses shadcn `Select` / `SelectTrigger` / `SelectValue` / `SelectContent` / `SelectItem` from `@/components/ui/select`. Layout: stacked (`flex flex-col gap-1.5 py-3`) — label/description above, trigger below. Trigger gets `className="w-full"` override since the default is `w-fit`.
- **Radio**: Native `<input type="radio">` group with label styling matching the rest of the config UI. Same stacked layout.
- No `useLocalValue` needed — Select/radio changes are instantaneous, not typed.
- Inlines the label/description header JSX (same as multiline-text-renderer pattern — `FieldHeader` is not exported from primitives).

**`web/index.ts`** — contributes `Fields.Renderer(EnumRenderer)`.

### Origin comment generation

**Add `typeHint?: string` to `FieldMeta`** (`plugins/config_v2/core/internal/types.ts`) — a generic mechanism any field type can use. The enum factory populates it with `Allowed values: "a", "b", "c"`.

**Update `renderOriginJsonc`** (`plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts`) to emit `field.meta.typeHint` as a comment line after `description` and before the value. This avoids importing a specific field type into the codegen module.

Result for an enum field `logLevel` with options `["debug", "info", "warn", "error"]`:
```jsonc
{
  // Controls log verbosity
  // Allowed values: "debug", "info", "warn", "error"
  "logLevel": "info"
}
```

### Plugin metadata

**`package.json`** — `@singularity/plugin-config_v2-fields-enum`, private.

**`CLAUDE.md`** — usage example, exports, contributions.

## Files

### Create

| File | Purpose |
|------|---------|
| `plugins/config_v2/plugins/fields/plugins/enum/core/internal/enum.ts` | Type token, interface, factory |
| `plugins/config_v2/plugins/fields/plugins/enum/core/index.ts` | Core barrel |
| `plugins/config_v2/plugins/fields/plugins/enum/web/components/enum-renderer.tsx` | Dropdown + radio renderer |
| `plugins/config_v2/plugins/fields/plugins/enum/web/index.ts` | Web barrel (contributes renderer) |
| `plugins/config_v2/plugins/fields/plugins/enum/package.json` | Workspace package |
| `plugins/config_v2/plugins/fields/plugins/enum/CLAUDE.md` | Plugin doc |

### Modify

| File | Change |
|------|--------|
| `plugins/config_v2/core/internal/types.ts` | Add `typeHint?: string` to `FieldMeta` |
| `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts` | Emit `field.meta.typeHint` comment in `renderOriginJsonc` |

## Reference files

- `plugins/config_v2/plugins/fields/plugins/multiline-text/core/internal/multiline-text.ts` — canonical simple field factory
- `plugins/config_v2/plugins/fields/plugins/multiline-text/web/components/multiline-text-renderer.tsx` — canonical renderer with inlined header
- `plugins/config_v2/plugins/fields/plugins/multiline-text/web/index.ts` — canonical web barrel
- `plugins/config_v2/core/internal/types.ts` — `FieldDef`, `FieldMeta`, `defineFieldType`
- `plugins/config_v2/plugins/fields/web/internal/slots.ts` — `Fields.Renderer` slot, `FieldRendererComponent`
- `plugins/framework/plugins/web-core/web/components/ui/select.tsx` — shadcn Select components

## Verification

1. `./equin build` — builds and deploys
2. Add a test `enumField` to an existing config (e.g. build plugin) temporarily, verify:
   - Settings UI shows dropdown/radio correctly
   - Origin JSONC contains the allowed-values comment
   - Selecting a value persists and round-trips
3. `./equin check` — all checks pass
