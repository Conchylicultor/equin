# Extract plugin detail view into a reusable pane under plugin-meta umbrella

## Context

The `plugins/publish/` plugin has a master-detail layout: a filterable plugin tree (left) and a plugin detail panel (right). The detail panel — showing breadcrumb, description, runtimes, sub-plugins, source path — is useful beyond the publish context. Other surfaces (conversation toolbar showing modified plugins, welcome page, task detail) should be able to open a single-plugin detail view.

Both the publish tree and the plugin detail view are "plugins about the plugin system itself." They belong under a shared umbrella to make this clear and avoid confusion with feature plugins.

## Plan

### New umbrella: `plugins/plugin-meta/`

Contains plugins about the plugin system itself — browsing, inspecting, and publishing plugins.

```
plugins/plugin-meta/
  package.json
  CLAUDE.md
  web/
    index.ts                          # umbrella PluginDefinition (no contributions)
  plugins/
    plugin-view/                      # NEW — single-plugin detail pane
      package.json
      CLAUDE.md
      shared/
        types.ts                      # PluginNode + PluginTreePayload
      server/
        index.ts                      # GET /api/plugin-view/tree
        internal/
          tree-handler.ts
      web/
        index.ts                      # exports pluginViewPane
        panes.tsx
        components/
          plugin-detail.tsx
    publish/                          # MOVED from plugins/publish/
      package.json
      CLAUDE.md
      web/
        index.ts                      # sidebar entry + tree pane
        panes.tsx
        components/
          publish-view.tsx            # tree-only (no detail panel)
          plugin-tree.tsx
```

### 1. Create `plugins/plugin-meta/` umbrella

Minimal umbrella with no contributions of its own.

**`web/index.ts`:**
```ts
import type { PluginDefinition } from "@core";

export default {
  id: "plugin-meta",
  name: "Plugin Meta",
  description: "Plugins about the plugin system itself — browsing, inspecting, and publishing.",
  contributions: [],
} satisfies PluginDefinition;
```

### 2. Create `plugins/plugin-meta/plugins/plugin-view/`

Owns the single-plugin detail pane, the shared types, and the tree data endpoint.

**Pane definition:** `after: [null, "publish"]` — can appear standalone (`/plugin-view/:pluginId`) or as the next Miller column after the publish tree (`/publish/:pluginId`). String `"publish"` avoids a circular import.

**Data fetching:** The pane component fetches `/api/plugin-view/tree`, builds the hierarchyId index, and shows the detail for `params.pluginId`. The tree is small so full-fetch-then-index is fine.

**Server endpoint:** `GET /api/plugin-view/tree` — identical handler to the current `/api/publish/tree`. The data belongs with the viewing primitive, not the publish flow.

**Types:** `PluginNode` keeps its name. `PublishTreePayload` → `PluginTreePayload`.

### 3. Move `plugins/publish/` → `plugins/plugin-meta/plugins/publish/`

The publish plugin keeps its tree pane and sidebar entry. It no longer owns the detail, types, or server endpoint.

**Delete from publish:**
- `shared/` (types moved to plugin-view)
- `server/` (endpoint moved to plugin-view)
- `web/components/plugin-detail.tsx` (moved to plugin-view)

**Modify:**

`web/components/publish-view.tsx` — Remove the right ResizablePanel (detail). Tree becomes full-width within the pane. On select, open `pluginViewPane` as the next Miller column:
```tsx
import { pluginViewPane } from "@plugins/plugin-meta/plugins/plugin-view/web";
onSelect={(id) => pluginViewPane.open({ pluginId: id })}
```

`web/panes.tsx` — Add `width: 360` (now a sidebar-width tree column). Read `selectedId` from the pane chain to highlight active row.

`web/index.ts` — Remove `publishPane` re-export (pane is internal now). Keep sidebar entry.

**Type imports:** publish's tree component imports `PluginNode` from `@plugins/plugin-meta/plugins/plugin-view/shared`.

### 4. Layout change (publish)

**Before:** Single full-width pane with `ResizablePanelGroup` (tree left + detail right).
**After:** Publish tree is one Miller column (~360px); selecting a plugin appends plugin-view as the adjacent column. Stats header stays in publish since it's publish-specific. Mirrors the `tasks-root` → `task-detail` pattern.

## Files to create

| File | Content |
|------|---------|
| `plugins/plugin-meta/package.json` | `{ "name": "@singularity/plugin-plugin-meta", "private": true, "version": "0.0.1" }` |
| `plugins/plugin-meta/CLAUDE.md` | Umbrella docs |
| `plugins/plugin-meta/web/index.ts` | Umbrella PluginDefinition (no contributions) |
| `plugins/plugin-meta/plugins/plugin-view/package.json` | `{ "name": "@singularity/plugin-plugin-view", "private": true, "version": "0.0.1" }` |
| `plugins/plugin-meta/plugins/plugin-view/CLAUDE.md` | Plugin docs |
| `plugins/plugin-meta/plugins/plugin-view/shared/types.ts` | `PluginNode`, `PluginTreePayload` |
| `plugins/plugin-meta/plugins/plugin-view/server/index.ts` | Route `GET /api/plugin-view/tree` → `handleTree` |
| `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` | Moved handler, update type import |
| `plugins/plugin-meta/plugins/plugin-view/web/index.ts` | Exports `pluginViewPane`, Pane.Register |
| `plugins/plugin-meta/plugins/plugin-view/web/panes.tsx` | `pluginViewPane` (segment `:pluginId`, after `[null, "publish"]`) |
| `plugins/plugin-meta/plugins/plugin-view/web/components/plugin-detail.tsx` | Moved from publish, update import path |

## Files to move

| From | To |
|------|-----|
| `plugins/publish/` | `plugins/plugin-meta/plugins/publish/` |

## Files to delete (from moved publish)

- `publish/shared/types.ts`
- `publish/server/index.ts`
- `publish/server/internal/tree-handler.ts`
- `publish/web/components/plugin-detail.tsx`

## Files to edit (within moved publish)

| File | Change |
|------|--------|
| `web/index.ts` | Remove `publishPane` re-export |
| `web/panes.tsx` | Add `width: 360` |
| `web/components/publish-view.tsx` | Remove detail panel + ResizablePanelGroup; tree-only; open pluginViewPane on select |
| `web/components/plugin-tree.tsx` | Update PluginNode import to `@plugins/plugin-meta/plugins/plugin-view/shared` |

## PLUGINS_ROOT note

The tree handler uses `resolve(import.meta.dir, "..", "..", "..")` to reach the `plugins/` root. From the new location `plugins/plugin-meta/plugins/plugin-view/server/internal/`, three levels up is `plugins/plugin-meta/plugins/` — that's wrong. Needs **five** levels up: `resolve(import.meta.dir, "..", "..", "..", "..", "..")` to reach `plugins/`.

## Verification

1. `./equin build` succeeds
2. Navigate to `/publish` — shows tree-only column with stats header
3. Click a plugin in the tree → detail opens as the adjacent Miller column (`/publish/:pluginId`)
4. Direct URL `/plugin-view/tasks` — opens standalone detail for the "tasks" plugin
5. `GET /api/plugin-view/tree` returns valid payload
6. `./equin check` passes (plugin boundaries, eslint)
