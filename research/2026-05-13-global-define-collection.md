# `defineCollection` — Typed collection primitive

## Context

Five plugins repeat the same 4-layer boilerplate for managing user-editable lists:

| Plugin | PK | Ranked | Fields | Files |
|--------|-------|--------|--------|-------|
| prompt-templates | UUID `id` | yes | title, prompt | 8 server + 1 shared + 1 web |
| quick-prompts | UUID `id` | yes | title, prompt | 8 server + 1 shared + 1 web (identical to above) |
| category-colors | string `category` | no | category, colorKey, iconKey, iconSvgNodes | colocated in 2 files |
| excluded-path-state | string `path` | no | path, enabled | 1 file |
| agents | custom `id` | yes (tree) | name, prompt, model, icon, iconColor, iconSvgNodes, expanded, parentId | 8+ server files |

prompt-templates and quick-prompts are **character-for-character identical** except for names. Each new collection costs ~10 files of pure boilerplate.

This design introduces a `plugins/collections/` umbrella that collapses the stack into a single `defineCollection()` call, with standalone field primitives that define their own storage and renderers.

## User-facing API

### 1. Defining a collection

```ts
// plugins/.../prompt-templates/shared/collection.ts
import { defineCollection } from "@plugins/collections/core";
import { textField } from "@plugins/collections/plugins/fields/plugins/text/core";
import { multiLineTextField } from "@plugins/collections/plugins/fields/plugins/multiline-text/core";

export const promptTemplatesCollection = defineCollection({
  key: "prompt-templates",
  tableName: "prompt_templates",
  fields: {
    title: textField({ required: true }),
    prompt: multiLineTextField({ attachments: true }),
  },
});

// Inferred type:
// {
//   id: string;
//   title: string;
//   prompt: string;
//   rank: Rank;
//   createdAt: Date;
//   updatedAt: Date;
// }
```

Keyed collection (category-colors pattern — deferred to follow-up):

```ts
import { defineCollection } from "@plugins/collections/core";
import { textField } from "@plugins/collections/plugins/fields/plugins/text/core";
import { avatarField } from "@plugins/collections/plugins/fields/plugins/avatar/core";

export const categoryColorsCollection = defineCollection({
  key: "conversation-category-colors",
  tableName: "conversation_category_colors",
  primaryKey: "category",  // uses this field as PK; no auto-generated id
  ranked: false,            // no rank column
  fields: {
    category: textField({ required: true }),
    ...avatarField(),       // spreads icon, iconColor, iconSvgNodes fields
  },
});
```

### 2. Server plugin (replaces 8 handler files)

```ts
// plugins/.../prompt-templates/server/index.ts
import type { ServerPluginDefinition } from "@server/types";
import { Collection } from "@plugins/collections/server";
import { promptTemplatesCollection } from "../shared/collection";

const registered = Collection.register(promptTemplatesCollection);

export default {
  id: "prompt-templates",
  name: "Prompt Templates",
  httpRoutes: registered.httpRoutes,
  contributions: registered.contributions,
} satisfies ServerPluginDefinition;
```

Table re-export for drizzle-kit discovery (the only remaining `internal/` file):

```ts
// plugins/.../prompt-templates/server/internal/tables.ts
export const promptTemplatesTable = promptTemplatesCollection.table;
// If attachments: true on any field:
export const _promptTemplatesAttachments = registered.attachmentsTable;
```

