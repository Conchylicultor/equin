# config_v2: Secret Field Type + Auth Migration

## Context

config_v2 stores all values in plain JSONC files at `~/.singularity/config/`. It has **no secret field support**. The old `plugins/config/` plugin has a complete secret pipeline: `secret: true` routes storage to the encrypted secrets store (`~/.singularity/secrets.json.enc`), the browser only gets `{ set: boolean }` metadata, and values never leave the server.

Auth plugins (Google OAuth, Notion OAuth) currently use the old config's `defineConfig` with `secret: true` for `clientId` and `clientSecret`. This is the last blocker preventing auth from migrating to config_v2 and eventually removing the old config plugin.

**Goal**: Add a `secretField` field type to config_v2, then migrate auth providers to use it.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Field type shape | Standalone `secretField` sub-plugin | Clean separation — different renderer, storage, read path |
| Extension point | Module-level function registry (like existing `field-resolvers.ts`) | Simpler than a contribution; singleton extension point |
| `setConfig` signature | Return `Promise<void>` | Only called from HTTP handlers (already async); no external callers |
| Renderer metadata | React context from `ConfigFieldRow`, exported via `fields/web` | Zero noise on `FieldRendererProps`; no dependency inversion |
| Secrets namespace | Same `"config-fields"` namespace + `"auth-google.clientId"` key format | Backward compatible — existing credentials work without migration |
| Central read path | `readSecretConfig()` in secret field plugin's `central/` barrel | Auth/central imports only the central barrel |

## Phase 1: Extension Point in config_v2

### 1.1 Field storage provider registry

Add to `plugins/config_v2/server/internal/registry.ts` — mirrors the existing `core/internal/field-resolvers.ts` pattern:

```ts
interface FieldStorageProvider {
  load(descriptorName: string, fieldKey: string): Promise<{ value: string; set: boolean }>;
  save(descriptorName: string, fieldKey: string, value: string): Promise<void>;
  clear(descriptorName: string, fieldKey: string): Promise<void>;
}
```

- `registerFieldStorageProvider(typeId, provider)` — called at module load by the secret field plugin's server barrel
- `getFieldStorageProvider(typeId)` — used by `initRegistry`/`setConfig` to check if a field type has custom storage
- `hasFieldStorageProvider(typeId)` — used by the resource redaction logic

Export all three from `plugins/config_v2/server/index.ts`.

### 1.2 Make `initRegistry()` async, pre-load secret values

`initRegistry()` → `async initRegistry()`. After populating each cache entry from JSONC, iterate `descriptor.fields` and for any field whose `type.id` has a registered provider, call `provider.load()` and overlay the value into `entry.values`.

`server/index.ts` already calls `initRegistry()` from async `onReady()` — add `await`.

**Files**: `plugins/config_v2/server/internal/registry.ts`, `plugins/config_v2/server/index.ts`

### 1.3 Make `setConfig` / `setConfigByPath` async

`setConfig` currently writes JSONC synchronously. Change it to:
1. Check `getFieldStorageProvider(field.type.id)`
2. If provider exists: update cache synchronously, call `await provider.save(...)`, notify subscribers + resource
3. If no provider: existing sync JSONC write path (unchanged)
4. Return `Promise<void>` (resolves immediately for non-secret fields)

`setConfigByPath` becomes async and awaits `setConfig`.

**Callers to update** (only internal — no external server plugins call `setConfig`):
- `plugins/config_v2/plugins/settings/server/internal/handlers.ts`: `handleSetField` — add `await` before `setConfigByPath`

### 1.4 Redact secret fields in `configV2ServerResource`

