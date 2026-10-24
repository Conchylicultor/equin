# Forge Catalog View

## Context

The Forge app (`/forge`) has a Publish sidebar entry showing the plugin tree. Users can click a plugin to inspect its individual routes, slots, resources via the plugin detail pane. But there's no way to see *all* routes (or all slots, all panes, etc.) across every plugin in one place.

The catalog fills this gap: a cross-plugin contribution aggregator, grouped by contribution type, with per-type filterable tables. Clicking a plugin name in any table opens the existing `pluginViewPane` for the per-plugin drill-down — so the catalog complements the plugin detail view rather than replacing it.

## Design

Single pane (~700px) opened from a "Catalog" sidebar entry in Forge:

- **Top**: horizontal pill tabs — one per contribution type (Routes, Slots, Panes, Resources, Contributions). Each shows a count badge.
- **Below tabs**: text search input filtering within the selected type.
- **Main area**: a table with type-specific columns. Each row includes a clickable plugin chip that opens the plugin detail pane as the next miller column.

Extensibility: a `Catalog.Category` slot (using `defineSlot` from `@core`) lets future plugins contribute new type tabs without touching the catalog plugin.

## Data

The existing `GET /api/plugin-view/tree` endpoint returns the full `PluginNode[]` tree with `publicApi` (routes, slots, resources, exports) per plugin. The catalog fetches this same endpoint and aggregates client-side by walking the tree.

**API extension needed**: `PublicApi` currently omits `contributions` and `commands` from `TreePluginNode`. Add them so the catalog can show pane registrations and slot contributions.

## Implementation

### 1. Extend the API types and server handler

**`plugins/plugin-meta/plugins/plugin-view/core/types.ts`** — add:

```ts
export interface ContributionInfo {
  slot: string;
  id?: string;
  paneId?: string;
  panePath?: string;
}

export interface CommandInfo {
  groupName: string;
  memberName: string;
  commandId: string;
}
```

Extend `PublicApi` with `contributions: ContributionInfo[]` and `commands: CommandInfo[]`.

**`plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts`** — in `toApiNode()`, map from `TreePluginNode`:

```ts
contributions: node.contributions.map((c) => ({
  slot: c.slot,
  id: c.props["id"]?.replace(/^["'`]|["'`]$/g, ""),
  paneId: c.paneId,
  panePath: c.panePath,
})),
commands: node.commands.map((c) => ({
  groupName: c.groupName,
  memberName: c.memberName,
  commandId: c.commandId,
})),
```

### 2. Update pluginViewPane to follow the catalog pane

**`plugins/plugin-meta/plugins/plugin-view/web/panes.tsx`** — change:

```ts
after: ["publish", "plugin-view"]
// →
after: ["publish", "plugin-view", "catalog"]
```

This lets the plugin detail pane appear as the next miller column when opened from the catalog.

### 3. Create the catalog plugin

```
plugins/apps/plugins/forge/plugins/catalog/
├── package.json
├── web/
│   ├── index.ts              # barrel: Pane.Register + Forge.Sidebar + Catalog.Category contributions
│   ├── panes.tsx              # catalogPane (after:[null], segment:"catalog", width:700)
│   ├── slots.ts               # Catalog.Category slot
│   └── components/
│       ├── catalog-view.tsx   # shell: fetches tree, renders tabs + search + selected table
│       ├── plugin-chip.tsx    # clickable plugin name → openPane(pluginViewPane, {pluginId})
│       └── categories/
│           ├── routes-table.tsx
│           ├── panes-table.tsx
│           ├── slots-table.tsx
│           ├── resources-table.tsx
│           └── contributions-table.tsx
```

No `core/` needed — `CatalogCategoryProps` is defined alongside the slot in `web/slots.ts` since only web consumers need it.

### 4. Slot definition — `web/slots.ts`

```ts
import { defineSlot } from "@core";
import type { ComponentType } from "react";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";

export interface CatalogCategoryProps {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  getCount: (plugins: PluginNode[]) => number;
  component: ComponentType<{ plugins: PluginNode[]; filter: string }>;
}

export const Catalog = {
  Category: defineSlot<CatalogCategoryProps>("catalog.category", {
    docLabel: (p) => p.label,
  }),
};
```

### 5. Barrel — `web/index.ts`

Follow the publish pattern exactly: register `catalogPane` via `Pane.Register`, add `Forge.Sidebar` entry, and contribute all five built-in `Catalog.Category` entries inline. Re-export `Catalog` for future external consumers.

### 6. Catalog view — `web/components/catalog-view.tsx`

- Fetch `GET /api/plugin-view/tree` on mount (same `useEffect` pattern as `PublishView` and `PluginViewBody`)
- Read categories via `Catalog.Category.useContributions()`
- State: `selectedCategoryId` (default: first category's id), `filter` (string)
- Render tab bar → search → selected category's `component` with `{ plugins, filter }`
- Helper `flattenTree<T>(plugins, extract)` walks the tree recursively, pairs each extracted item with the owning `PluginNode`, returns `{ item: T; plugin: PluginNode }[]`

### 7. Category tables

Each table component receives `{ plugins: PluginNode[]; filter: string }`, flattens the tree, filters by the search string, and renders a table.

**Routes table** — columns: Method (colored badge: GET=emerald, POST=blue, PUT=amber, DELETE=red, WS=violet), Path, Plugin (chip), Callers (count).

**Panes table** — filter contributions to `slot === "Pane.Register"`. Columns: Pane ID, Segment, Plugin (chip).

**Slots table** — columns: Group.Member, Slot ID, Plugin (chip), Contributors (count).

**Resources table** — columns: Key, Mode, Plugin (chip).

**Contributions table** — all slot contributions. Columns: Slot, ID (if present), Plugin (chip).

### 8. Plugin chip — `web/components/plugin-chip.tsx`

Renders `hierarchyId` as a monospaced clickable chip. On click: `openPane(pluginViewPane, { pluginId: hierarchyId })`. Import `pluginViewPane` from `@plugins/plugin-meta/plugins/plugin-view/web`.

## Files to modify

| File | Change |
|------|--------|
| `plugins/plugin-meta/plugins/plugin-view/core/types.ts` | Add `ContributionInfo`, `CommandInfo`, extend `PublicApi` |
| `plugins/plugin-meta/plugins/plugin-view/core/index.ts` | Re-export new types |
| `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` | Map `contributions` + `commands` in `toApiNode()` |
| `plugins/plugin-meta/plugins/plugin-view/web/panes.tsx` | Add `"catalog"` to `after` array |

## Files to create

All under `plugins/apps/plugins/forge/plugins/catalog/`:
- `package.json`
- `web/index.ts`, `web/panes.tsx`, `web/slots.ts`
- `web/components/catalog-view.tsx`, `web/components/plugin-chip.tsx`
- `web/components/categories/routes-table.tsx`, `panes-table.tsx`, `slots-table.tsx`, `resources-table.tsx`, `contributions-table.tsx`

## Verification

1. `./equin build`
2. Open `http://<worktree>.localhost:9000/forge/catalog`
3. Verify Catalog sidebar entry appears and opens the pane
4. Click each category tab — verify tables show correct aggregated data with counts
5. Type in the search input — verify rows filter
6. Click a plugin chip — verify `pluginViewPane` opens as the next miller column
7. Verify publish → plugin-view flow still works (regression)