For collections needing custom logic (like agents' cycle detection):

```ts
const registered = Collection.register(agentCollection, {
  beforeUpdate: async (id, patch, { db }) => {
    // cycle detection, validation, etc.
    return patch; // return modified patch, or throw to reject
  },
  afterDelete: async (id, { db }) => {
    otherResource.notify(); // side-effect notifications
  },
});
```

### 3. Client hook (replaces manual fetch wrappers)

```ts
import { useCollection } from "@plugins/collections/web";
import { promptTemplatesCollection } from "../shared/collection";

function MyComponent() {
  const { items, create, update, remove } = useCollection(promptTemplatesCollection);
  // items: PromptTemplate[]  — live via push resource
  // create: (input: { title: string; prompt?: string }) => Promise<PromptTemplate>
  // update: (id: string, patch: { title?: string; prompt?: string }) => Promise<void>
  // remove: (id: string) => Promise<void>
}
```

### 4. Settings list view (replaces per-plugin settings components)

```ts
// plugins/.../prompt-templates/web/index.ts
import { Config } from "@plugins/config/web";
import { CollectionSettingsList } from "@plugins/collections/plugins/settings-list/web";
import { promptTemplatesCollection } from "../shared/collection";

export default {
  id: "prompt-templates",
  contributions: [
    Config.Section({
      id: "prompt-templates",
      title: "Prompt Templates",
      component: () => <CollectionSettingsList collection={promptTemplatesCollection} />,
    }),
  ],
} satisfies PluginDefinition;
```

`CollectionSettingsList` renders each item's fields using field-type renderers contributed via a slot, with add/delete buttons and debounced blur-save.

---

## Field type design

Each field type is a sub-plugin that defines:

### Core barrel (storage + schema)

```ts
// plugins/collections/plugins/fields/plugins/text/core/index.ts
import { createFieldInstance } from "@plugins/collections/core";

export function textField(opts?: {
  required?: boolean;
  label?: string;
  default?: string;
}) {
  return createFieldInstance<string>({
    kind: "text",
    required: opts?.required ?? false,
    label: opts?.label,
    defaultValue: opts?.default ?? "",
    columns: (name) => ({ [name]: text(name).notNull() }),
    zodSchema: z.string(),
  });
}
```

The `FieldInstance<T>` interface:

```ts
interface FieldInstance<T> {
  readonly kind: string;       // unique identifier for renderer dispatch
  readonly required: boolean;
  readonly label?: string;
  readonly defaultValue: T;
  readonly _columns: (name: string) => Record<string, AnyPgColumn>;
  readonly _zodSchema: z.ZodType<T>;
  readonly _features?: { attachments?: boolean };
}
```

### Web barrel (renderers)

Each field sub-plugin contributes edit/display renderers via a slot:

```ts
// plugins/collections/plugins/fields/plugins/text/web/index.ts
import { Collections } from "@plugins/collections/web";

export default {
  id: "collections-text-field",
  contributions: [
    Collections.FieldRenderer({
      kind: "text",
      Edit: TextEdit,     // <Input> with onBlur save
      Display: TextDisplay, // <span>{value}</span>
    }),
  ],
} satisfies PluginDefinition;
```

### Multi-column fields (avatar)

Avatar maps to three DB columns but presents as one logical field. The factory returns a record that consumers spread:

```ts
// plugins/collections/plugins/fields/plugins/avatar/core/index.ts
export function avatarField(opts?: { label?: string }) {
  return {
    icon: createFieldInstance<string | null>({
      kind: "avatar-icon",
      columns: (name) => ({ [name]: text(name) }),
      zodSchema: z.string().nullable(),
      defaultValue: null,
    }),
    iconColor: createFieldInstance<string | null>({
      kind: "avatar-color",
      columns: (name) => ({ [name]: text(name) }),
      zodSchema: z.string().nullable(),
      defaultValue: null,
    }),
    iconSvgNodes: createFieldInstance<string | null>({
      kind: "avatar-svg-nodes",
      columns: (name) => ({ [name]: text(name) }),
      zodSchema: z.string().nullable(),
      defaultValue: null,
    }),
  };
}
```

The avatar web sub-plugin contributes a **composite renderer** that reads all three fields and renders `<AvatarPicker>`:

```ts
Collections.CompositeFieldRenderer({
  kinds: ["avatar-icon", "avatar-color", "avatar-svg-nodes"],
  Edit: AvatarFieldEdit,   // reads icon/iconColor/iconSvgNodes, renders AvatarPicker
  Display: AvatarFieldDisplay,
})
```

---

## End-to-end type flow

```
textField({ required: true })
  → FieldInstance<string> { kind: "text", required: true, _zodSchema: z.string(), _columns: ... }
       ↓
defineCollection({ fields: { title: FieldInstance<string>, prompt: FieldInstance<string> } })
  → Builds pgTable: { id: text().primaryKey(), title: text().notNull(), prompt: text().notNull(),
                       rank: rankText().notNull(), createdAt: timestamp(), updatedAt: timestamp() }
  → Builds Zod schemas:
      rowSchema:    z.object({ id: z.string(), title: z.string(), prompt: z.string(), rank: RankSchema, ... })
      createSchema: z.object({ title: z.string(), prompt: z.string().optional() })
      updateSchema: z.object({ title: z.string().optional(), prompt: z.string().optional() })
  → Builds resourceDescriptor<Row[]>(key, z.array(rowSchema), [])
  → Row type = z.infer<rowSchema>
       ↓
Collection.register(collection)  [server]
  → defineResource<Row[]>({ key, mode: "push", loader: db.select().from(table).orderBy(rank) })
  → Generic CRUD handlers: validate body against createSchema/updateSchema, insert/update/delete + notify
       ↓
useCollection(collection)  [web]
  → useResource(collection.resourceDescriptor) → live items: Row[]
  → Typed create/update/remove wrappers → fetch(routePrefix + path, ...)
```

---

## Plugin structure

```
plugins/collections/
├── package.json
├── core/
│   └── index.ts                    # defineCollection, createFieldInstance, types
│       internal/
│         define-collection.ts      # pgTable + Zod schema + resourceDescriptor generation
│         field-types.ts            # FieldInstance<T>, InferRow<F>, InferCreate<F>, InferUpdate<F>
│         table-builder.ts          # pgTable construction from FieldInstance records
│         schema-builder.ts         # Zod schema construction from FieldInstance records
├── server/
│   └── index.ts                    # Collection.register, server plugin def
│       internal/
│         register.ts               # Server resource + CRUD handler wiring
│         crud-handlers.ts          # Generic handleList/Create/Update/Delete factory
├── web/
│   └── index.ts                    # useCollection, Collections.FieldRenderer slot, plugin def
│       internal/
│         use-collection.ts         # useCollection hook
│         slots.ts                  # Collections.FieldRenderer, Collections.CompositeFieldRenderer
└── plugins/
    ├── fields/                     # umbrella grouping all field types
    │   ├── package.json
    │   └── plugins/
    │       ├── text/
    │       │   ├── core/index.ts           # textField()
    │       │   └── web/index.ts            # TextEdit, TextDisplay
    │       ├── multiline-text/
    │       │   ├── core/index.ts           # multiLineTextField()
    │       │   └── web/index.ts            # Wraps PromptEditor
    │       ├── boolean/
    │       │   ├── core/index.ts           # booleanField()
    │       │   └── web/index.ts            # Checkbox renderer
    │       ├── avatar/
    │       │   ├── core/index.ts           # avatarField() → { icon, iconColor, iconSvgNodes }
    │       │   └── web/index.ts            # AvatarPicker composite renderer
    │       └── color/
    │           ├── core/index.ts           # colorField()
    │           └── web/index.ts            # Color picker renderer
    └── settings-list/
        ├── package.json
        └── web/
            └── index.ts            # CollectionSettingsList component
                internal/
                  collection-settings-list.tsx
                  collection-row.tsx
```

Field imports use sub-plugin barrels directly:

```ts
import { defineCollection } from "@plugins/collections/core";
import { textField } from "@plugins/collections/plugins/fields/plugins/text/core";
import { multiLineTextField } from "@plugins/collections/plugins/fields/plugins/multiline-text/core";
import { avatarField } from "@plugins/collections/plugins/fields/plugins/avatar/core";
```

---

## Implementation phases

### Phase 1: Core type system

Files to create:
- `plugins/collections/package.json`
- `plugins/collections/core/index.ts`
- `plugins/collections/core/internal/field-types.ts` — `FieldInstance<T>`, `createFieldInstance`, `FieldsRecord`, `InferRow`, `InferCreateInput`, `InferUpdatePatch`
- `plugins/collections/core/internal/table-builder.ts` — builds `pgTable` from fields + options (id/rank/timestamps + field columns)
- `plugins/collections/core/internal/schema-builder.ts` — builds Zod schemas (row, create, update) from fields
- `plugins/collections/core/internal/define-collection.ts` — composes table-builder + schema-builder + `resourceDescriptor`

Key dependencies:
- `drizzle-orm/pg-core` — `pgTable`, `text`, `boolean`, `timestamp`
- `@plugins/primitives/plugins/rank/core` — `rankText`, `RankSchema`
- `@plugins/primitives/plugins/live-state/core` — `resourceDescriptor`
- `zod`

Table construction happens at import time (same as every existing `pgTable` call). Consumer re-exports from `server/internal/tables.ts` for drizzle-kit glob discovery (`plugins/**/server/**/internal/tables.ts`).

### Phase 2: Field sub-plugins

Create 5 field sub-plugins, each with `core/` and `web/` barrels:
- **text-field**: single `text()` column, `<Input>` edit with onBlur save
- **multiline-text-field**: single `text()` column, wraps `PromptEditor`, `attachments: true` support
- **boolean-field**: single `boolean()` column, checkbox edit
- **avatar-field**: 3 columns (icon, iconColor, iconSvgNodes), `AvatarPicker` composite renderer
- **color-field**: single `text()` column, color picker

Each web barrel contributes to `Collections.FieldRenderer` (or `CompositeFieldRenderer` for avatar).

### Phase 3: Server layer

Files to create:
- `plugins/collections/server/index.ts` — `Collection.register`, server plugin def
- `plugins/collections/server/internal/register.ts` — creates `defineResource`, wires CRUD handlers
- `plugins/collections/server/internal/crud-handlers.ts` — generic handler factory

`Collection.register(collection, hooks?)` returns:
- `httpRoutes` — `Record<string, HttpHandler>` with 4 CRUD routes
- `contributions` — `[Resource.Declare(serverResource)]`
- `serverResource` — for manual `.notify()` calls
- `table` — the drizzle table (same ref as `collection.table`)
- `attachmentsTable` — if any field has `attachments: true`, the `Attachments.defineLink` table

CRUD handler behaviors:
- **List**: `db.select().from(table).orderBy(rank, createdAt)` (rank ordering if ranked)
- **Create**: validate via `createSchema`, generate UUID id (or use PK field from body), `nextRankIn` if ranked, insert + notify. For `primaryKey` collections, uses `onConflictDoUpdate` (upsert)
- **Update**: validate via `updateSchema`, set `updatedAt`, update + notify
- **Delete**: delete by PK + notify

Attachment handling: for fields with `attachments: true`, create/update handlers call `attachmentLink.set(id, extractAttachmentIds(value))`.

Optional hooks: `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete` — for domain-specific logic like agents' cycle detection.

### Phase 4: Client layer

Files to create:
- `plugins/collections/web/index.ts` — `useCollection`, `Collections` slot namespace, plugin def
- `plugins/collections/web/internal/use-collection.ts` — hook implementation
- `plugins/collections/web/internal/slots.ts` — `Collections.FieldRenderer`, `Collections.CompositeFieldRenderer`

`useCollection(collection)` composes:
- `useResource(collection.resourceDescriptor)` for live `items`
- `useCallback` wrappers for `create`/`update`/`remove` that fetch against `routePrefix`

### Phase 5: Settings list view

Files to create:
- `plugins/collections/plugins/settings-list/package.json`
- `plugins/collections/plugins/settings-list/web/index.ts`
- `plugins/collections/plugins/settings-list/web/internal/collection-settings-list.tsx`
- `plugins/collections/plugins/settings-list/web/internal/collection-row.tsx`

`CollectionSettingsList` renders:
- Empty state message when no items
- Per-item rows with field renderers looked up by `kind` from `Collections.FieldRenderer.useContributions()`
- "Add" button (calls `create` with defaults)
- Delete button per row
- Debounced blur-save per field (reuses the `onBlur` pattern from existing settings)

### Phase 6: Migrate prompt-templates and quick-prompts

For each:
1. Create `shared/collection.ts` with `defineCollection` call
2. Replace `server/index.ts` to use `Collection.register`
3. Delete all `server/internal/handle-*.ts`, `resources.ts`, `rank.ts`
4. Reduce `server/internal/tables.ts` to a re-export of `collection.table`
5. Replace settings component with `CollectionSettingsList`
6. Update any internal imports (`PromptTemplate` type, resource descriptor) to point at collection
7. Keep domain-specific web components (chip rendering, floating actions) — they use `useResource(collection.resourceDescriptor)` instead of the old descriptor

Verify: the drizzle-kit migration after this change should be **empty** (schema unchanged). If not, the table builder doesn't match the hand-written table exactly — fix until it does.

### Future: Migrate category-colors (deferred)

Tests `primaryKey` + `ranked: false` + upsert semantics. Deferred to a follow-up once the framework is proven on the simpler cases.

---

## Design decisions

**D1: Collections live in consumer's `shared/`, not `core/`.** The collection definition must be importable by both server and web within the same plugin. `shared/` is the right scope — it's intra-plugin DRY. Promote to `core/` only if other plugins need to import the type/descriptor.

**D2: No umbrella re-exports of field factories.** The plugin boundary rules forbid cross-plugin re-exports. Consumers import field factories directly from sub-plugin core barrels (`@plugins/collections/plugins/fields/plugins/text/core`). Verbose but explicit. The `fields/` umbrella groups them under a semantic category.

**D3: Table is constructed eagerly at module load time.** Drizzle-kit discovers tables via glob (`plugins/**/server/**/internal/tables.ts`). The collection's `pgTable` call runs at import time when the consumer's `shared/collection.ts` is loaded. Consumer re-exports from their `server/internal/tables.ts`. This matches every existing table pattern.

**D4: Field renderers are slot-contributed, not hardcoded.** The `Collections.FieldRenderer` slot means new field types can be added as sub-plugins without touching the view layer. The settings-list view dispatches by `kind`.

**D5: `primaryKey` collections get upsert semantics.** When a collection uses a natural key (no auto-generated UUID), POST uses `INSERT ... ON CONFLICT DO UPDATE`. This naturally covers category-colors and excluded-path-state patterns without separate create/update distinction.

**D6: Attachment support is per-field, not per-collection.** Only `multiLineTextField({ attachments: true })` fields trigger `Attachments.defineLink` and `extractAttachmentIds` in handlers. This matches the current pattern where only `prompt` columns track attachments.

**D7: Agents and category-colors are out of scope for this round.** Agents have tree structure, computed views, multiple resources, and domain-specific validation. Category-colors tests the `primaryKey` + upsert path which needs the framework proven first. Both can adopt the framework in follow-ups.

---

## Verification

1. **Type check**: `tsc --noEmit` — inferred types from `defineCollection` must match hand-written types they replace
2. **Boundary check**: `./equin check --plugin-boundaries` — no boundary violations in the new umbrella
3. **Migration check**: After migrating prompt-templates/quick-prompts, `drizzle-kit generate` produces an empty migration (schema unchanged)
4. **Build**: `./equin build` succeeds
5. **Functional**: Settings page renders prompt-templates and quick-prompts identically to before — add, edit, delete, inline image paste all work
6. **Push resource**: Edit a template, verify other browser tabs receive the push update
7. **Screenshots**: `bun e2e/screenshot.mjs` before/after comparison of the Settings page

---

## Critical files

| Purpose | Path |
|---------|------|
| Canonical CRUD example | `plugins/.../prompt-templates/server/internal/handle-create.ts` |
| Canonical shared types | `plugins/.../prompt-templates/shared/resources.ts` |
| defineResource + Resource.Declare | `server/src/resources.ts` |
| resourceDescriptor | `plugins/primitives/plugins/live-state/core/internal/resource.ts` |
| rankText column | `plugins/primitives/plugins/rank/core/internal/types.ts` |
| nextRankIn/nextRankUnder | `plugins/primitives/plugins/rank/server/internal/helpers.ts` |
| Attachments.defineLink | `plugins/infra/plugins/attachments/server/internal/define-link.ts` |
| Drizzle config (glob) | `plugins/database/plugins/migrations/drizzle.config.ts` |
| Config.Section slot | `plugins/config/web/slots.ts` |
| AvatarPicker/Avatar | `plugins/primitives/plugins/avatar/web/` |
| PromptEditor | `plugins/primitives/plugins/prompt-editor/web/` |
| Existing settings UIs | `plugins/.../prompt-templates/web/components/prompt-templates-settings.tsx`, `plugins/.../quick-prompts/web/components/quick-prompts-settings.tsx`, `plugins/.../conversation-category/web/components/category-color-settings.tsx` |
