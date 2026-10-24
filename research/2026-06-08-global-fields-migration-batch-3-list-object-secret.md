# Fields migration — batch 3: list, object, secret

## Context

The unified `fields/` primitive (research `2026-06-06-global-unified-fields-primitive.md`)
reorganizes field-type knowledge into a `type × capability` matrix under
`plugins/fields/plugins/<type>/`. Batches 1–2 already relocated the config field
plugins for text, bool, int, float, multiline-text, enum, dynamic-enum, color, and
avatar. The token now lives in `fields/core`; each type registers an identity in the
`fields.identity` slot (`fields/web`) and contributes its config renderer to the frozen
`config-v2.fields.renderer` slot from a `plugins/config` sub-plugin.

**Batch 3** moves the three highest-risk remaining types out of
`plugins/config_v2/plugins/fields/plugins/{list,object,secret}/`:

- **list / object** — recursive: their renderers dispatch nested sub-fields back through
  the same renderer slot. Recursion must be preserved exactly.
- **secret** — a 4-runtime unit (core/web/server/central): a `FieldStorageProvider`
  registration, a live-state meta resource, and the central `readSecretConfig` consumed by
  auth providers. A secret must **never** become a readable table cell.

The migration is **pure relocation + import-path updates**, behavior-preserving. The
template is the already-migrated **`avatar`** (a config-only type):
`plugins/fields/plugins/avatar/{core,web,plugins/config/{core,web}}`.

> Out of scope: `string-list` (still in `config_v2/plugins/fields/plugins/string-list/`,
> not part of batch 3; not in the matrix). Flag as the last remaining config_v2 field plugin.

## Migration invariants (must not change — load-bearing strings)

| Invariant | Value |
|---|---|
| Renderer dispatch slot id | `"config-v2.fields.renderer"` (owned by `config_v2/plugins/fields/web`, unchanged) |
| Dispatch key | `field.type.id` |
| `listFieldType.id` | `"list"` |
| `objectFieldType.id` | `"object"` |
| `secretFieldType.id` | `"secret"` (also the `registerFieldStorageProvider` key) |
| Secret meta resource id | `"config-v2.secret-meta"` (web descriptor + server `defineResource` key) |
| Secret storage namespace | `"config-fields"` |
| Secret storage key pattern | `` `${descriptorName}.${fieldKey}` `` |
| `readSecretConfig` type guard | `field.type.id === "secret"` |

Recursion is preserved automatically: `list-item-row.tsx` / `object-renderer.tsx` keep
importing `FieldRenderer` from `@plugins/config_v2/plugins/fields/web` (slot owner does not
move), and the renderers keep contributing to the same slot with the same token ids.

## Target structure (mirrors `avatar`)

For **list** and **object** (`<t>` ∈ {list, object}):

```
plugins/fields/plugins/<t>/
  package.json                         @singularity/plugin-fields-<t>
  CLAUDE.md
  core/
    index.ts                           re-export <t>FieldType, <t>Identity, value types
    internal/<t>-type.ts               token + identity (+ ListItem type for list)
  web/
    index.ts                           Fields.Identity({ identity: <t>Identity })  (from @plugins/fields/web)
  plugins/config/
    package.json                       @singularity/plugin-fields-<t>-config
    CLAUDE.md
    core/
      index.ts                         re-export <t>Field, <T>FieldDef, is<T>FieldDef
      internal/<t>.ts                  factory + Def + guard
    web/
      index.ts                         Fields.Renderer(<T>Renderer)  (from @plugins/config_v2/plugins/fields/web)
      components/...                    moved renderer files
```

For **secret** the `plugins/config` sub-plugin carries all four runtimes:

