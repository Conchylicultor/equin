# Config v2: Reactivity (file watcher → useConfig hook)

## Context

Config v2 stores values as JSONC files on disk (`~/.singularity/config/`). The server side already has a `@parcel/watcher` feeding an in-memory cache via `JsoncConfigStore.watch()`, and `watchConfig(descriptor, cb)` notifies server-side subscribers. But this reactivity stops at the server boundary — there's no way for the browser to observe config changes live.

This change bridges the gap by:
1. Wiring the existing file-watcher→cache pipeline into the live-state resource system (server side)
2. Extending the web framework to support `_hierarchyPath` (mirroring what the server already does)
3. Exposing a single-arg `useConfig(descriptor)` hook backed by TanStack Query + WS notifications

After this, config changes from any source (UI, text editor, agent editing JSONC) propagate end-to-end in real time.

## Design

### Resource model

One parametric resource `"config-v2.values"` with params `{ path: string }` where `path` is the store-relative path (e.g. `"build/config.jsonc"`). Each distinct path gets its own WS subscription and TanStack Query cache entry — only subscribers of a specific config file re-render when it changes.

Mode: **push** — config values are small (< 1KB typically) and the server already has them in memory.

### Consumer API

```ts
import { useConfig } from "@plugins/config_v2/web";
import { buildConfig } from "../shared/config";

const { autoBuild } = useConfig(buildConfig);
```

Single argument. The hook discovers the descriptor's store path from the web-side contribution registry (which carries `_hierarchyPath` auto-injected by the framework).

### Framework extension: `_hierarchyPath` on web

The server codegen already stamps `_hierarchyPath` on every `ServerPluginDefinition`. We mirror this for web:

1. Codegen adds `hierarchyPath` to the `PluginEntry` metadata
2. `loadPlugins` stamps `_hierarchyPath` on the loaded `PluginDefinition`
3. `PluginProvider` copies `_hierarchyPath` to each contribution (same as it does `_pluginId`)

This is ~5 lines across 4 files in the framework layer.

### Config_v2 web registration

Each plugin that wants web-side reactivity adds a web contribution (mirroring the server-side `ConfigV2.Register` pattern):

```ts
// plugins/build/web/index.ts
import { ConfigV2 } from "@plugins/config_v2/web";
import { buildConfig } from "../shared/config";

export default {
  contributions: [ConfigV2.WebRegister({ descriptor: buildConfig })],
} satisfies PluginDefinition;
```

The `useConfig` hook accesses `PluginRuntimeContext` to look up the contribution matching the descriptor (by reference equality), reads `_hierarchyPath`, and derives the store path.

## Implementation

### Part 1: Framework — `_hierarchyPath` on web plugins

#### `plugins/framework/plugins/web-sdk/core/types.ts`

Add to `PluginDefinition`:
```ts
_hierarchyPath?: string;
```

Add to `Contribution`:
```ts
_hierarchyPath?: string;
```

#### `plugins/framework/plugins/web-sdk/core/loader.ts`

Add `hierarchyPath` to `PluginEntry`:
```ts
export interface PluginEntry {
  name: string;
  hierarchyPath?: string;
  loader: () => Promise<{ default: PluginDefinition }>;
}
```

In `loadPlugins`, stamp it on loaded plugins:
```ts
if (result.status === "fulfilled") {
  const plugin = result.value.default;
  if (entry.hierarchyPath) plugin._hierarchyPath = entry.hierarchyPath;
  plugins.push(plugin);
}
```

#### `plugins/framework/plugins/web-sdk/core/context.tsx`

Extend the contribution spread in `PluginProvider`:
```ts
(p.contributions ?? []).map((c) => ({
  ...c,
  _pluginId: p.id,
  _pluginName: p.name,
  _pluginDescription: p.description,
  _hierarchyPath: p._hierarchyPath,  // ← NEW
})),
```

#### `tooling/src/plugin-registry-gen.ts`

In the web branch (line ~196), include `hierarchyPath` in the entry output:
```ts
lines.push(`  { name: ${JSON.stringify(name)}, hierarchyPath: ${JSON.stringify(e.hierarchyPath)}, loader: () => import(${JSON.stringify(e.importPath)}) },`);
```

---

### Part 2: Config_v2 — server resource

#### `plugins/config_v2/core/internal/resource.ts` — CREATE

```ts
import { z } from "zod";
import { resourceDescriptor } from "@plugins/primitives/plugins/live-state/core";

export const configV2ValuesSchema = z.record(z.unknown());
export type ConfigV2Values = z.infer<typeof configV2ValuesSchema>;

export const configV2Resource = resourceDescriptor<ConfigV2Values, { path: string }>(
  "config-v2.values",
  configV2ValuesSchema,
  {},
);
```

#### `plugins/config_v2/core/index.ts` — MODIFY

Add:
```ts
export { configV2Resource, configV2ValuesSchema } from "./internal/resource";
export type { ConfigV2Values } from "./internal/resource";
```

#### `plugins/config_v2/server/internal/resource.ts` — CREATE