In `plugins/config_v2/server/internal/resource.ts`, modify the `configV2ServerResource` loader to replace secret field values with `""` (the field's `defaultValue`) before pushing to the browser:

```ts
loader: ({ path }) => {
  const descriptor = descriptorByPath.get(path);
  if (!descriptor || !configGetter) return {};
  const values = configGetter(descriptor) as Record<string, unknown>;
  const redacted = { ...values };
  for (const [key, field] of Object.entries(descriptor.fields)) {
    if (hasFieldStorageProvider(field.type.id)) {
      redacted[key] = field.defaultValue;
    }
  }
  return redacted as ConfigV2Values;
},
```

### 1.5 Export `getAllDescriptors` from resource.ts

The secret field plugin's server needs to look up descriptors to build the secrets metadata resource. Add:

```ts
export function getAllDescriptors(): [string, ConfigDescriptor][] {
  return [...descriptorByPath.entries()];
}
```

Export from `plugins/config_v2/server/index.ts`.

### 1.6 Add `ConfigFieldContext` to fields/web

Add a React context to `plugins/config_v2/plugins/fields/web/` that carries `{ storePath, fieldKey }`. The settings plugin provides it via `ConfigFieldRow`; field renderers that need it (like `SecretRenderer`) consume it. Other renderers ignore it.

```ts
// plugins/config_v2/plugins/fields/web/internal/config-field-context.ts
export const ConfigFieldContext = createContext<{ storePath: string; fieldKey: string } | null>(null);
```

Export from `plugins/config_v2/plugins/fields/web/index.ts`.

Modify `plugins/config_v2/plugins/settings/web/components/config-field-row.tsx`:
```tsx
<ConfigFieldContext.Provider value={{ storePath, fieldKey }}>
  <FieldRenderer field={field} value={value} onChange={handleChange} />
</ConfigFieldContext.Provider>
```

## Phase 2: Secret Field Sub-Plugin

### File structure

```
plugins/config_v2/plugins/fields/plugins/secret/
├── core/
│   ├── index.ts                   # re-exports
│   └── internal/
│       ├── secret.ts              # secretFieldType + secretField() factory
│       └── resource.ts            # config-v2.secret-meta resource descriptor
├── web/
│   ├── index.ts                   # Fields.Renderer(SecretRenderer)
│   └── components/
│       └── secret-renderer.tsx    # password input + set/not-set state
├── server/
│   ├── index.ts                   # registers storage provider, declares resource
│   └── internal/
│       ├── storage.ts             # secrets store read/write (FieldStorageProvider impl)
│       └── resource.ts            # secretMetaServerResource
├── central/
│   ├── index.ts                   # exports readSecretConfig
│   └── internal/
│       └── read-secret-config.ts  # reads config_v2 descriptor from secrets store
└── package.json
```

### 2.1 Core: field type + factory

`core/internal/secret.ts`:
```ts
export const secretFieldType = defineFieldType<string>("secret");

export interface SecretFieldDef extends FieldDef<string> {
  readonly type: typeof secretFieldType;
}

export function secretField(opts?: FieldMeta): SecretFieldDef {
  return Object.freeze({
    type: secretFieldType,
    schema: z.string(),
    defaultValue: "",
    meta: { label: opts?.label, description: opts?.description, placeholder: opts?.placeholder },
  });
}
```

### 2.2 Core: secrets metadata resource descriptor

`core/internal/resource.ts`:
```ts
export const configV2SecretMetaResource = resourceDescriptor<
  Record<string, { set: boolean; updatedAt?: number }>,
  { path: string }
>("config-v2.secret-meta", schema, {});
```

Parametrized by `{ path }` (storePath) — same pattern as `config-v2.values`.

### 2.3 Server: storage provider

`server/internal/storage.ts` — implements `FieldStorageProvider`:
- `load`: `getSecret({ namespace: "config-fields", key: "${name}.${field}" })` + `getSecretMetadata`
- `save`: `setSecret(...)` + `secretMetaServerResource.notify({ path })`
- `clear`: `deleteSecret(...)` + notify

Handles `SecretsMainOfflineError` gracefully (returns `{ value: "", set: false }`).

### 2.4 Server: secrets metadata resource

`server/internal/resource.ts` — `defineResource` with key `"config-v2.secret-meta"`. Loader iterates the descriptor's fields, calls `getSecretMetadata` for each secret field, returns the metadata map.

### 2.5 Server barrel

`server/index.ts`:
- Module-level side effect: `registerFieldStorageProvider(secretFieldType.id, secretStorageProvider)`
- `contributions: [Resource.Declare(secretMetaServerResource)]`
- Registers the handler for `setConfigField` endpoint delegating to the storage provider (this is handled transparently via the modified `setConfig` — no separate endpoint needed)

### 2.6 Web: SecretRenderer

`web/components/secret-renderer.tsx`:
- `SecretRenderer.type = secretFieldType` (dispatch key)
- Reads `ConfigFieldContext` to get `storePath`/`fieldKey`
- Subscribes to `configV2SecretMetaResource` for `{ set: boolean }` state
- Renders: if set → "Configured" badge + "Replace" button; if not set → password input + "Save" button
- On save: calls `fetchEndpoint(setConfigField, {}, { body: { storePath, key, value } })` (same endpoint as all other fields — the server-side `setConfig` routes to secrets store)
- On save success: clears local draft so plaintext doesn't linger in React state
- Clear/delete: calls `fetchEndpoint(resetConfigField, ...)` — `resetConfigByPath` needs to handle secret fields by calling `provider.clear()`

### 2.7 Central: `readSecretConfig`

`central/internal/read-secret-config.ts`:
```ts
export async function readSecretConfig<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
): Promise<ConfigValues<F>> {
  const result = { ...descriptor.defaults } as Record<string, unknown>;
  for (const [key, field] of Object.entries(descriptor.fields)) {
    if (field.type.id === "secret") {
      const v = await getSecret({
        namespace: "config-fields",
        key: `${descriptor.name}.${key}`,
      });
      result[key] = v ?? "";
    }
  }
  return result as ConfigValues<F>;
}
```

Uses `getSecret` from `@plugins/infra/plugins/secrets/central` (in-process, same runtime).

## Phase 3: Migrate Auth Plugins

### 3.1 Google: shared config

`plugins/auth/plugins/google/shared/config.ts`:
```ts
import { defineConfig } from "@plugins/config_v2/core";
import { secretField } from "@plugins/config_v2/plugins/fields/plugins/secret/core";

export const googleAuthConfig = defineConfig({
  name: "auth-google",   // critical: matches old key format for backward compat
  fields: {
    clientId: secretField({ label: "OAuth Client ID", description: "..." }),
    clientSecret: secretField({ label: "OAuth Client Secret", description: "..." }),
  },
});
```

### 3.2 Google: server

`plugins/auth/plugins/google/server/index.ts`:
- `Config.Field(googleAuthConfig)` → `ConfigV2.Register({ descriptor: googleAuthConfig })`
- Import from `@plugins/config_v2/server` instead of `@plugins/config/server`

### 3.3 Google: web

`plugins/auth/plugins/google/web/index.ts`:
- `Config.Spec(googleAuthConfig)` → `ConfigV2.WebRegister({ descriptor: googleAuthConfig })`
- Import from `@plugins/config_v2/web` instead of `@plugins/config/web`

### 3.4 Google: central descriptor

`plugins/auth/plugins/google/central/internal/descriptor.ts`:
- `readGlobalConfig("auth-google", googleAuthConfig)` → `readSecretConfig(googleAuthConfig)`
- Import from `@plugins/config_v2/plugins/fields/plugins/secret/central`

### 3.5 Google: setup wizard

`plugins/auth/plugins/google/plugins/setup-wizard/web/components/google-setup-pane.tsx`:
- `setConfigValue("auth-google.clientId", v)` → `fetchEndpoint(setConfigField, {}, { body: { storePath, key: "clientId", value: v } })` where `storePath` is resolved via `useConfigRegistrations()`
- `useSecretFieldSet("auth-google.clientId")` → `useResource(configV2SecretMetaResource, { path: storePath })` then `data["clientId"]`
- Import from `@plugins/config_v2/plugins/fields/plugins/secret/core` and `@plugins/infra/plugins/endpoints/web`

### 3.6 Notion: same changes

Same pattern for `plugins/auth/plugins/notion/` — `shared/config.ts`, `server/index.ts`, `web/index.ts`, `central/internal/descriptor.ts`. Notion has no setup wizard.

### 3.7 Auth central: `readGlobalConfig`

`plugins/auth/central/internal/global-config.ts`:
- If no other consumer uses `readGlobalConfig`, it can be removed. Both google and notion descriptors call `readSecretConfig` directly.
- The export `readGlobalConfig` from `@plugins/auth/central` can be deprecated/removed.

### 3.8 `resetConfigByPath` for secret fields

Modify `resetConfigByPath` in `plugins/config_v2/server/internal/registry.ts` to handle secret fields: if the field has a storage provider, call `provider.clear()` instead of writing the default value to JSONC.

## Phase 4: Plugin Registration

- Add `plugins/config_v2/plugins/fields/plugins/secret/` entries to:
  - `web/src/plugins.ts` (web plugin registry)
  - `plugins/framework/plugins/server-core/bin/plugins.ts` (server plugin registry)
  - Or rely on `./equin build` auto-generation

## Backward Compatibility

Existing secrets stored via the old config plugin at `{ namespace: "config-fields", key: "auth-google.clientId" }` will be readable by config_v2's secret field plugin because:
1. Same namespace: `"config-fields"`
2. Same key format: `"${descriptorName}.${fieldKey}"`
3. Descriptor name `"auth-google"` matches the old plugin ID

**No migration step needed.** Users who already configured Google OAuth credentials keep them.

## Verification

1. `./equin build` — confirm build succeeds
2. Open Settings → verify Google auth config appears with "Configured" state (if credentials were previously set)
3. Clear and re-enter credentials → verify they persist across server restart
4. Open Accounts → verify Google connect flow still works
5. Check the browser never receives secret values (inspect `config-v2.values` resource — secret fields show as `""`)
6. Verify `./equin check` passes
