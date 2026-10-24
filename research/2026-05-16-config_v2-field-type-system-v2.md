# Config v2 — Field Type System (v2)

## Context

The config v2 system (`plugins/config_v2/`) currently has only the `store` sub-plugin (JSONC-on-disk backend). This task adds the **field type system** — the vocabulary for declaring typed config fields — and the **renderer dispatch** — the slot-based mechanism that renders fields in the UI. These are co-designed so adding a new field type is a single sub-plugin with `core/` (factory) + `web/` (renderer).

## Architecture

```
config_v2/
  core/                                    # Base types + defineConfig
    index.ts
    internal/
      types.ts                             # FieldDef, FieldMeta, FieldsRecord, ConfigDescriptor
      define-config.ts                     # defineConfig factory
      schema-builder.ts                    # buildFieldsSchema helper
  plugins/
    store/                                 # (already exists)
    fields/                                # Field type registry umbrella
      package.json
      web/
        index.ts                           # Plugin def + re-exports
        internal/
          slots.ts                         # Fields.Renderer slot
          field-renderer.tsx               # Dispatch host component
      plugins/
        primitives/                        # bool, text, int, float
          package.json
          core/
            index.ts                       # Re-exports all 4 factories
            internal/
              bool.ts
              text.ts
              int.ts
              float.ts
          web/
            index.ts                       # Plugin def, contributes renderers
            components/
              bool-renderer.tsx
              text-renderer.tsx
              int-renderer.tsx
              float-renderer.tsx
              field-header.tsx             # Shared label+description component
```

## Part 1: Core type system (`config_v2/core/`)

### `internal/types.ts`

The base `FieldDef` is an **open interface**, not a closed discriminated union — new field types are sub-plugins that extend it:

```ts
import type { z } from "zod";

export interface FieldMeta {
  label?: string;
  description?: string;
  placeholder?: string;
}

export interface FieldDef<T = unknown> {
  readonly kind: string;
  readonly schema: z.ZodType<T>;
  readonly defaultValue: T;
  readonly meta: FieldMeta;
}

export type FieldsRecord = Record<string, FieldDef>;

export type InferFieldValue<F> = F extends FieldDef<infer T> ? T : never;

export type InferFieldsObject<F extends FieldsRecord> = {
  [K in keyof F]: InferFieldValue<F[K]>;
};

export type ConfigValues<F extends FieldsRecord> = InferFieldsObject<F>;

export interface ConfigDescriptor<F extends FieldsRecord = FieldsRecord> {
  readonly schema: z.ZodObject<Record<string, z.ZodTypeAny>>;
  readonly fields: F;
  readonly defaults: ConfigValues<F>;
}
```

**Key decision: `FieldDef` is open.** Unlike v1's closed `FieldKind` union, any sub-plugin can define a new `kind` string. Compound fields (list, object — future sub-plugins) will extend `FieldDef` with additional properties like `fields: FieldsRecord`. The `kind` string is used by the web renderer slot to dispatch to the right component.

### `internal/schema-builder.ts`

```ts
export function buildFieldsSchema<F extends FieldsRecord>(
  fields: F,
): z.ZodObject<{ [K in keyof F]: F[K]["schema"] }>
```

Iterates field entries, maps each key to `field.schema`, passes to `z.object()`. Same pattern as `collections/core/internal/schema-builder.ts`.

### `internal/define-config.ts`

```ts
export function defineConfig<const F extends FieldsRecord>(opts: {
  fields: F;
}): ConfigDescriptor<F>
```

1. Validates no dots in field names
2. Composes schema via `buildFieldsSchema`
3. Computes defaults: `Object.fromEntries(entries.map(([k, f]) => [k, f.defaultValue]))`
4. Returns frozen `{ schema, fields, defaults }`

### `core/index.ts` barrel

Exports: `defineConfig`, `buildFieldsSchema`, all types (`FieldDef`, `FieldMeta`, `FieldsRecord`, `ConfigDescriptor`, `ConfigValues`, `InferFieldValue`, `InferFieldsObject`).

Note: `buildFieldsSchema` is exported (unlike v1 plan) because compound field sub-plugins (list, object) will need it to compose nested schemas.

## Part 2: Renderer slot (`config_v2/plugins/fields/web/`)

### `internal/slots.ts`

```ts
import type { ComponentType } from "react";
import type { FieldDef } from "@plugins/config_v2/core";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";

export interface FieldRendererProps {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
}

export interface FieldRendererContribution {
  kind: string;
  component: ComponentType<FieldRendererProps>;
}

export const Fields = {
  Renderer: defineSlot<FieldRendererContribution>(
    "config-v2.fields.renderer",
    { docLabel: (p) => p.kind },
  ),
};
```

