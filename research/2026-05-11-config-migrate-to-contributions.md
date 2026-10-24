# Config migration to server contributions

## Context

`ServerPluginDefinition` has a `config?: ConfigDescriptorLike` field that the config plugin reads by iterating the full plugin list in `onReady`. A `WeakMap<ConfigDescriptor, string>` maps descriptor object identity to pluginId — a hack required because the framework has no metadata injection for direct fields.

The server-side contributions primitive (`defineServerContribution` / `collectContributions` in `server/src/contributions.ts`) was added recently but has zero consumers. It mirrors the web slot/contribution pattern and auto-injects `_pluginId` / `_pluginName` on each contribution. Config is the natural first consumer: it removes a plugin-specific field from core, eliminates the WeakMap hack, and validates that contributions work for real use cases.

## Design

### New contribution token

```ts
// plugins/config/server/internal/contribution.ts
import { defineServerContribution } from "@server/contributions";
import type { ConfigDescriptor } from "@plugins/config/shared";

export const Config = {
  Field: defineServerContribution<ConfigDescriptor>("config.field"),
};
```

Consumer plugins change from `config: myConfig` to `contributions: [Config.Field(myConfig)]`, importing `Config` from `@plugins/config/server`.

### WeakMap rekey: descriptor → schema

The spread in `defineServerContribution` (`{ _kind, ...props }`) loses the outer descriptor reference but preserves `descriptor.schema` by reference (shallow copy). Since `readConfig(descriptor)` needs to map back to a pluginId, the WeakMap is rekeyed from `descriptor` to `descriptor.schema`:

```ts
// Before
const descriptorToPluginId = new WeakMap<ConfigDescriptor, string>();
descriptorToPluginId.set(descriptor, p.id);
pluginIdOf(d) → descriptorToPluginId.get(d)

// After
const schemaToPluginId = new WeakMap<Schema, string>();
schemaToPluginId.set(c.schema, c._pluginId!);
pluginIdOf(d) → schemaToPluginId.get(d.schema)
```

This works because every `defineConfig({...})` creates a unique schema object at module scope — reference equality is stable for the process lifetime.

### `_pluginDescription` on contributions

`collectContributions` currently stamps `_pluginId` and `_pluginName`. The config registry also needs `pluginDescription` (for `GET /api/config/specs`). Extend `collectContributions` to stamp `_pluginDescription` — matches the web `PluginProvider` pattern.

## Files to modify

### `server/src/contributions.ts`

- Add `_pluginDescription?: string` to `ServerContribution`
- Widen `collectContributions` param: add `description?: string`
- Stamp `c._pluginDescription = p.description` in the loop
- Update `getContributions()` return type to include `_pluginDescription`

### `server/src/types.ts`

- Remove `ConfigDescriptorLike` type (only used here)
- Remove `config?: ConfigDescriptorLike` from `ServerPluginDefinition`

### Create `plugins/config/server/internal/contribution.ts`

The token lives in its own file to avoid a circular import (`index.ts` → `registry.ts` → `index.ts`). Both `index.ts` (re-export) and `registry.ts` (getContributions) import from here.

```ts
import { defineServerContribution } from "@server/contributions";
import type { ConfigDescriptor } from "@plugins/config/shared";

export const Config = {
  Field: defineServerContribution<ConfigDescriptor>("config.field"),
};
```

### `plugins/config/server/index.ts`

- Add `export { Config } from "./internal/contribution"`
- Remove `import { plugins as allPlugins } from "@server/plugins"`
- Change `buildRegistry(allPlugins)` → `buildRegistry()`

### `plugins/config/server/internal/registry.ts`

- Import `Config` from `./contribution`
- Change `buildRegistry()` to take no args; call `Config.Field.getContributions()`
- Rekey WeakMap: `WeakMap<Schema, string>` keyed on `c.schema`, lookup via `descriptor.schema`
- Use `c._pluginDescription` for `RegisteredPlugin.pluginDescription`

### `plugins/config/server/internal/read-config.ts`

- Update error message from "sets `config: <descriptor>`" to "contributes `Config.Field(descriptor)`"
- No API change — `readConfig(descriptor)` signature is unchanged

### `plugins/config/CLAUDE.md`

- Update server registration from `config: myConfig` to `contributions: [Config.Field(myConfig)]`

### 13 consumer plugins (mechanical)

Each: replace `config: X` with `contributions: [Config.Field(X)]`, add `import { Config } from "@plugins/config/server"`.

| # | Plugin server barrel | Config import |
|---|---|---|
| 1 | `plugins/build/server/index.ts` | `buildConfig` |
| 2 | `plugins/ui/plugins/segmented-progress-bar/server/index.ts` | `segmentedProgressBarConfig` |
| 3 | `plugins/ui/plugins/tokens/plugins/color-palette/server/index.ts` | `colorPaletteConfig` |
| 4 | `plugins/ui/plugins/tokens/plugins/shape/server/index.ts` | `shapeConfig` |
| 5 | `plugins/ui/plugins/tokens/plugins/sidebar-palette/server/index.ts` | `sidebarPaletteConfig` |
| 6 | `plugins/ui/plugins/theme-engine/server/index.ts` | `themeEngineConfig` |
| 7 | `plugins/stats/plugins/cost/server/index.ts` | `costConfig` |
| 8 | `plugins/stats/plugins/commits/server/index.ts` | `commitsConfig` |
| 9 | `plugins/auth/plugins/notion/server/index.ts` | `notionAuthConfig` |
| 10 | `plugins/auth/plugins/google/server/index.ts` | `googleAuthConfig` |
| 11 | `plugins/conversations/plugins/conversation-category/server/index.ts` | `conversationCategoryConfig` |
| 12 | `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/server/index.ts` | `reviewConfig` |
| 13 | `plugins/conversations/plugins/conversation-view/plugins/turn-summary/server/index.ts` | `turnSummaryConfig` |

Example (stub plugin):
```ts
// Before
export default {
  id: "auth-google", name: "Auth: Google",
  config: googleAuthConfig,
} satisfies ServerPluginDefinition;

// After
import { Config } from "@plugins/config/server";
export default {
  id: "auth-google", name: "Auth: Google",
  contributions: [Config.Field(googleAuthConfig)],
} satisfies ServerPluginDefinition;
```

Example (plugin with `register`):
```ts
// Before
export default {
  id: "build", name: "Build",
  config: buildConfig,
  register: [buildRunJob],
  ...
} satisfies ServerPluginDefinition;

// After
import { Config } from "@plugins/config/server";
export default {
  id: "build", name: "Build",
  contributions: [Config.Field(buildConfig)],
  register: [buildRunJob],
  ...
} satisfies ServerPluginDefinition;
```

## Ordering constraints

1. `collectContributions(ordered)` runs between register and onReady (line 32 of `server/src/index.ts`) — already correct
2. Config plugin's `onReady` calls `buildRegistry()` which calls `Config.Field.getContributions()` — contributions are populated by then
3. Remove `config` field from `ServerPluginDefinition` only after all 13 consumers are migrated

## Verification

1. `./equin build` — compiles and starts
2. Open Settings pane — all 13 plugin groups render with correct names, descriptions, and fields
3. Toggle a boolean config (e.g. auto-build) — verify PATCH works and value persists
4. Set/clear a secret field — verify routing through secrets store
5. Check `GET /api/config/specs` returns all plugins with `pluginDescription` populated
