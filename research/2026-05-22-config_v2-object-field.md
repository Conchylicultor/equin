# config_v2: objectField

## Context

config_v2 is missing `objectField` — a compound field type that groups related sub-fields into a single nested object. Unlike `listField` (variable-length array of items), `objectField` is a fixed-structure single object with named sub-fields. Use case: grouping related settings (e.g., `{ host: string, port: number, tls: boolean }` for connection config).

The field type system is slot-based: each field type is a sub-plugin under `plugins/config_v2/plugins/fields/plugins/<name>/` with a core factory and web renderer. No central switch-case — discovery is automatic via the `Fields.Renderer` slot.

## Changes

### 1. New plugin: `plugins/config_v2/plugins/fields/plugins/object/`

#### `core/internal/object.ts` — Factory

Following the `listField` pattern (`list/core/internal/list.ts`):

- `objectFieldType = defineFieldType<Record<string, unknown>>("object")` — singleton token
- `ObjectFieldDef<F extends FieldsRecord>` extends `FieldDef<InferFieldsObject<F>>` with `readonly subFields: F`
- `isObjectFieldDef(field)` — duck-type guard on `"subFields" in field`
- `objectField(opts)` factory:
  - Schema: `z.object(subShape).passthrough()` where `subShape` maps `opts.subFields` keys to their `.schema`
  - Default: `opts.default ?? Object.fromEntries(entries.map(([k, f]) => [k, f.defaultValue]))` — unlike list (defaults to `[]`), object always has a complete default from sub-field defaults
  - Extra property: `subFields: opts.subFields`

#### `core/index.ts` — Barrel

Re-exports: `objectField`, `objectFieldType`, `isObjectFieldDef`, `ObjectFieldDef`

#### `web/components/object-renderer.tsx` — Renderer

Structure using `Collapsible` from `@plugins/primitives/plugins/collapsible/web`:

```
<Collapsible defaultOpen>
  <CollapsibleTrigger>
    <CollapsibleChevron />
    <label + description (inlined)>
  </CollapsibleTrigger>
  <CollapsibleContent className="pl-4 border-l border-border ml-2">
    {Object.entries(subFields).map(([key, subField]) => (
      <FieldRenderer field={subField} value={obj[key]} onChange={mergeAndEmit} />
    ))}
  </CollapsibleContent>
</Collapsible>
```

- Type: `FieldRendererComponent<Record<string, unknown>>` with `.type = objectFieldType`
- Cast `field as ObjectFieldDef` to access `subFields`
- Sub-field onChange: `onChange({ ...parentValue, [key]: newValue })` — merges into full object
- Nesting: recursive dispatch through `FieldRenderer` handles nested objectFields automatically

#### `web/index.ts` — Plugin barrel

```ts
contributions: [Fields.Renderer(ObjectRenderer)]
```

#### `package.json`

```json
{ "name": "@singularity/plugin-config_v2-fields-object", "private": true }
```

### 2. Origin file generation: nested descriptions

**File:** `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts`

Current `renderOriginJsonc` (line 71) treats all fields as flat scalars via `JSON.stringify(value)`. For objectField, the default is a nested object (e.g. `{ host: "localhost", port: 8080 }`) — we want per-sub-field comments in the generated `.origin.jsonc`:

```jsonc
// Connection settings
"connection": {
  // Server hostname
  "host": "localhost",
  // Port number
  "port": 8080
}
```

**Approach:** Extract the field-rendering loop (lines 78-91) into a `renderFieldLines(fields, defaults, indent)` helper. Duck-type on `"subFields" in field` (same pattern as server registry's `"itemFields" in field` check) to recurse into nested objects.

```ts
function renderFieldLines(
  fields: Record<string, FieldDef>,
  defaults: Record<string, unknown>,
  indent: string,
): string[] {
  const lines: string[] = [];
  const entries = Object.entries(fields);
  for (let i = 0; i < entries.length; i++) {
    const [key, field] = entries[i]!;
    const isLast = i === entries.length - 1;
    const comma = isLast ? "" : ",";
    const value = defaults[key];

    if (field.meta.description) lines.push(`${indent}// ${field.meta.description}`);
    if (field.meta.typeHint) lines.push(`${indent}// ${field.meta.typeHint}`);

    if ("subFields" in field && typeof field.subFields === "object") {
      const subFields = field.subFields as Record<string, FieldDef>;
      const subDefaults = (value && typeof value === "object" && !Array.isArray(value))
        ? value as Record<string, unknown>
        : Object.fromEntries(Object.entries(subFields).map(([k, f]) => [k, f.defaultValue]));
      lines.push(`${indent}"${key}": {`);
      lines.push(...renderFieldLines(subFields, subDefaults, `${indent}  `));
      lines.push(`${indent}}${comma}`);
    } else {
      lines.push(`${indent}"${key}": ${JSON.stringify(value)}${comma}`);
    }
  }
  return lines;
}
```

Then `renderOriginJsonc` calls `renderFieldLines(descriptor.fields, descriptor.defaults, "  ")` instead of the inline loop.

The `computeHash(descriptor.defaults)` call is unchanged — it hashes the opaque defaults object, not the rendered JSONC text.

### 3. Settings UI: `isFieldModified` fix

**File:** `plugins/config_v2/plugins/settings/web/components/config-field-row.tsx` (line 9)

Current fallback uses `value !== defaultValue` (reference equality) — always `true` for objects. Add a branch for objectField using JSON deep equality:

```ts
if ("subFields" in field && typeof value === "object" && typeof defaultValue === "object") {
  return JSON.stringify(value) !== JSON.stringify(defaultValue);
}
```

This goes between the existing `itemFields` branch and the final `return`.

### 4. Documentation updates

- Create `plugins/config_v2/plugins/fields/plugins/object/CLAUDE.md`
- Update `plugins/config_v2/plugins/fields/CLAUDE.md` sub-plugins list: add `object` alongside `avatar`, `enum`, `list`, `multiline-text`, `primitives`

## Files to create

| File | Purpose |
|------|---------|
| `plugins/config_v2/plugins/fields/plugins/object/core/internal/object.ts` | Factory, type token, interface |
| `plugins/config_v2/plugins/fields/plugins/object/core/index.ts` | Core barrel |
| `plugins/config_v2/plugins/fields/plugins/object/web/components/object-renderer.tsx` | Collapsible section with sub-field dispatch |
| `plugins/config_v2/plugins/fields/plugins/object/web/index.ts` | Web plugin barrel |
| `plugins/config_v2/plugins/fields/plugins/object/package.json` | Package metadata |
| `plugins/config_v2/plugins/fields/plugins/object/CLAUDE.md` | Plugin docs |

## Files to modify

| File | Change |
|------|--------|
| `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts` | Extract `renderFieldLines` helper, add `subFields` recursion |
| `plugins/config_v2/plugins/settings/web/components/config-field-row.tsx` | Add object deep-equality branch in `isFieldModified` |
| `plugins/config_v2/plugins/fields/CLAUDE.md` | Add `object` to sub-plugins list |

## Verification

1. `./equin build` — auto-discovers the new plugin, regenerates docs and registry
2. `./equin check` — confirm `config-origins-in-sync`, `plugin-boundaries`, `eslint`, `typescript` all pass
3. Visual: open Settings pane for a plugin using `objectField` — verify collapsible section, sub-field editing, modified indicator, and reset
4. Origin file: inspect generated `.origin.jsonc` for nested comments and correct JSON structure
5. Nesting: test `objectField` containing another `objectField` — recursive dispatch should work automatically
