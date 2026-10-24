# config_v2: listField — sorted collections with stable identity

## Context

config_v2 supports 4 primitive field types (bool, text, int, float). Several plugins need sorted lists of structured items — conversation categories, review file sections, prompt templates — currently hacked as plain `string[]` in the old `config` system without stable identity or reordering support. `listField` is the most complex field type: it stores arrays of structured sub-items, each with an auto-injected UUID `id` and fractional-index `rank` for stable identity and sort order.

## Consumer API

```ts
const myConfig = defineConfig({
  fields: {
    categories: listField({
      label: "Conversation categories",
      description: "Labels for classification.",
      itemFields: {
        name: textField({ label: "Name" }),
        color: textField({ label: "Color", placeholder: "#ff0000" }),
      },
      default: [
        { name: "Bug", color: "#ff0000" },
        { name: "Feature", color: "#00ff00" },
      ],
    }),
  },
});
```

Runtime value shape: `Array<{ id: string; rank: string; name: string; color: string }>`, sorted by rank.

Consumers provide `default` as plain objects (no `id`/`rank`). The system injects them at read time.

## Plugin structure

New sub-plugin at `plugins/config_v2/plugins/fields/plugins/list/`, mirroring `primitives/`:

```
plugins/config_v2/plugins/fields/plugins/list/
├── CLAUDE.md
├── package.json
├── core/
│   ├── index.ts
│   └── internal/
│       └── list.ts           # listFieldType, listField(), ListFieldDef, ListItem
└── web/
    ├── index.ts              # contributes Fields.Renderer(ListRenderer)
    └── components/
        ├── list-renderer.tsx  # SortableList + add/remove
        └── list-item-row.tsx  # per-item sub-field rendering + drag handle
```

## Implementation steps

### 1. Core field definition

**File: `plugins/config_v2/plugins/fields/plugins/list/core/internal/list.ts`**

