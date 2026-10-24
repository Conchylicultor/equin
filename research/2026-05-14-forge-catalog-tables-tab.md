# Forge Catalog: Tables Tab

## Context

The Forge catalog (`/forge/catalog`) aggregates cross-cutting plugin metadata into browsable tabs: Routes, Panes, Slots, Resources, Contributions. Database tables are a missing facet — plugins define ~30+ tables via Drizzle `pgTable()` declarations scattered across `server/internal/tables.ts` files, but this metadata isn't surfaced in the UI.

We add a 6th "Tables" tab. Each table row is expandable, and the expanded area uses `defineDetailSections` so future plugins can contribute detail sections (columns, FKs, entity extensions, etc.) without modifying the tables tab itself.

## Implementation

### Step 1 — Store parsed table names on the internal PluginNode

**File:** `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`

The data already exists: `parseTableNamesFromDbFiles` is called at line 842 and produces a `Map<varName, tableName>` per plugin, but the result is only stored in a local `pluginVarToTable` map used for entity-extension resolution. We persist it on the node.

1. Add a `TableDef` interface and a `tables` field to the internal `PluginNode`:

```ts
export interface TableDef {
  name: string;      // SQL table name, e.g. "conversations"
  varName: string;   // TS variable name, e.g. "_conversations"
}

// In PluginNode:
tables: TableDef[];
```

2. Initialize `tables: []` at the node creation site (line ~742, same block as `dbFiles`).

3. After the `pluginVarToTable` loop (line ~842), populate `info.tables` from each plugin's parsed result:

```ts
for (const info of byDir.values()) {
  const names = parseTableNamesFromDbFiles(info.dbFiles);
  pluginVarToTable.set(info.name, names);
  info.tables = [...names.entries()].map(([varName, name]) => ({ name, varName }));
}
```

4. Export the `TableDef` type from `core/index.ts`.

### Step 2 — Add `TableInfo` to the API types

**File:** `plugins/plugin-meta/plugins/plugin-view/core/types.ts`

```ts
export interface TableInfo {
  name: string;      // SQL table name
  varName: string;   // TS variable name
}
```

Add `tables: TableInfo[]` to the `PublicApi` interface.

Also add entity extension info (already on the internal node but dropped by the API):

```ts
export interface EntityExtensionInfo {
  parentPlugin: string;
  extName: string;
  tableName: string;
}

export interface EntityExtensionRef {
  childPlugin: string;
  extName: string;
  tableName: string;
}
```

Add to `PublicApi`: `entityExtensions: EntityExtensionInfo[]` and `extendedBy: EntityExtensionRef[]`.

Re-export the new types from `core/index.ts`.

### Step 3 — Map tables through `toApiNode()`

**File:** `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts`

In `toApiNode()`, add to the `publicApi` object:

```ts
tables: node.tables.map((t) => ({ name: t.name, varName: t.varName })),
entityExtensions: node.entityExtensions.map((e) => ({
  parentPlugin: e.parentPlugin,
  extName: e.extName,
  tableName: e.tableName,
})),
extendedBy: node.extendedBy.map((e) => ({
  childPlugin: e.childPlugin,
  extName: e.extName,
  tableName: e.tableName,
})),
```

### Step 4 — Export `flattenTree` and `countFlat` from catalog barrel

**File:** `plugins/apps/plugins/forge/plugins/catalog/web/index.ts`

The tables sub-plugin needs these utilities. Currently only `Catalog` is exported. Add:

```ts
export { flattenTree } from "./components/catalog-view";
export { countFlat } from "./count";
```

Also export `PluginChip` for reuse:

```ts
export { PluginChip } from "./components/plugin-chip";
```

### Step 5 — New sub-plugin: `catalog/plugins/tables/`

Create `plugins/apps/plugins/forge/plugins/catalog/plugins/tables/` with:

#### `package.json`

```json
{
  "name": "@singularity/plugin-apps-forge-catalog-tables",
  "private": true,
  "version": "0.0.1"
}
```

#### `web/slots.ts`

```ts
import { defineDetailSections } from "@plugins/primitives/plugins/detail-sections/web";

export const TableDetail = defineDetailSections<{
  tableName: string;
  pluginId: string;
}>("table-detail");
```

#### `web/components/tables-table.tsx`

A `Catalog.Category` component. Uses `flattenTree` to flatten all `publicApi.tables` across plugins, renders a list with `Collapsible` rows. Each expanded row renders `<TableDetail.Host>`.

The component handles its own filtering (matching table name, varName, and pluginId). Visually matches `DataTable` styling — sticky header row with column labels, then rows with chevron + table name + varName + PluginChip.

Imports from the catalog barrel: `flattenTree`, `countFlat`, `PluginChip` (via `@plugins/apps/plugins/forge/plugins/catalog/web`).

#### `web/index.ts`

```ts
import { MdTableChart } from "react-icons/md";
import { Catalog, countFlat } from "@plugins/apps/plugins/forge/plugins/catalog/web";
import { TablesTable } from "./components/tables-table";

export { TableDetail } from "./slots";

export default {
  id: "catalog-tables",
  name: "Forge: Catalog / Tables",
  description: "DB tables catalog tab with an extensible per-table detail slot.",
  contributions: [
    Catalog.Category({
      id: "tables",
      label: "Tables",
      icon: MdTableChart,
      getCount: (plugins) => countFlat(plugins, (p) => p.publicApi?.tables ?? []),
      component: TablesTable,
    }),
  ],
} satisfies PluginDefinition;
```

### Step 6 — Build and verify

```bash
./equin build
```

This regenerates `web/src/plugins.generated.ts` (auto-discovers the new plugin) and rebuilds everything.

## Verification

1. `./equin build` succeeds
2. Open `http://att-1778745891-835u.localhost:9000/forge/catalog`
3. A "Tables" tab appears with a count badge
4. Table rows show: chevron, SQL table name (mono), TS var name (muted), plugin chip
5. Clicking a row expands it — the detail area is empty (no sections contributed yet)
6. Filter narrows by table name, var name, or plugin ID
7. `./equin check` passes

## Key files

| File | Change |
|---|---|
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Add `TableDef`, `tables` field on `PluginNode`, populate from `parseTableNamesFromDbFiles` |
| `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` | Export `TableDef` |
| `plugins/plugin-meta/plugins/plugin-view/core/types.ts` | Add `TableInfo`, `EntityExtensionInfo`, `EntityExtensionRef` to API types |
| `plugins/plugin-meta/plugins/plugin-view/core/index.ts` | Re-export new types |
| `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` | Map `tables`, `entityExtensions`, `extendedBy` in `toApiNode()` |
| `plugins/apps/plugins/forge/plugins/catalog/web/index.ts` | Export `flattenTree`, `countFlat`, `PluginChip` |
| `plugins/apps/plugins/forge/plugins/catalog/plugins/tables/web/slots.ts` | NEW — `TableDetail = defineDetailSections(...)` |
| `plugins/apps/plugins/forge/plugins/catalog/plugins/tables/web/components/tables-table.tsx` | NEW — Tables tab component |
| `plugins/apps/plugins/forge/plugins/catalog/plugins/tables/web/index.ts` | NEW — Plugin definition |
| `plugins/apps/plugins/forge/plugins/catalog/plugins/tables/package.json` | NEW — Workspace entry |
