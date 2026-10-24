# Public API Viewer Sub-plugin

## Context

The plugin-view detail pane shows plugin metadata via `PluginView.Section` contributions. Current sections: runtimes (10), sub-plugins (20), source-path (30). There's no way to see a plugin's **public API** — its exports, who consumes them, slots it defines, routes it exposes, etc.

This plan adds a `public-api` sub-plugin (order: 15, between runtimes and sub-plugins) that surfaces the full public contract of a plugin: exports grouped by runtime with per-symbol consumer info, slots with contributors, HTTP routes with callers, and live-state resources.

## Data pipeline changes

### 1. Extend `parseServerApiUses` → `parseApiUses`

**File:** `plugins/plugin-meta/plugins/plugin-tree/shared/internal/plugin-tree.ts`

The existing `parseServerApiUses(dir, selfName, runtime)` scans `server/` or `central/` for cross-plugin imports. Generalize it:

- Rename to `parseApiUses(dir, selfName, runtime)` where `runtime` is `"web" | "server" | "central" | "shared"` and the regex matches `@plugins/<name>/<runtime>`.
- In `collectPlugin()`, also call it for `web/` and `shared/` directories.
- Store results in a new field on `PluginNode`:
  ```ts
  web: RuntimeDetail;   // NEW — add alongside existing server/central
  shared: { apiUses: string[] };  // NEW — minimal, just cross-plugin imports
  ```

Wait — adding `web: RuntimeDetail` would be a larger refactor. Simpler approach: add a top-level `apiUses` field that merges all runtimes, or extend the existing `importedBy` computation to also include web/shared edges.

**Simpler approach**: keep `parseServerApiUses` name but make the `runtime` parameter accept all four runtimes. In `collectPlugin`, call it for web/ and shared/ too. Accumulate all uses into a single **flat** `allApiUses: string[]` on the node (or just extend the existing `server.apiUses` / `central.apiUses` pattern to also store `webApiUses` and `sharedApiUses` as top-level fields).

**Chosen approach**: Add `webApiUses: string[]` and `sharedApiUses: string[]` fields to `PluginNode`. Update `computeRelationships` to include these in the `importedBy` reverse-index computation (line 753 currently only iterates `server.apiUses` and `central.apiUses`).

### 2. Extend API type

**File:** `plugins/plugin-meta/plugins/plugin-view/shared/types.ts`

Add to existing `PluginNode`:

```ts
export interface BarrelExport {
  name: string;
  kind: "type" | "value";
  category: "type" | "hook" | "component" | "value";
}

export interface SlotInfo {
  groupName: string;
  memberName: string;
  slotId: string;
  contributors: string[];  // plugin-level, from slotContributors
}

export interface RouteInfo {
  route: string;
  callers: string[];  // plugin-level, from endpointCallers
}

export interface ResourceInfo {
  key: string;
  mode: string;
}

export interface PublicApi {
  exports: Record<"web" | "server" | "central" | "shared", BarrelExport[]>;
  importedBy: string[];
  slots: SlotInfo[];
  routes: RouteInfo[];
  resources: ResourceInfo[];
}

export interface PluginNode {
  // ... existing fields ...
  publicApi?: PublicApi;  // NEW
}
```

### 3. Update `toApiNode` to populate `publicApi`

**File:** `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts`

- Before mapping nodes, build a per-symbol consumer index from the full tree:
  - Iterate all nodes, collect `server.apiUses`, `central.apiUses`, `webApiUses`, `sharedApiUses`
  - Each entry is `"pluginName.symbolName"` — invert to `Map<pluginName, Map<symbolName, consumerName[]>>`
- In `toApiNode`, look up per-symbol consumers and categorize exports:
  - `kind === "type"` → `"type"`
  - `kind === "value"` + `/^use[A-Z]/` → `"hook"`
  - `kind === "value"` + `/^[A-Z]/` → `"component"`
  - else → `"value"`
