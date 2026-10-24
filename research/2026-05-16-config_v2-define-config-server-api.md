# Config v2: Server-side `defineConfig` API

## Context

Config v2 already has:
- `core/`: `defineConfig({ fields })` → `ConfigDescriptor<F>` (schema + fields + defaults, no IO)
- `plugins/store/server/`: `getConfigStore()` → `ConfigStore` interface (read/write/watch JSONC files at `~/.singularity/config/`)
- `plugins/fields/plugins/primitives/core/`: field type factories (`boolField`, `textField`, `intField`, `floatField`)

Missing: a server barrel that wires these together so plugins can register a config block and read/write typed values at runtime.

## Consumer API (before/after)

**Before (v1, DB-backed):**
```ts
// plugins/build/shared/config.ts
import { defineConfig } from "@plugins/config/core";
export const buildConfig = defineConfig({
  autoBuild: { default: true, label: "Auto-build on push" },
});

// plugins/build/server/index.ts
import { Config } from "@plugins/config/server";
contributions: [Config.Field(buildConfig)]

// plugins/build/server/internal/handler.ts
import { readConfig } from "@plugins/config/server";
import { buildConfig } from "../../shared/config";
const { autoBuild } = await readConfig(buildConfig); // async DB query every time
```

**After (v2, JSONC on disk):**
```ts
// plugins/build/shared/config.ts
import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/config_v2/plugins/fields/plugins/primitives/core";

export const buildConfig = defineConfig({
  fields: { autoBuild: boolField({ default: true, label: "Auto-build on push" }) },
});

// plugins/build/server/index.ts
import { ConfigV2 } from "@plugins/config_v2/server";
import { buildConfig } from "../shared/config";
contributions: [ConfigV2.Register(buildConfig)]

// plugins/build/server/internal/handler.ts
import { getConfig, setConfig } from "@plugins/config_v2/server";
import { buildConfig } from "../../shared/config";
const { autoBuild } = getConfig(buildConfig);          // sync, typed, from memory cache
await setConfig(buildConfig, "autoBuild", false);      // async write-through to disk
```

**File on disk:** `~/.singularity/config/build/config.jsonc`
```jsonc
{
  "autoBuild": true
}
```

## Path auto-derivation

The config file path is derived automatically from the plugin's position in the hierarchy. No explicit path in the consumer code.

**Mechanism:**

1. `PluginNode` already has `hierarchyId` (e.g. `"conversations.conversation-category"`) computed by `buildPluginTree`.

2. The codegen (`tooling/src/plugin-registry-gen.ts`) already iterates plugin nodes. It will emit a new stamp per plugin:
   ```ts
   (buildPlugin as ServerPluginDefinition)._hierarchyPath = "build";
   (conversationsConversationCategoryPlugin as ServerPluginDefinition)._hierarchyPath = "conversations/conversation-category";
   ```
   Derived from `node.hierarchyId.replaceAll('.', '/')`.

3. `collectContributions()` in `server/src/contributions.ts` already stamps `_pluginId` on each contribution. It will additionally stamp `_hierarchyPath`:
   ```ts
   c._pluginId = p.id;
   c._hierarchyPath = p._hierarchyPath;  // NEW
   ```

4. During config_v2's `onReady`, each collected `ConfigV2.Register` contribution has `_hierarchyPath`. The config store path becomes:
   ```
   <_hierarchyPath>/<configName>.jsonc
   ```
   Where `configName` defaults to `"config"` (configurable via `defineConfig({ name: "categories", fields: {...} })`).

**Examples:**
| Plugin location | hierarchyPath | name | File on disk |
|---|---|---|---|
| `plugins/build/` | `build` | (default: `config`) | `~/.singularity/config/build/config.jsonc` |
| `plugins/conversations/plugins/conversation-category/` | `conversations/conversation-category` | `categories` | `~/.singularity/config/conversations/conversation-category/categories.jsonc` |