```ts
import { defineResource } from "@server/resources";
import { configV2ValuesSchema } from "../../core";
import type { ConfigV2Values } from "../../core";
import type { ConfigDescriptor, ConfigValues, FieldsRecord } from "../../core";

type ConfigGetter = <F extends FieldsRecord>(d: ConfigDescriptor<F>) => ConfigValues<F>;

const descriptorByPath = new Map<string, ConfigDescriptor>();
let configGetter: ConfigGetter | null = null;

export const configV2ServerResource = defineResource<ConfigV2Values, { path: string }>({
  key: "config-v2.values",
  mode: "push",
  schema: configV2ValuesSchema,
  loader: ({ path }) => {
    const descriptor = descriptorByPath.get(path);
    if (!descriptor || !configGetter) return {};
    return configGetter(descriptor) as ConfigV2Values;
  },
});

export function registerDescriptorPath(path: string, descriptor: ConfigDescriptor): void {
  descriptorByPath.set(path, descriptor);
}

export function setConfigGetter(getter: ConfigGetter): void {
  configGetter = getter;
}
```

#### `plugins/config_v2/server/internal/registry.ts` — MODIFY

Add imports at top:
```ts
import { configV2ServerResource, registerDescriptorPath, setConfigGetter } from "./resource";
```

In `initRegistry()`, before the loop:
```ts
setConfigGetter(getConfig);
```

After computing `storePath` (line 66):
```ts
registerDescriptorPath(storePath, descriptor);
```

In the watch callback (line 76–94), after updating cache and calling subscribers, but NOT on firstFire:
```ts
if (!firstFire) {
  configV2ServerResource.notify({ path: storePath });
}
```

(firstFire skips notify because the resource system calls the loader on initial sub-ack.)

#### `plugins/config_v2/server/index.ts` — MODIFY

```ts
import { Resource } from "@server/resources";
import { configV2ServerResource } from "./internal/resource";

// Add to default export:
contributions: [Resource.Declare(configV2ServerResource)],
```

---

### Part 3: Config_v2 — web barrel + useConfig

#### `plugins/config_v2/web/internal/slots.ts` — CREATE

```ts
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { ConfigDescriptor } from "../../core";

export const ConfigV2 = {
  WebRegister: defineSlot<{ descriptor: ConfigDescriptor }>("config-v2.web-register"),
};
```

#### `plugins/config_v2/web/internal/use-config.ts` — CREATE

```ts
import { useContext } from "react";
import { PluginRuntimeContext } from "@plugins/framework/plugins/web-sdk/core";
import { useResource } from "@plugins/primitives/plugins/live-state/web";
import { configV2Resource } from "@plugins/config_v2/core";
import type { ConfigDescriptor, ConfigValues, FieldsRecord } from "@plugins/config_v2/core";

export function useConfig<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
): ConfigValues<F> {
  const ctx = useContext(PluginRuntimeContext);
  if (!ctx) throw new Error("useConfig must be inside PluginProvider");

  const registrations = ctx.bySlot.get("config-v2.web-register") ?? [];
  const reg = registrations.find((c) => c.descriptor === descriptor);
  if (!reg?._hierarchyPath) {
    throw new Error(
      `[config-v2] useConfig: descriptor "${descriptor.name}" has no web registration. ` +
      `Add ConfigV2.WebRegister({ descriptor }) to your plugin's contributions.`,
    );
  }

  const path = `${reg._hierarchyPath}/${descriptor.name}.jsonc`;
  const { data } = useResource(configV2Resource, { path });
  return data as ConfigValues<F>;
}
```

#### `plugins/config_v2/web/index.ts` — CREATE

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useConfig } from "./internal/use-config";
export { ConfigV2 } from "./internal/slots";

export default {
  id: "config-v2",
  name: "Config v2",
  description: "Typed JSONC config handles for server plugins.",
  contributions: [],
} satisfies PluginDefinition;
```

---

## File Summary

| File | Action | Purpose |
|---|---|---|
| `plugins/framework/plugins/web-sdk/core/types.ts` | Modify | Add `_hierarchyPath` to `PluginDefinition` + `Contribution` |
| `plugins/framework/plugins/web-sdk/core/loader.ts` | Modify | Add `hierarchyPath` to `PluginEntry`, stamp on load |
| `plugins/framework/plugins/web-sdk/core/context.tsx` | Modify | Pass `_hierarchyPath` through to contributions |
| `tooling/src/plugin-registry-gen.ts` | Modify | Emit `hierarchyPath` in web plugin entries |
| `plugins/config_v2/core/internal/resource.ts` | Create | Shared `ResourceDescriptor` |
| `plugins/config_v2/core/index.ts` | Modify | Re-export resource |
| `plugins/config_v2/server/internal/resource.ts` | Create | `defineResource` + loader |
| `plugins/config_v2/server/internal/registry.ts` | Modify | Wire `notify`, `registerDescriptorPath`, `setConfigGetter` |
| `plugins/config_v2/server/index.ts` | Modify | Add `Resource.Declare` contribution |
| `plugins/config_v2/web/internal/slots.ts` | Create | `ConfigV2.WebRegister` slot |
| `plugins/config_v2/web/internal/use-config.ts` | Create | `useConfig(descriptor)` hook |
| `plugins/config_v2/web/index.ts` | Create | Web barrel |

---

## Verification

1. `./equin build` — regenerates plugin registries (confirm `_hierarchyPath` appears in `web/src/plugins.generated.ts`), applies migrations, deploys
2. Check resource debug: `curl http://<worktree>.localhost:9000/api/resources/_debug | jq '.resources[] | select(.key == "config-v2.values")'`
3. Edit a JSONC file under `~/.singularity/config/` and confirm the browser reflects the change without refresh
4. `./equin check` passes (plugin boundaries, eslint, migrations-in-sync)
