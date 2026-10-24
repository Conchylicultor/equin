# Config nav badge: aggregate base + all app-scope conflicts

## Context

The config_v2 settings left-nav row badge (`useConfigRowState` → `ConfigRowBadge`)
only reflects **base-scope** conflicts. A descriptor with a stale override in an
**app scope** (`config/<hier>/@app/<id>/`) shows no warning anywhere in the nav —
the conflict is only discoverable by opening that descriptor and selecting the
app's tab in the detail pane (the detail-pane surfacing already shipped via the
scope-tabs work). This is the deferred follow-up from the per-app config settings
surface.

The same base-only blind spot exists two levels up the discoverability chain: the
**rail-icon attention dot** (`ConfigConflictDot`) and the **Settings sidebar
"Config" entry dot** (`ConfigSidebarButton`) both read the base conflicts map. A
scoped-only conflict therefore lights *nothing* — the user never knows to open
Settings → Config in the first place. Per the scope decision, all three surfaces
should aggregate base + all app scopes so a scoped conflict is discoverable
without opening each descriptor.

## Design

The scope list per descriptor is dynamic, so the client cannot loop
`useConflicts(scopeId)` over it (rules of hooks), and N×M per-row websocket
subscriptions would be wasteful. Instead, compute the aggregate **server-side**
as one push resource and have all three surfaces read it.

Add a new resource `config-v2.conflict-paths` keyed by `{}` returning a
`string[]` of every `storePath` that has a conflict (`hash` or `invalid`) in the
base scope **or any app scope**. This reuses the existing per-scope
`computeAllConflicts(scopeId)` machinery verbatim — no new conflict logic.

- Nav row badge: `data.includes(storePath)` → warning.
- Rail dot / sidebar dot: `data.length > 0` → attention dot.

The `modifiedCount` badge stays base-only — the task targets the **warning**
badge only.

## Changes

### 1. Core — declare the resource

`plugins/config_v2/core/internal/resource.ts` (after `configV2ScopesResource`,
mirroring its `z.array(z.string())` shape):

```ts
// storePaths with a conflict in the base scope OR any app scope. Keyed by `{}`
// (whole list). Powers the nav-row warning badge and the rail/sidebar attention
// dots so a scoped-only conflict is discoverable without opening each descriptor.
export const configV2ConflictPathsSchema = z.array(z.string());
export type ConfigV2ConflictPaths = z.infer<typeof configV2ConflictPathsSchema>;

export const configV2ConflictPathsResource = resourceDescriptor<ConfigV2ConflictPaths, {}>(
  "config-v2.conflict-paths",
  configV2ConflictPathsSchema,
  [],
);
```

Export `configV2ConflictPathsSchema`, `ConfigV2ConflictPaths`,
`configV2ConflictPathsResource` from `plugins/config_v2/core/index.ts`.

### 2. Server — loader

`plugins/config_v2/server/internal/resource.ts`. `computeAllConflicts` and
`discoverScopeIds` already exist and are imported here:

```ts
// Union of conflicting storePaths across base + every app scope. Reuses
// computeAllConflicts per scope (which returns only descriptors actually
// customized for that scope, since an un-customized scope has no @app/<id> files).
function computeConflictPaths(): ConfigV2ConflictPaths {
  const paths = new Set<string>(Object.keys(computeAllConflicts()));
  const scopeIds = new Set<string>();
  for (const [, descriptor] of descriptorByPath) {
    const hierarchyPath = hierarchyByDescriptor.get(descriptor);
    if (hierarchyPath) for (const sid of discoverScopeIds(hierarchyPath)) scopeIds.add(sid);
  }
  for (const sid of scopeIds) {
    for (const sp of Object.keys(computeAllConflicts(sid))) paths.add(sp);
  }
  return [...paths];
}

export const configV2ConflictPathsServerResource = defineResource<ConfigV2ConflictPaths, {}>({
  key: "config-v2.conflict-paths",
  mode: "push",
  schema: configV2ConflictPathsSchema,
  loader: whenRegistryReady(() => computeConflictPaths()),
});
```

Import `configV2ConflictPathsSchema` / `ConfigV2ConflictPaths` from `../../core`.

### 3. Server — register + notify

