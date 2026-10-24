# Config v2 — Field Type System

## Context

The config v2 system (`plugins/config_v2/`) currently has only the `store` sub-plugin — a low-level `ConfigStore` abstraction over JSONC files on disk. The next piece is the **field type system**: typed factory functions that let plugins declare config fields with Zod validation, defaults, and UI metadata. This is the core vocabulary that `defineConfig`, the settings UI, the server reader, and the merge/codegen sub-plugins will all build on.

Config v1 (`plugins/config/`) supports only 5 scalar kinds (string, number, boolean, string-list, secret) with no Zod validation and no compound types. The v2 field system replaces this with 10 field types including nested structures (list, object) and domain-specific pickers (avatar, color, enum).

## Placement

All new code goes in `plugins/config_v2/core/` — the umbrella's own core barrel. This is importable from both web and server via `@plugins/config_v2/core`. No React, no server I/O — pure TypeScript + Zod.

The path alias `@plugins/*` → `./plugins/*` (from `tsconfig.json`) handles resolution automatically. No package.json changes needed — the umbrella's existing package.json covers the core directory.

## File Structure

```
plugins/config_v2/core/
  index.ts                          # Public barrel
  internal/
    types.ts                        # All type definitions
    schema-builder.ts               # buildFieldsSchema: FieldsRecord → ZodObject
    define-config.ts                # defineConfig factory
    fields/
      index.ts                      # Re-exports all field factories
      bool.ts
      text.ts
      multi-line-text.ts
      number.ts
      enum.ts
      avatar.ts
      color.ts
      list.ts
      object.ts
      json.ts
```

## Type Definitions (`internal/types.ts`)

### Base field shape

Every field is a frozen plain object (no classes) with a discriminant `kind` string:

```ts
type BaseFieldDef<K extends string, T> = {
  readonly kind: K;
  readonly schema: z.ZodType<T>;
  readonly defaultValue: T;
  readonly meta: FieldMeta;
};

interface FieldMeta {
  label?: string;
  description?: string;
  placeholder?: string;
}
```

### Concrete field types

| Kind | Type alias | Extra fields |
|------|-----------|--------------|
| `"bool"` | `BoolFieldDef` | — |
| `"text"` | `TextFieldDef` | — |
| `"multiLineText"` | `MultiLineTextFieldDef` | — |
| `"number"` | `NumberFieldDef` | `min?, max?, step?` |
| `"enum"` | `EnumFieldDef<T>` | `options: readonly T[], optionLabels?: Record<T, string>` |
| `"avatar"` | `AvatarFieldDef` | — (schema: `{ icon: string | null, color: string | null }`) |
| `"color"` | `ColorFieldDef` | — |
| `"list"` | `ListFieldDef<F>` | `fields: F, itemLabel?` |
| `"object"` | `ObjectFieldDef<F>` | `fields: F` |
| `"json"` | `JsonFieldDef` | — (schema: `z.unknown()`) |

### Union and inference types

```ts
type FieldDef = BoolFieldDef | TextFieldDef | ... | JsonFieldDef;
type FieldsRecord = Record<string, FieldDef>;
type InferFieldsObject<F extends FieldsRecord> = { [K in keyof F]: /* extract T from F[K] */ };
type ListItemValue<F extends FieldsRecord> = { id: string } & InferFieldsObject<F>;
type ConfigValues<F extends FieldsRecord> = InferFieldsObject<F>;
```

### AvatarValue

Defined locally (not imported from the avatar web primitive) because core cannot depend on web:

```ts
interface AvatarValue { icon: string | null; color: string | null; }
```

### ConfigDescriptor

```ts
interface ConfigDescriptor<F extends FieldsRecord> {
  readonly schema: z.ZodObject<...>;  // composed from all fields
  readonly fields: F;                 // raw definitions for UI iteration
  readonly defaults: ConfigValues<F>; // pre-computed fallback object
}
```

## Schema Builder (`internal/schema-builder.ts`)

Single function: `buildFieldsSchema(fields: F) → z.ZodObject<{...}>`. Iterates field entries, maps each key to `field.schema`, passes to `z.object()`. Cast required to recover generic key types (same pattern as `collections/core/internal/schema-builder.ts`).

Used by `objectField`, `listField`, and `defineConfig`.

## Field Factories

Each factory lives in its own file, follows the same pattern: accept typed options → build Zod schema → return frozen `FieldDef`.

### Simple fields (bool, text, multiLineText, color, json)

Straightforward: schema is `z.boolean()`, `z.string()`, or `z.unknown()`. Options are just `FieldMeta` + `default?`.