## Type Signatures

```ts
// Added to core/defineConfig options:
interface DefineConfigOpts<F extends FieldsRecord> {
  name?: string;   // config file name (default: "config")
  fields: F;
}

// Server barrel exports:
export function getConfig<F extends FieldsRecord>(descriptor: ConfigDescriptor<F>): ConfigValues<F>;
export function setConfig<F extends FieldsRecord, K extends keyof F & string>(
  descriptor: ConfigDescriptor<F>,
  key: K,
  value: InferFieldValue<F[K]>,
): Promise<void>;
export function watchConfig<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  cb: (values: ConfigValues<F>) => void,
): Disposable;

// Contribution token:
export const ConfigV2: { Register: ServerContributionToken<ConfigDescriptor> };
```

## File Structure

```
plugins/config_v2/
  core/
    index.ts                         ← add: `name` to ConfigDescriptor
    internal/
      define-config.ts               ← add: `name` option
      types.ts                       ← add: `name` to ConfigDescriptor interface
  server/
    index.ts                         ← NEW: barrel + ServerPluginDefinition + exports
    internal/
      contribution.ts                ← NEW: ConfigV2.Register token
      registry.ts                    ← NEW: cache, getConfig, setConfig, watchConfig, init/shutdown
server/src/
  contributions.ts                   ← add: _hierarchyPath stamp
  types.ts                           ← add: _hierarchyPath? to ServerPluginDefinition
tooling/src/
  plugin-registry-gen.ts             ← add: _hierarchyPath emission
```

## Implementation Details

### `plugins/config_v2/core/internal/types.ts` — add `name`

```ts
export interface ConfigDescriptor<F extends FieldsRecord = FieldsRecord> {
  readonly name: string;              // NEW
  readonly schema: z.ZodObject<...>;
  readonly fields: F;
  readonly defaults: ConfigValues<F>;
}
```

### `plugins/config_v2/core/internal/define-config.ts` — accept `name`

```ts
export function defineConfig<const F extends FieldsRecord>(opts: {
  name?: string;
  fields: F;
}): ConfigDescriptor<F> {
  // ... existing validation ...
  return Object.freeze({
    name: opts.name ?? "config",
    schema,
    fields: opts.fields,
    defaults,
  });
}
```

### `plugins/config_v2/server/internal/registry.ts` — core logic

Module-level state:
- `cacheByDescriptor: WeakMap<ConfigDescriptor, { values: ConfigValues; disposable: Disposable }>`
- `registeredDescriptors: Map<string, { descriptor: ConfigDescriptor; hierarchyPath: string }>` (keyed by store path)

**`initRegistry()`** (called from `onReady`):
1. Iterate `ConfigV2.Register.getContributions()`.
2. For each: derive store path = `${contribution._hierarchyPath}/${descriptor.name}.jsonc`.
3. Call `getConfigStore().watch(storePath, onFileChanged)` — the store fires a seed read immediately (async).
4. Each entry gets a `readyPromise` that resolves when the first watch callback fires.
5. `await Promise.all(readyPromises)` — ensures all caches are populated before `onReady` returns.

**`onFileChanged(rawValue, descriptor)`**:
- If `rawValue === undefined` → use `descriptor.defaults`.
- Otherwise: per-field validation via `field.schema.safeParse(rawValue[key])`. Valid → use parsed; invalid → use `field.defaultValue`. Single corrupt field doesn't poison the whole config.
- Update cache. Fire watch subscribers. Resolve readyPromise if first call.

**`getConfig(descriptor)`**:
- Look up in `cacheByDescriptor`. Throw if not found (either not registered or called before onReady).
- Return cached values (synchronous).