- Populate `slots` from `node.slots` + `node.slotContributors`
- Populate `routes` from `node.server.httpRoutes` + `node.central.httpRoutes` + `node.endpointCallers`
- Populate `resources` from `node.server.resources` + `node.central.resources`

### 4. Extend plugin-tree `PluginNode` type

**File:** `plugins/plugin-meta/plugins/plugin-tree/shared/internal/plugin-tree.ts`

Add two fields to the internal `PluginNode` interface (around line 52):
```ts
webApiUses: string[];     // NEW
sharedApiUses: string[];  // NEW
```

Initialize them in `collectPlugin()` by calling the (renamed/extended) parse function on `web/` and `shared/` dirs.

Update `computeRelationships` (line 753) to also iterate `webApiUses` and `sharedApiUses` when building the `importedBy` reverse index.

## Sub-plugin structure

```
plugins/plugin-meta/plugins/plugin-view/plugins/public-api/
├── package.json
└── web/
    ├── index.ts                         # definePlugin, contributes Section at order 15
    └── components/
        └── public-api-section.tsx       # main section component
```

### `web/index.ts`

Standard pattern: import `PluginViewSlots` from parent, contribute `PublicApiSection` at order 15.

### `web/components/public-api-section.tsx`

**Structure:**

```
PublicApiSection({ node })
  return null if no exports + no slots + no routes + no resources
  <Section title="Public API" count="42 exports">
    {importedBy.length > 0 && <ImportedByBanner />}     // "Imported by: tasks, agents, +3 more"
    {runtimes.map(rt => <RuntimeGroup />)}                // collapsible per-runtime
    {slots.length > 0 && <SlotsSubsection />}
    {routes.length > 0 && <RoutesSubsection />}
    {resources.length > 0 && <ResourcesSubsection />}
  </Section>
```

**ImportedByBanner** — a single line showing which plugins depend on this one at the barrel level. Muted text, comma-separated plugin names. Clickable to open that plugin's detail.

**RuntimeGroup** — collapsible sub-heading (▼ web (18)):
- Default: expanded for the runtime with the most exports, collapsed for the rest.
- Each export row: `[badge] symbolName    ← consumer1, consumer2`
  - Badge colors: hook=purple, component=sky, type=muted/gray, value=stone
  - Consumer names are clickable (open plugin view for that consumer)
  - If >2 consumers, show first 2 + "(+N)" that toggles to show all

**SlotsSubsection** — sub-heading "Slots (N)":
- Each row: `GroupName.MemberName` with slotId in muted text
- Badge showing contributor count, clickable to expand list

**RoutesSubsection** — sub-heading "Routes (N)":
- Each row: `GET /api/foo/bar` with method colored (GET=green, POST=blue, PUT=amber, DELETE=red)
- Caller count badge

**ResourcesSubsection** — sub-heading "Resources (N)":
- Each row: `key (mode)` in monospace

## Key files to modify

| File | Change |
|------|--------|
| `plugins/plugin-meta/plugins/plugin-tree/shared/internal/plugin-tree.ts` | Add webApiUses/sharedApiUses fields, extend parse function, update computeRelationships |
| `plugins/plugin-meta/plugins/plugin-view/shared/types.ts` | Add PublicApi types and `publicApi` field to PluginNode |
| `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` | Build per-symbol consumer index, categorize exports, populate publicApi in toApiNode |
| `plugins/plugin-meta/plugins/plugin-view/plugins/public-api/` | NEW — entire sub-plugin (package.json, web/index.ts, web/components/public-api-section.tsx) |

## Verification

1. `./equin build` — confirms plugin discovery, type checking, and build pass
2. Open plugin-view for `conversations` (many exports, slots, routes) — verify all runtime groups, consumer annotations, slots, and routes render
3. Open plugin-view for `plugin-meta` (umbrella with no barrel) — verify section returns null
4. Open plugin-view for `live-state` (load-bearing, heavily imported) — verify importedBy banner and per-symbol consumers
5. `./equin check` — boundary check and registry check pass
6. Click a consumer name → navigates to that plugin's detail view
