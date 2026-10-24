# Config v2 — Settings UI

## Context

config_v2 is a JSONC-file-backed config system replacing the DB-backed config v1. Core infrastructure is complete: `defineConfig`, three-tier storage (code → git → user), `useConfig` hook, `FieldRenderer`, `ConfigWatcher`. Only one consumer exists (build plugin, server-side only). The end-to-end loop is broken because there is no UI surface for users to view or edit config values. This plan adds a two-pane settings surface (nav + detail) to close that loop.

## End-user experience

1. Click **Config** in the sidebar (tuning icon)
2. Nav pane appears with a searchable list of plugins that have config
3. Click a plugin → detail pane shows its config fields with auto-rendered controls
4. Toggle a bool, edit text, change a number → value auto-saves to JSONC file on disk
5. Modified fields show a blue left-border; a reset button appears on hover
6. The nav pane shows a modified-count badge per plugin

## Design

### Two-pane layout

Following the forge/publish → plugin-view pattern:

- **Nav pane** (`config-v2-nav`): root-only, `width: 300`, pinned `SearchInput` + flat list of plugin rows
- **Detail pane** (`config-v2-detail`): after nav pane, `segment: "cd/:configPath"`, renders fields for the selected config

Selection tracking uses `configDetailPane.useChainEntry()?.params.configPath` (same pattern as publish tree).

### Plugin structure

New sub-plugin at `plugins/config_v2/plugins/settings/`:

```
plugins/config_v2/plugins/settings/
  package.json
  core/
    index.ts                       — re-export endpoint contracts
    internal/
      endpoints.ts                 — setConfigField, resetConfigField
  web/
    index.ts                       — plugin def, pane registrations, sidebar entry
    internal/
      panes.ts                     — configNavPane + configDetailPane definitions
    components/
      config-nav.tsx               — nav pane body
      config-nav-row.tsx           — single config row with modified badge
      config-detail.tsx            — detail pane body
      config-field-row.tsx         — single field with modified indicator + reset
  server/
    index.ts                       — plugin def with httpRoutes
    internal/
      handlers.ts                  — implement(setConfigField), implement(resetConfigField)
```

### Existing files to modify