- `boolField(opts?)` → default `false`
- `textField(opts?)` → default `""`
- `multiLineTextField(opts?)` → default `""`
- `colorField(opts?)` → default `""`
- `jsonField(opts?)` → default `null` (not `undefined` — JSON files can't express undefined)

### numberField

Options add `min?, max?, step?`. Schema chains `z.number().min(m).max(m)` when bounds given. `step` is metadata only (no Zod refinement — enforced by UI).

### enumField

```ts
function enumField<const T extends string>(opts: {
  options: readonly [T, ...T[]];  // non-empty tuple for z.enum
  default?: T;
  optionLabels?: Partial<Record<T, string>>;
  ...meta
}): EnumFieldDef<T>
```

`const T` + non-empty tuple ensures `enumField({ options: ["a", "b"] })` infers `EnumFieldDef<"a" | "b">`, not `EnumFieldDef<string>`. Default falls back to `options[0]`.

### avatarField

Schema: `z.object({ icon: z.string().nullable(), color: z.string().nullable() })`. Default: `{ icon: null, color: null }`. No options beyond meta.

### objectField (compound)

```ts
function objectField<const F extends FieldsRecord>(opts: {
  fields: F;
  ...meta
}): ObjectFieldDef<F>
```

Delegates to `buildFieldsSchema(opts.fields)` for schema composition. Default is computed by collecting each sub-field's `defaultValue`.

### listField (compound, auto-UUID)

```ts
function listField<const F extends FieldsRecord>(opts: {
  fields: F;
  itemLabel?: string;
  ...meta
}): ListFieldDef<F>
```

Schema composition:
1. Call `buildFieldsSchema(opts.fields)` to get item field shapes
2. Inject `id: z.string()` into the shape
3. Wrap in `z.array(z.object({ id: z.string(), ...fieldShapes }))`

Default is always `[]`. UUID generation is a write-path concern (server or web calls `crypto.randomUUID()` when creating items) — the factory only declares the schema.

Nested lists work naturally: `listField({ fields: { sub: listField({ fields: { ... } }) } })` produces `z.array(z.object({ id, sub: z.array(z.object({ id, ... })) }))`.

## defineConfig (`internal/define-config.ts`)

```ts
function defineConfig<const F extends FieldsRecord>(opts: { fields: F }): ConfigDescriptor<F>
```

1. Validate no dots in field names (used as key separators)
2. Compose schema via `buildFieldsSchema`
3. Compute defaults: `Object.fromEntries(entries.map(([k, f]) => [k, f.defaultValue]))`
4. Return frozen `{ schema, fields, defaults }`

`const F` preserves literal types through inference (same pattern as config v1's `defineConfig<const S>`).

## Public Barrel (`core/index.ts`)

Exports:
- All 10 field factories
- `defineConfig`
- All type aliases (FieldDef, each concrete def type, FieldsRecord, ConfigValues, ConfigDescriptor, AvatarValue, ListItemValue, InferFieldsObject, FieldMeta)

Does NOT export `buildFieldsSchema` (internal implementation detail).

## Design Decisions

**Discriminated union over class hierarchy**: `kind` string as discriminant gives exhaustive switch checking for free in renderers. No inheritance needed.

**`Object.freeze` on every factory return**: Matches `collections/core` convention. Field definitions are declared once and shared.

**No renderer references in core**: Core carries a `kind` string. The web layer (future work) will define a slot where renderer sub-plugins contribute `ComponentType<FieldRendererProps>` keyed by kind — same pattern as `segmented-progress-bar` variants.

**`FieldMeta` as a flat interface, not extended**: Each factory's options type intersects `FieldMeta` with kind-specific fields (e.g. `min/max` for number). This avoids a class hierarchy while still sharing the common label/description/placeholder shape.

**Collections `FieldInstance` is NOT reused**: Collections fields carry `_columns` (Drizzle column builders) because collections are DB-backed tables. Config v2 fields are file-backed — they need Zod schemas, not column builders. Parallel type system, not a shared one.

## Implementation Order

1. `types.ts` — no dependencies
2. `schema-builder.ts` — depends on types
3. Simple fields: `bool.ts`, `text.ts`, `multi-line-text.ts`, `number.ts`, `color.ts`, `json.ts` — depend on types only
4. `enum.ts`, `avatar.ts` — depend on types only
5. `object.ts`, `list.ts` — depend on types + schema-builder
6. `fields/index.ts` — re-exports
7. `define-config.ts` — depends on types + schema-builder
8. `core/index.ts` — public barrel

## Verification

1. `./equin build` — confirms TypeScript compilation and no import errors
2. Write a smoke test in a temporary file that exercises every field type:
   ```ts
   const config = defineConfig({
     fields: {
       enabled: boolField({ label: "Enabled" }),
       name: textField({ default: "foo" }),
       count: numberField({ min: 0, max: 100 }),
       mode: enumField({ options: ["fast", "slow"] }),
       icon: avatarField(),
       color: colorField({ default: "#ff0000" }),
       notes: multiLineTextField(),
       raw: jsonField(),
       settings: objectField({
         fields: {
           timeout: numberField({ default: 3000 }),
           verbose: boolField(),
         },
       }),
       items: listField({
         itemLabel: "Item",
         fields: {
           title: textField({ label: "Title" }),
           tags: listField({ fields: { tag: textField() } }),
         },
       }),
     },
   });
   ```
3. Verify type inference: `config.defaults.enabled` should be `boolean`, `config.defaults.mode` should be `"fast" | "slow"`, `config.defaults.items` should be `{ id: string; title: string; tags: { id: string; tag: string }[] }[]`.
4. Verify Zod validation: `config.schema.parse({ enabled: true, name: "x", ... })` succeeds; `config.schema.parse({ enabled: "nope" })` fails.