- `plugins/config_v2/server/index.ts`: add
  `Resource.Declare(configV2ConflictPathsServerResource)` to `contributions` and
  the import.
- `plugins/config_v2/server/internal/registry.ts`: `notifyConflicts` is the
  single fan-out point for conflict changes (called from the file-watcher's
  `onFileChange` and `notifyDescriptorScopeChange`, covering base edits, scoped
  edits, and scope add/remove). Add one aggregate notify at its top so every
  conflict change refreshes the list:

  ```ts
  function notifyConflicts(storePath: string, scopeId: string): void {
    configV2ConflictPathsServerResource.notify({});
    if (scopeId) { /* unchanged */ }
    /* unchanged base branch */
  }
  ```

  Add `configV2ConflictPathsServerResource` to the existing
  `./resource` import on line 20.

### 4. Web — shared hook

`plugins/config_v2/plugins/settings/web/internal/use-conflicts.ts` — add:

```ts
import { configV2ConflictPathsResource } from "@plugins/config_v2/core";
import type { ConfigV2ConflictPaths } from "@plugins/config_v2/core";

export function useConflictPaths(): ResourceResult<ConfigV2ConflictPaths> {
  return useResource(configV2ConflictPathsResource, {});
}
```

### 5. Web — three consumers

- **`use-config-row-state.ts`**: replace `useConflicts()` with `useConflictPaths()`:
  ```ts
  const conflictPathsRes = useConflictPaths();
  const hasConflict = !conflictPathsRes.pending && conflictPathsRes.data.includes(registration.storePath);
  ```
  Keep `useConfig`/`modifiedCount` as-is; drop the now-unused `useConflicts` import.

- **`config-sidebar-button.tsx`**:
  ```ts
  const conflicts = useConflictPaths();
  const hasConflicts = !conflicts.pending && conflicts.data.length > 0;
  ```

- **`config-conflict-dot.tsx`** (`plugins/apps/plugins/settings/plugins/config/web/components/`):
  ```ts
  import { configV2ConflictPathsResource } from "@plugins/config_v2/core";
  const result = useResource(configV2ConflictPathsResource);
  const hasConflicts = !result.pending && result.data.length > 0;
  ```

`ConfigRowBadge` itself is unchanged — still warning icon when `hasConflict`.

## Critical files

- `plugins/config_v2/core/internal/resource.ts` + `core/index.ts` — declare/export resource
- `plugins/config_v2/server/internal/resource.ts` — loader `computeConflictPaths`
- `plugins/config_v2/server/internal/registry.ts` — aggregate notify in `notifyConflicts`
- `plugins/config_v2/server/index.ts` — `Resource.Declare`
- `plugins/config_v2/plugins/settings/web/internal/use-conflicts.ts` — `useConflictPaths`
- `plugins/config_v2/plugins/settings/web/internal/use-config-row-state.ts` — nav badge
- `plugins/config_v2/plugins/settings/web/components/config-sidebar-button.tsx`
- `plugins/apps/plugins/settings/plugins/config/web/components/config-conflict-dot.tsx`

## Verification

1. `./equin build`.
2. Pick a descriptor that is git-scoped for an app (`config/<hier>/@app/<id>/<name>.jsonc`).
   Create a scoped conflict: bump the **base** origin's `// @hash` (e.g. change a
   base default and rebuild, or hand-edit the scoped override's `// @hash` to a
   stale value) so `computeAllConflicts("app:<id>")` reports it but the base scope
   is clean. Use the MCP `query_db` only for inspection if needed — conflicts live
   on disk under `~/.singularity/config/`, not the DB.
3. In Settings → Config, confirm **without** opening the descriptor:
   - the nav row shows the amber warning icon,
   - the rail Settings icon shows the attention dot,
   - the sidebar "Config" entry shows its dot.
4. Open the descriptor, select the app tab — the existing per-scope conflict dot
   still shows (unchanged). Resolve the scoped conflict (Keep/Accept/Merge) and
   confirm all three nav/rail/sidebar indicators clear live (push update, no reload).
5. Regression: a **base-only** conflict still lights all three exactly as before.
6. `./equin check` (boundaries, type-check, origins-in-sync) passes.