**`setConfig(descriptor, key, value)`**:
- Validate via `descriptor.fields[key].schema.parse(value)`.
- Build full document from cache: `{ ...current, [key]: value }`.
- Apply `injectCollectionIds(doc, descriptor.fields)` (no-op until listField exists).
- `await getConfigStore().write(storePath, document)`.
- Cache updates via the watch callback (single source of truth).

**`watchConfig(descriptor, cb)`**:
- Add to subscriber set for that descriptor.
- Fire immediately with current values if initialized.
- Return disposable.

### `plugins/config_v2/server/internal/contribution.ts`

```ts
import { defineServerContribution } from "@server/contributions";
import type { ConfigDescriptor } from "../../core";

export const ConfigV2 = {
  Register: defineServerContribution<ConfigDescriptor>("ConfigV2.Register"),
};
```

### `plugins/config_v2/server/index.ts`

```ts
import type { ServerPluginDefinition } from "@server/types";
import storePlugin from "@plugins/config_v2/plugins/store/server";
import { initRegistry, shutdownRegistry } from "./internal/registry";

export { ConfigV2 } from "./internal/contribution";
export { getConfig, setConfig, watchConfig } from "./internal/registry";

export default {
  id: "config-v2",
  name: "Config v2",
  description: "Typed JSONC config handles for server plugins.",
  dependsOn: [storePlugin],
  async onReady() {
    await initRegistry();
  },
  async onShutdown() {
    shutdownRegistry();
  },
} satisfies ServerPluginDefinition;
```

### `server/src/contributions.ts` — stamp hierarchy path

```ts
export type ServerContribution = {
  readonly _kind: symbol;
  _pluginId?: string;
  _pluginName?: string;
  _pluginDescription?: string;
  _hierarchyPath?: string;        // NEW
  [key: string]: unknown;
};

// In collectContributions():
c._hierarchyPath = (p as any)._hierarchyPath;
```

### `server/src/types.ts` — add field

```ts
export interface ServerPluginDefinition {
  // ... existing fields ...
  _hierarchyPath?: string;   // Auto-set by codegen
}
```

### `tooling/src/plugin-registry-gen.ts` — emit hierarchy paths

In the generated file, after `dependsOn` assignments, emit:
```ts
(buildPlugin as ServerPluginDefinition)._hierarchyPath = "build";
```

Derived from `node.hierarchyId.replaceAll('.', '/')` (hierarchyId uses dots; config paths use slashes).

## Collection ID Injection (forward-looking)

In `setConfig`, before writing, call `injectCollectionIds(doc, fields)`. For now it's a no-op loop. When `listField` is added, this function will:
- Check each field's `type.id === "list"`
- For array values, assign `id: crypto.randomUUID()` to items missing an `id` property
- Preserve existing IDs (stable identity across edits)

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Contributions (not `register` array) | Matches v1 pattern; framework auto-stamps `_pluginId` and now `_hierarchyPath` |
| Path auto-derived from hierarchy | No manual path strings; convention over configuration |
| `getConfig(descriptor)` function (not handle) | Simpler API; descriptor is the lookup key; no object to pass around |
| Sync reads | In-memory cache populated eagerly during onReady; file watcher keeps it fresh |
| Cache updates only via watch callback | Single source of truth; no divergence on concurrent writes |
| Throw on premature `getConfig` | Loud failure beats silent wrong defaults |
| `name` defaults to `"config"` | Most plugins have one config block; explicit name only needed for multiple |

## Verification

1. Create the files, run `./equin build` — generated plugins file picks up new server barrel and emits `_hierarchyPath` stamps.
2. Add a `ConfigV2.Register(buildConfig)` contribution to an existing plugin's server barrel.
3. Call `getConfig(buildConfig)` from an HTTP handler → returns default values (no file on disk yet).
4. Call `setConfig(buildConfig, "autoBuild", false)` → `.jsonc` file appears at the expected hierarchy path.
5. Edit the file externally → `getConfig` returns updated value after debounce.
6. `./equin check` passes (plugin boundaries, eslint, migrations).