**Props are `unknown`-typed.** Each renderer knows its own kind and narrows internally. This is the same pragmatic pattern as config v1's `Field` component (switches on kind, casts value). Type safety comes from the factory functions, not the renderer dispatch.

### `internal/field-renderer.tsx`

The dispatch host component — used by the settings pane (future) to render any field:

```tsx
export function FieldRenderer({ field, value, onChange }: FieldRendererProps) {
  const renderers = Fields.Renderer.useContributions();
  const match = renderers.find((r) => r.kind === field.kind);
  if (!match) return <Placeholder>Unknown field kind: {field.kind}</Placeholder>;
  const Comp = match.component;
  return <Comp field={field} value={value} onChange={onChange} />;
}
```

### `web/index.ts`

```ts
export { Fields } from "./internal/slots";
export { FieldRenderer } from "./internal/field-renderer";
export type { FieldRendererProps, FieldRendererContribution } from "./internal/slots";

export default definePlugin({ id: "fields", name: "Fields", contributions: [] });
```

No contributions from the umbrella itself — sub-plugins contribute renderers.

## Part 3: Primitive field sub-plugin (`fields/plugins/primitives/`)

### Core factories (`primitives/core/`)

Each factory returns a frozen `FieldDef<T>` with the appropriate `kind` string and Zod schema.

#### `bool.ts`

```ts
import { z } from "zod";
import type { FieldDef, FieldMeta } from "@plugins/config_v2/core";

export interface BoolFieldDef extends FieldDef<boolean> { readonly kind: "bool"; }

export function boolField(opts?: FieldMeta & { default?: boolean }): BoolFieldDef {
  return Object.freeze({
    kind: "bool" as const,
    schema: z.boolean(),
    defaultValue: opts?.default ?? false,
    meta: pickMeta(opts),
  });
}
```

`pickMeta` is a tiny shared helper: `(opts) => ({ label: opts?.label, description: opts?.description, placeholder: opts?.placeholder })`.

#### `text.ts`

```ts
export interface TextFieldDef extends FieldDef<string> { readonly kind: "text"; }

export function textField(opts?: FieldMeta & { default?: string }): TextFieldDef
```

Schema: `z.string()`. Default: `""`.

#### `int.ts`

```ts
export interface IntFieldDef extends FieldDef<number> {
  readonly kind: "int";
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export function intField(opts?: FieldMeta & {
  default?: number;
  min?: number;
  max?: number;
  step?: number;
}): IntFieldDef
```

Schema: `z.number().int()` with optional `.min()` / `.max()`. `step` is metadata for the UI only.

#### `float.ts`

Same shape as `int.ts` but `kind: "float"`, schema: `z.number()` (no `.int()` refinement).

#### `primitives/core/index.ts`

```ts
export { boolField, type BoolFieldDef } from "./internal/bool";
export { textField, type TextFieldDef } from "./internal/text";
export { intField, type IntFieldDef } from "./internal/int";
export { floatField, type FloatFieldDef } from "./internal/float";
```

### Web renderers (`primitives/web/`)

Each renderer receives `FieldRendererProps` and narrows value/field to its expected type.

#### `field-header.tsx`

Shared label + description, extracted from config v1's `FieldHeader`:

```tsx
export function FieldHeader({ field }: { field: FieldDef }) {
  return (
    <div>
      {field.meta.label && <label className="text-sm font-medium">{field.meta.label}</label>}
      {field.meta.description && <p className="text-xs text-muted-foreground">{field.meta.description}</p>}
    </div>
  );
}
```

#### `bool-renderer.tsx`

```tsx
export function BoolRenderer({ field, value, onChange }: FieldRendererProps) {
  return (
    <div className="flex items-center justify-between">
      <FieldHeader field={field} />
      <input type="checkbox" checked={value as boolean} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}
```

Matches config v1's `BooleanField` — checkbox with label on the left, toggle on the right. Commit on change (immediate, not on blur).

#### `text-renderer.tsx`

```tsx
export function TextRenderer({ field, value, onChange }: FieldRendererProps) {
  // useLocalValue for anti-echo protection (same pattern as config v1)
  return (
    <div>
      <FieldHeader field={field} />
      <Input value={local} placeholder={field.meta.placeholder} onChange={...} onBlur={commit} />
    </div>
  );
}
```

Uses shadcn `Input` from `@/components/ui/input`. Commits on blur, not on every keystroke.

#### `int-renderer.tsx` and `float-renderer.tsx`

Both render `<Input type="number">`. `int-renderer` rounds to integer on commit; `float-renderer` uses the raw parsed float. Both read `min`, `max`, `step` from the field definition and pass to the input.

#### `primitives/web/index.ts`

