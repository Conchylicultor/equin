# resources facet migration

## Context

The `resources` metadata (`defineResource()` calls from `server/` and `central/` directories) is currently extracted monolithically in `collectPlugin()` inside `plugin-tree.ts` and stored on `PluginNode.server.resources` / `PluginNode.central.resources`. The `slots` and `commands` facets already follow the proper facet pattern. The `resources` data needs its own sub-plugin under `plugins/plugin-meta/plugins/facets/plugins/resources/` for consistency and to enable future consumers to read from the facet system rather than the direct `PluginNode` fields.

**Key discoveries from exploration:**
- `parseResources` is private (not exported) in `plugin-tree.ts` — must be exported from `plugin-tree/core` barrel
- `ResourceDef` does not exist as a named type — must be defined and exported
- `enrichPluginTreeDocs` only calls `facet.extract()` and `facet.relate()` — `renderDoc()` is required by the interface but currently never called (same as `commands` and `slots`)
- `docgen.ts` reads `node.server.resources` / `node.central.resources` directly and does NOT use facets — no conflict with the new facet
- Resources span **two runtimes** (server + central), unlike commands/slots which only read `web/`

## Scope

This plan covers only the facet creation and the necessary `plugin-tree/core` export additions. Updating `docgen.ts`, `plugin-view`, and `plugin-changes` to use `getFacet()` and removing the direct fields from `PluginNode` is a follow-up task.

## Files to modify

### 1. Export `ResourceDef` + `parseResources` from `plugin-tree/core`

**`plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`**

- Define `export interface ResourceDef { key: string; mode: string; }` near the top with other type definitions
- Add `export` keyword to `function parseResources`

**`plugins/plugin-meta/plugins/plugin-tree/core/index.ts`**

- Add: `export { parseResources, type ResourceDef } from "./internal/plugin-tree";`

### 2. Create the resources facet sub-plugin (3 new files)

**`plugins/plugin-meta/plugins/facets/plugins/resources/package.json`**
```json
{
  "name": "@singularity/plugin-plugin-meta-facets-resources",
  "version": "0.0.1",
  "private": true
}
```

**`plugins/plugin-meta/plugins/facets/plugins/resources/CLAUDE.md`**
```markdown
# resources

Extracts `defineResource()` definitions from each plugin's `server/` and
`central/` directories. No `relate()` — resources have no cross-plugin
relationships.

Resources span two runtimes, so facet data is `{ server: ResourceDef[],
central: ResourceDef[] }`.
```

**`plugins/plugin-meta/plugins/facets/plugins/resources/facet/index.ts`**
```ts
import { existsSync } from "fs";
import { join } from "path";
import {
  createFacet,
  defineFacet,
} from "@plugins/plugin-meta/plugins/facets/core";
import {
  type ResourceDef,
  parseResources,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";

export interface ResourceFacetData {
  server: ResourceDef[];
  central: ResourceDef[];
}

export const resourcesFacetDef = defineFacet<ResourceFacetData>("resources");

export default createFacet<ResourceFacetData>({
  def: resourcesFacetDef,

  extract(ctx) {
    const serverDir = join(ctx.dir, "server");
    const centralDir = join(ctx.dir, "central");
    return {
      server: existsSync(serverDir) ? parseResources(serverDir) : [],
      central: existsSync(centralDir) ? parseResources(centralDir) : [],
    };
  },

  renderDoc(data, ctx) {
    const lines: string[] = [];
    const indent = `${ctx.bodyIndent}  `;
    if (data.server.length > 0) {
      lines.push(
        `${indent}- Resources (server): ${data.server.map((r) => `\`${r.key}\` (${r.mode})`).join(", ")}`,
      );
    }
    if (data.central.length > 0) {
      lines.push(
        `${indent}- Resources (central): ${data.central.map((r) => `\`${r.key}\` (${r.mode})`).join(", ")}`,
      );
    }
    return lines;
  },
});
```

### 3. Auto-registration (no manual edit needed)

Running `./equin build` will regenerate `plugins/plugin-meta/plugins/facets/core/facet.generated.ts` to include:
```ts
{ pluginPath: "plugin-meta/plugins/facets/plugins/resources", hierarchyPath: "plugin-meta/facets/resources", loader: () => import("@plugins/plugin-meta/plugins/facets/plugins/resources/facet"), dependsOn: [] }
```

## Design notes

**Data shape `{ server, central }` vs flat `ResourceDef[]`.** Keeping the runtime split preserves semantic information and mirrors how `docgen.ts` and `plugin-view` already treat them separately (rendered under distinct "Server:" / "Central:" sections). A flat list would lose the runtime attribution.

**`parseResources` export vs inline.** Exporting from `plugin-tree/core` is preferred because it avoids duplicating the walk + regex logic, and keeps the facet's `extract()` minimal (same approach as `commands`/`slots` using `parseDefineGroup`).

**`renderDoc` is dead code today** (never called by `enrichPluginTreeDocs` or `docgen.ts`). It is still required by the `Facet` interface and consistent with the other facets. Future callers will find it ready.

## Verification

1. `./equin build` — succeeds; confirms `facet.generated.ts` updated with the new entry
2. `./equin check` — all checks pass (especially `plugins-registry-in-sync`, `plugins-doc-in-sync`, `plugin-boundaries`)
3. Inspect `node.facets["resources"]` via the Debug app or `query_db` — confirm resource data appears for a plugin known to call `defineResource` (e.g. `plugins/tasks-core/server/internal/resources.ts`)