- `plugins/config_v2/server/internal/resource.ts` — export `getDescriptorByStorePath()` getter
- `plugins/config_v2/server/internal/registry.ts` — add `setConfigByPath()`, `resetConfigByPath()`
- `plugins/config_v2/server/index.ts` — export the two new functions
- `plugins/config_v2/web/internal/use-config-registrations.ts` — new hook to enumerate all WebRegister contributions with plugin metadata (mirrors config v1's `useSpecsWithPlugin`)
- `plugins/config_v2/web/index.ts` — export `useConfigRegistrations`
- `plugins/build/web/index.ts` — add `ConfigV2.WebRegister({ descriptor: buildConfig })` so there's one visible config

## Implementation

### 1. Server: expose `setConfig` via HTTP

**Endpoint contracts** (`core/internal/endpoints.ts`):

```ts
export const setConfigField = defineEndpoint({
  route: "POST /api/config-v2/set-field",
  body: z.object({ storePath: z.string(), key: z.string(), value: z.unknown() }),
});

export const resetConfigField = defineEndpoint({
  route: "POST /api/config-v2/reset-field",
  body: z.object({ storePath: z.string(), key: z.string() }),
});
```

No `response` schema — server returns 204 (void). The client doesn't need the response; it waits for the push-resource notification to re-render.

**Server wiring** — add to `resource.ts`:

```ts
export function getDescriptorByStorePath(path: string): ConfigDescriptor | undefined {
  return descriptorByPath.get(path);
}
```

Add to `registry.ts`:

```ts
export function setConfigByPath(storePath: string, key: string, value: unknown): void {
  const descriptor = getDescriptorByStorePath(storePath);
  if (!descriptor) throw new Error(`No descriptor for "${storePath}"`);
  setConfig(descriptor, key as keyof typeof descriptor.fields & string, value as never);
}

export function resetConfigByPath(storePath: string, key: string): void {
  const descriptor = getDescriptorByStorePath(storePath);
  if (!descriptor) throw new Error(`No descriptor for "${storePath}"`);
  const defaultValue = descriptor.defaults[key];
  if (defaultValue === undefined) throw new Error(`No field "${key}" in "${descriptor.name}"`);
  setConfig(descriptor, key as keyof typeof descriptor.fields & string, defaultValue as never);
}
```

**Handlers** (`server/internal/handlers.ts`) — wrap with `implement()`, catch errors as `HttpError(400)`.

**Server plugin index** — wire `httpRoutes: { [setConfigField.route]: handleSet, [resetConfigField.route]: handleReset }`.

### 2. Web: `useConfigRegistrations()` hook

New file `plugins/config_v2/web/internal/use-config-registrations.ts`, mirroring config v1's `useSpecsWithPlugin()`:

```ts
export interface ConfigRegistration {
  descriptor: ConfigDescriptor;
  pluginId: string;
  pluginName: string;
  hierarchyPath: string;
  storePath: string;
}

export function useConfigRegistrations(): ConfigRegistration[] {
  const ctx = useContext(PluginRuntimeContext);
  const raw = ctx.bySlot.get("config-v2.web-register") ?? [];
  return raw.map(c => ({
    descriptor: c.descriptor as ConfigDescriptor,
    pluginId: c._pluginId,
    pluginName: c._pluginName,
    hierarchyPath: c._hierarchyPath,
    storePath: `${c._hierarchyPath}/${(c.descriptor as ConfigDescriptor).name}.jsonc`,
  })).filter(v => v.pluginId && v.pluginName && v.hierarchyPath);
}
```

Export from `plugins/config_v2/web/index.ts`.

### 3. Pane definitions

```ts
export const configNavPane = Pane.define({
  id: "config-v2-nav",
  after: [null],
  segment: "config",
  component: ConfigNavBody,
  chrome: false,
  width: 300,
});

export const configDetailPane = Pane.define({
  id: "config-v2-detail",
  after: [configNavPane],
  segment: "cd/:configPath",
  component: ConfigDetailBody,
  width: 500,
});
```

### 4. Nav pane (`config-nav.tsx`)

- Uses `useConfigRegistrations()` to list all registered configs
- `SearchInput` at top filters by plugin name and field labels
- Each `ConfigNavRow` calls `useConfig(registration.descriptor)` to get live values and compute `modifiedCount` by comparing against `descriptor.defaults`
- Selected state from `configDetailPane.useChainEntry()?.params.configPath`
- On click: `openPane(configDetailPane, { configPath: encodeURIComponent(storePath) }, { mode: "push" })`

### 5. Detail pane (`config-detail.tsx`)

- Decodes `configPath` param → finds matching registration from `useConfigRegistrations()`
- Uses `useConfig(registration.descriptor)` for live values
- Iterates `Object.entries(descriptor.fields)` → renders `<ConfigFieldRow>` for each

### 6. Field row (`config-field-row.tsx`)

Each row:
- Left: 2px border — blue when modified (`value !== defaultValue`), transparent otherwise
- Center: `<FieldRenderer field={field} value={value} onChange={handleChange} />`
- Right: reset button (undo icon), visible on hover only when modified

`onChange` calls `void fetchEndpoint(setConfigField, {}, { body: { storePath, key, value } })` — fire-and-forget because the push resource handles freshness (same pattern as DnD rank writes). Using `void fetchEndpoint` here because:
1. Failure is visible (field snaps back to server value via push resource)
2. State refreshes via the push channel, not manual invalidation

`onReset` calls `void fetchEndpoint(resetConfigField, {}, { body: { storePath, key } })` — same reasoning.

### 7. Sidebar entry + plugin registration

Web plugin `contributions`:
```ts
Pane.Register({ pane: configNavPane }),
Pane.Register({ pane: configDetailPane }),
Shell.Sidebar({
  id: "config-v2",
  ...sidebarNavItem({ title: "Config", icon: MdTune, onClick: () => openPane(configNavPane, {}, { mode: "root" }) }),
}),
```

### 8. Build plugin WebRegister

Add to `plugins/build/web/index.ts`:
```ts
ConfigV2.WebRegister({ descriptor: buildConfig }),
```

## Data flow

```
User toggles "Auto-build on push" off
  → ConfigFieldRow.onChange(false)
  → void fetchEndpoint(setConfigField, {}, { body: { storePath: "build/config.jsonc", key: "autoBuild", value: false } })
  → POST /api/config-v2/set-field → setConfigByPath → setConfig(buildConfig, "autoBuild", false)
  → writes ~/.singularity/config/build/config.jsonc
  → ConfigWatcher fires → configV2ServerResource.notify({ path: "build/config.jsonc" })
  → useConfig(buildConfig) re-renders with { autoBuild: false }
  → isModified = true → blue border + nav badge
```

## Out of scope

- Tier badges (default/git/user per-field) — requires new server resource
- "Show only modified" filter toggle
- Tree hierarchy grouping in nav — flat list sufficient for now
- Full config reset (delete entire override file)
- Conflict detection UI (console.warn exists; toast is a follow-up)

## Verification

1. `./equin build` succeeds
2. Open app, click Config sidebar → nav pane shows "Build" with 0 modified
3. Click "Build" → detail pane shows "Auto-build on push" toggle (checked)
4. Toggle off → blue left-border appears on field; "1" badge on nav row
5. Check `~/.singularity/config/build/config.jsonc` → `"autoBuild": false`
6. Click reset ↩ → toggle returns on; border and badge disappear
7. Navigate away and back → state persists