- `listFieldType = defineFieldType<ListItem<FieldsRecord>[]>("list")`
- `ListItem<F> = { id: string; rank: string } & InferFieldsObject<F>`
- `ListFieldDef<F>` extends `FieldDef<ListItem<F>[]>` and adds `readonly itemFields: F`
- Zod schema: `z.array(z.object({ id: z.string().optional(), rank: z.string().optional(), ...subFieldSchemas }))`
  - `id` and `rank` are optional so defaults pass validation (they're injected at runtime)
  - Sub-field schemas built from `itemFields[k].schema`
- `defaultValue`: the user-supplied `default` array as-is (no IDs), cast to `ListItem<F>[]`
- `isListFieldDef(field: FieldDef): field is ListFieldDef` type guard exported for duck-typing detection — checks `'itemFields' in field`

**Barrel: `core/index.ts`** — re-exports `listField`, `listFieldType`, `ListFieldDef`, `ListItem`, `isListFieldDef`.

### 2. ID and rank injection on server

**File: `plugins/config_v2/server/internal/registry.ts`**

Implement `injectCollectionIds` (currently a no-op stub at line 33):

```ts
function injectCollectionIds(
  doc: Record<string, unknown>,
  fields: FieldsRecord,
): Record<string, unknown> {
  const result = { ...doc };
  for (const [key, field] of Object.entries(fields)) {
    if (!('itemFields' in field)) continue;  // duck-type: only ListFieldDef has itemFields
    const arr = result[key];
    if (!Array.isArray(arr)) continue;
    let lastRank: Rank | null = null;
    result[key] = arr.map((item: Record<string, unknown>) => {
      const out = { ...item };
      if (!out.id || typeof out.id !== 'string') out.id = crypto.randomUUID();
      if (!out.rank || typeof out.rank !== 'string') {
        lastRank = Rank.between(lastRank, null);
        out.rank = lastRank.toString();
      } else {
        lastRank = Rank.from(out.rank as string);
      }
      return out;
    });
  }
  return result;
}
```

Import: `Rank` from `@plugins/primitives/plugins/rank/core`. No import from the list sub-plugin — detection is by duck-typing (`'itemFields' in field`), avoiding parent→child dependency.

**Also update `reloadValues`** (line 77) to call `injectCollectionIds` on the result:

```ts
const reloadValues = (): ConfigValues<FieldsRecord> => {
  const freshUserOrigin = jsoncConfigProxy(userOriginPath);
  const freshUserOverwrites = jsoncConfigProxy(userOverwritesPath);
  const raw = readTypedConfig(descriptor, freshUserOrigin, freshUserOverwrites);
  return injectCollectionIds(raw as Record<string, unknown>, descriptor.fields) as ConfigValues<FieldsRecord>;
};
```

This ensures consumers always get items with IDs, whether values come from defaults, origin files, or user overrides.

### 3. Web renderer

**File: `list-renderer.tsx`**

- `ListRenderer.type = listFieldType` (static property for slot dispatch)
- Receives `field: ListFieldDef`, `value: ListItem[]`, `onChange`
- Sorts value by rank: `[...value].sort((a, b) => Rank.compare(Rank.from(a.rank), Rank.from(b.rank)))`
- `FieldHeader` for label/description
- `SortableList` with `items={sorted.map(i => i.id)}` and `onMove` handler
- `onMove(activeId, overId)`: find neighbors at new position, `Rank.between(prev, next)`, update active item's rank, call `onChange(newArray)`
- "Add item" button: `crypto.randomUUID()` for id, `Rank.between(lastRank, null)` for rank, sub-field defaults from `field.itemFields`

**File: `list-item-row.tsx`**

- `SortableItem` with `handle={true}` — grip icon receives `state.handleProps`
- Each sub-field rendered via `FieldRenderer` with `onChange` that patches the item
- Remove button (trash icon) that filters the item from the array

### 4. isModified fix in ConfigFieldRow

**File: `plugins/config_v2/plugins/settings/web/components/config-field-row.tsx`**

The existing `value !== defaultValue` (reference equality) always returns true for list fields since injected IDs differ from defaults. Add a deep comparison helper:

```ts
function isFieldModified(field: FieldDef, value: unknown, defaultValue: unknown): boolean {
  if ('itemFields' in field) {
    // Strip id/rank before comparing list items
    const strip = (arr: unknown[]) => arr.map((item: Record<string, unknown>) => {
      const { id, rank, ...rest } = item;
      return rest;
    });
    return JSON.stringify(strip(value as unknown[])) !== JSON.stringify(strip(defaultValue as unknown[]));
  }
  return value !== defaultValue;
}
```

### 5. Plugin wiring

**`web/index.ts`**: default export with `Fields.Renderer(ListRenderer)` contribution, following the primitives pattern exactly.

**`package.json`**: `{ "name": "@singularity/plugin-config_v2-fields-list", "private": true, "description": "..." }`

**Registry**: Auto-discovered by `./equin build` codegen (scans for `web/index.ts` with default export). No manual registry edits.

### 6. Origin file generation

**No changes needed.** `renderOriginJsonc` calls `JSON.stringify(defaultValue)` per field. For list fields, this produces a valid JSON array:

```jsonc
// Labels for classification.
"categories": [{"name":"Bug","color":"#ff0000"},{"name":"Feature","color":"#00ff00"}]
```

IDs are intentionally absent in the origin file — they're injected at runtime. The `computeHash` hashes the content-without-IDs, which is deterministic across builds.

## Key files

| Purpose | Path |
|---|---|
| Pattern to follow (field factory) | `plugins/config_v2/plugins/fields/plugins/primitives/core/internal/bool.ts` |
| Pattern to follow (renderer) | `plugins/config_v2/plugins/fields/plugins/primitives/web/components/bool-renderer.tsx` |
| Pattern to follow (web barrel) | `plugins/config_v2/plugins/fields/plugins/primitives/web/index.ts` |
| ID injection stub | `plugins/config_v2/server/internal/registry.ts:33` |
| reloadValues to update | `plugins/config_v2/server/internal/registry.ts:77` |
| isModified to fix | `plugins/config_v2/plugins/settings/web/components/config-field-row.tsx:22` |
| FieldRenderer dispatch | `plugins/config_v2/plugins/fields/web/internal/field-renderer.tsx` |
| FieldRendererComponent type | `plugins/config_v2/plugins/fields/web/internal/slots.ts` |
| FieldDef/FieldType types | `plugins/config_v2/core/internal/types.ts` |
| SortableList/SortableItem | `plugins/primitives/plugins/sortable-list/web/` |
| Rank | `plugins/primitives/plugins/rank/core/` |
| FieldHeader (reuse) | `plugins/config_v2/plugins/fields/plugins/primitives/web/components/field-header.tsx` |

## Verification

1. **Build**: `./equin build` — typescript check, plugin registry sync, origin file generation
2. **Test with a real consumer**: Add a `listField` to an existing plugin's config (e.g., build or a test plugin) and verify:
   - Origin file generates with the array default
   - Server reads values with IDs injected
   - Settings UI renders the sortable list
   - Add/remove/reorder items and verify persistence (check `~/.singularity/config/` files)
   - Reset to defaults works
   - `isModified` indicator behaves correctly
3. **Boundary check**: `./equin check --plugin-boundaries` passes
4. **Screenshot**: Take a screenshot of the settings pane showing the list field UI