```
plugins/fields/plugins/secret/
  package.json / CLAUDE.md
  core/index.ts + internal/secret-type.ts     secretFieldType + secretIdentity (NO coerce)
  web/index.ts                                Fields.Identity({ identity: secretIdentity })
  plugins/config/
    package.json / CLAUDE.md
    core/
      index.ts                                secretField, SecretFieldDef,
                                              configV2SecretMetaResource, configV2SecretMetaSchema, ConfigV2SecretMeta
      internal/secret.ts                      factory + Def
      internal/resource.ts                    configV2SecretMetaResource (id "config-v2.secret-meta")
    web/index.ts + components/secret-renderer.tsx
    server/
      index.ts                                import "./internal/register"; Resource.Declare(secretMetaServerResource)
      internal/register.ts                    registerFieldStorageProvider(secretFieldType.id, ...)
      internal/resource.ts                    secretMetaServerResource (key "config-v2.secret-meta")
      internal/storage.ts                     secretStorageProvider (namespace "config-fields")
    central/
      index.ts                                export { readSecretConfig }
      internal/read-secret-config.ts
```

### Token / factory import split (per the avatar precedent)

- **Token + identity** (type `core/internal/<t>-type.ts`): import `defineFieldType`,
  `defineFieldIdentity` from `@plugins/fields/core`.
  - `list` token is `defineFieldType<ListItem<FieldsRecord>[]>("list")`, so the type core
    keeps the **type-only** imports `FieldsRecord`, `InferFieldsObject` from
    `@plugins/config_v2/core` and defines/exports `ListItem<F>` here (analogous to avatar's
    `AvatarSpec`). This is a leaf→`config_v2/core` edge, not a cycle (`config_v2/core` never
    imports `fields/plugins/*`).
  - `object` / `secret` tokens have no config_v2 type dependency.
- **Factory + Def + guard** (config `core/internal/<t>.ts`): import the token from
  `@plugins/fields/plugins/<t>/core`; keep `FieldDef`, `FieldMeta`, `FieldType`,
  `FieldsRecord`, `InferFieldsObject`, `fieldSchemaWithDefault` from `@plugins/config_v2/core`
  (unchanged). Preserve the local `pickMeta` in list/object byte-for-byte.
- **Renderers**: keep `FieldRendererComponent` / `FieldRenderer` / `ConfigFieldContext` from
  `@plugins/config_v2/plugins/fields/web`; import the token from
  `@plugins/fields/plugins/<t>/core`; `<T>Renderer.type = <t>FieldType` unchanged.

### Identities