```ts
import { Fields } from "@plugins/config_v2/plugins/fields/web";

export default definePlugin({
  id: "primitives",
  name: "Primitives",
  contributions: [
    Fields.Renderer({ kind: "bool", component: BoolRenderer }),
    Fields.Renderer({ kind: "text", component: TextRenderer }),
    Fields.Renderer({ kind: "int", component: IntRenderer }),
    Fields.Renderer({ kind: "float", component: FloatRenderer }),
  ],
});
```

## Consumer experience summary

### Using fields (plugin author)

```ts
import { defineConfig } from "@plugins/config_v2/core";
import { boolField, textField, intField } from "@plugins/config_v2/plugins/fields/plugins/primitives/core";

export const myConfig = defineConfig({
  fields: {
    enabled: boolField({ label: "Auto-build on push", default: true }),
    maxRetries: intField({ label: "Max retries", min: 0, max: 10, default: 3 }),
  },
});
// myConfig.defaults.enabled → boolean (typed as true)
// myConfig.defaults.maxRetries → number (typed as 3)
```

### Adding a new field type (sub-plugin author)

1. Create `config_v2/plugins/fields/plugins/<name>/`
2. `core/index.ts` — export factory function that returns `FieldDef<T>` with unique `kind`
3. `web/index.ts` — contribute `Fields.Renderer({ kind, component })` to the slot

The settings pane auto-discovers the renderer via the slot. No registration step, no switch-case to edit.

### Rendering a config (settings pane — future, but the plumbing is ready)

```tsx
import { FieldRenderer } from "@plugins/config_v2/plugins/fields/web";

function ConfigSection({ config, values, onChange }) {
  return Object.entries(config.fields).map(([key, field]) => (
    <FieldRenderer key={key} field={field} value={values[key]} onChange={(v) => onChange(key, v)} />
  ));
}
```

## What's NOT in scope

- Settings pane integration (config auto-discovery, grouping by plugin, TOC)
- Server-side config reading hooks (readConfig equivalent)
- Compound fields (list, object) — future sub-plugins under `fields/plugins/`
- Domain-specific fields (avatar, color, enum, multiLineText, json) — future sub-plugins
- Config file generation / merge / codegen sub-plugins
- useConfig web hooks

## Implementation order

1. `config_v2/core/internal/types.ts`
2. `config_v2/core/internal/schema-builder.ts`
3. `config_v2/core/internal/define-config.ts`
4. `config_v2/core/index.ts`
5. `config_v2/plugins/fields/package.json`
6. `config_v2/plugins/fields/web/internal/slots.ts`
7. `config_v2/plugins/fields/web/internal/field-renderer.tsx`
8. `config_v2/plugins/fields/web/index.ts`
9. `config_v2/plugins/fields/plugins/primitives/package.json`
10. `config_v2/plugins/fields/plugins/primitives/core/internal/bool.ts`
11. `config_v2/plugins/fields/plugins/primitives/core/internal/text.ts`
12. `config_v2/plugins/fields/plugins/primitives/core/internal/int.ts`
13. `config_v2/plugins/fields/plugins/primitives/core/internal/float.ts`
14. `config_v2/plugins/fields/plugins/primitives/core/index.ts`
15. `config_v2/plugins/fields/plugins/primitives/web/components/field-header.tsx`
16. `config_v2/plugins/fields/plugins/primitives/web/components/bool-renderer.tsx`
17. `config_v2/plugins/fields/plugins/primitives/web/components/text-renderer.tsx`
18. `config_v2/plugins/fields/plugins/primitives/web/components/int-renderer.tsx`
19. `config_v2/plugins/fields/plugins/primitives/web/components/float-renderer.tsx`
20. `config_v2/plugins/fields/plugins/primitives/web/index.ts`
21. Register plugins in `web/src/plugins.ts` and `server/src/plugins.ts`

## Key files to reference during implementation

- `plugins/config/core/internal/lib.ts` — v1 defineConfig pattern (const generic, field validation)
- `plugins/config/web/components/field.tsx` — v1 renderer patterns (useLocalValue, checkbox, Input)
- `plugins/collections/core/internal/schema-builder.ts` — buildSchemas ZodRawShape pattern
- `plugins/collections/core/internal/field-types.ts` — FieldInstance + Object.freeze pattern
- `plugins/ui/plugins/segmented-progress-bar/web/slots.ts` — slot + variant contribution pattern
- `plugins/framework/plugins/web-sdk/CLAUDE.md` — defineSlot, definePlugin, contributions

## Verification

1. `./equin build` — TypeScript compiles, no import errors
2. Manually verify type inference in an editor: `defineConfig({ fields: { x: boolField() } }).defaults.x` should resolve to `boolean`
3. Take a screenshot to verify the renderers appear (if settings pane integration exists), otherwise write a temporary test page that renders `<FieldRenderer field={boolField({ label: "Test" })} value={true} onChange={console.log} />`