- `listIdentity`: `{ type: listFieldType, label: "List", icon: MdList }` — no `coerce`, no `extends`.
- `objectIdentity`: `{ type: objectFieldType, label: "Object", icon: MdDataObject }` — no `coerce`, no `extends`.
- `secretIdentity`: `{ type: secretFieldType, label: "Secret", icon: MdKey }` — **no `coerce`**
  and **no `plugins/table` or `plugins/filter` sub-plugin**. Omitting `coerce` + having no cell
  contribution is what keeps secret out of any data-view projection (risk #4). Document this in
  the secret CLAUDE.md.

## Importers to update (the worklist)

**`listField`** → `@plugins/fields/plugins/list/plugins/config/core`:
- `plugins/stats/plugins/commits/shared/config.ts`
- `plugins/review/plugins/code-review/shared/config.ts`
- `plugins/conversations/plugins/preprompts/shared/config.ts`
- `plugins/conversations/plugins/conversation-category/shared/config.ts`
- `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/shared/config.ts`
- `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/shared/config.ts`

**`objectField`** → `@plugins/fields/plugins/object/plugins/config/core`:
- `plugins/conversations/plugins/model-provider/shared/config.ts`
- `plugins/ui/plugins/tokens/plugins/{typography,color-palette,categorical,density,chart,shadow,sidebar-palette,shape}/shared/config.ts` (8 files)

**`secretField`** → `@plugins/fields/plugins/secret/plugins/config/core`:
- `plugins/auth/plugins/google/shared/config.ts`
- `plugins/auth/plugins/notion/shared/config.ts`

**`configV2SecretMetaResource`** → `@plugins/fields/plugins/secret/plugins/config/core`:
- `plugins/auth/plugins/google/plugins/setup-wizard/web/components/google-setup-pane.tsx`

**`readSecretConfig`** → `@plugins/fields/plugins/secret/plugins/config/central`:
- `plugins/auth/plugins/google/central/internal/descriptor.ts`
- `plugins/auth/plugins/notion/central/internal/descriptor.ts`

No code outside the moved trees imports `isListFieldDef`, `ListItem`, `listFieldType`,
`isObjectFieldDef`, or `objectFieldType` (verified — only docs/research references), so those
move with the trees with no extra call-site churn. `*.generated.ts` plugin registries are
rebuilt by `./equin build`, not hand-edited.

## Execution order

1. Create `fields/plugins/list/` (type core+web, config core+web), porting `list.ts`,
   `list-renderer.tsx`, `list-item-row.tsx` with the import split above. Add `listIdentity`.
2. Create `fields/plugins/object/` likewise (`object.ts`, `object-renderer.tsx`).
3. Create `fields/plugins/secret/` (type core+web) + `plugins/config/{core,web,server,central}`,
   porting `secret-type` token, `secretIdentity`, `secret.ts` factory, `resource.ts`,
   `secret-renderer.tsx`, `register.ts`, `storage.ts`, server `resource.ts`, `read-secret-config.ts`.
4. Update all importer call sites (worklist above).
5. Delete the old trees:
   `plugins/config_v2/plugins/fields/plugins/{list,object,secret}/`.
6. Update doc prose: `plugins/config_v2/CLAUDE.md` "Declaring config" example (the `listField`
   import line) and `plugins/config_v2/plugins/fields/CLAUDE.md` sub-plugin prose. Add per-plugin
   `CLAUDE.md` for each new plugin (hand-written prose; autogen reference blocks fill on build).
7. `./equin build` (regenerates registries + docs), then `./equin check`.

## Critical files (moved, not rewritten)

- `plugins/config_v2/plugins/fields/plugins/list/core/internal/list.ts` → split into list type core + config core.
- `plugins/config_v2/plugins/fields/plugins/list/web/components/{list-renderer,list-item-row}.tsx` → config/web.
- `plugins/config_v2/plugins/fields/plugins/object/core/internal/object.ts` → split.
- `plugins/config_v2/plugins/fields/plugins/object/web/components/object-renderer.tsx` → config/web.
- `plugins/config_v2/plugins/fields/plugins/secret/core/internal/{secret.ts,resource.ts}` → token→type core, factory+resource→config core.
- `plugins/config_v2/plugins/fields/plugins/secret/web/components/secret-renderer.tsx` → config/web.
- `plugins/config_v2/plugins/fields/plugins/secret/server/internal/{register,storage,resource}.ts` → config/server.
- `plugins/config_v2/plugins/fields/plugins/secret/central/internal/read-secret-config.ts` → config/central.

## Verification

- `./equin build` succeeds; `./equin check` passes (plugin-boundaries,
  migrations-in-sync, eslint, plugins-doc-in-sync).
- Settings pane (`http://<wt>.localhost:9000`, Settings):
  - A **list** config (e.g. code-review patterns) renders, items add/remove/reorder, and a
    nested sub-field edits → persists to JSONC. A **nested object inside list / object inside
    object** still dispatches (recursion intact).
  - An **object** config (e.g. a `ui/tokens` overrides group) renders its collapsible
    sub-fields and edits persist.
  - A **secret** field (Accounts → Google/Notion auth): set a value → shows "Configured";
    "Replace" re-enters edit; clear works. The set/not-set indicator updates live (meta
    resource). Auth still reads the decrypted value (`readSecretConfig`) — connect flow works.
- Grep confirms no remaining `@plugins/config_v2/plugins/fields/plugins/{list,object,secret}`
  imports anywhere outside docs/research; the three old trees are gone.
- Confirm secret contributes no `data-view.cell` / `data-view.filter` and has no `coerce`
  (no readable-table-cell path).
```
