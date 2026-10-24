# Exports Facet Migration

## Context

The facet-based plugin metadata pipeline (see `research/2026-05-20-global-unified-facet-docgen.md`)
is migrating monolithic metadata extraction into self-contained facet sub-plugins under
`plugins/plugin-meta/plugins/facets/plugins/`. Eight facets have been created (commands,
contributions, cross-refs, db-schema, registrations, resources, routes, slots). The `exports`
facet — barrel exports metadata with per-symbol consumer tracking — is the remaining one.

Currently, barrel exports are extracted monolithically in `collectPlugin()` in
`plugin-tree/core/internal/plugin-tree.ts` via the private `parseBarrelExports()` function,
stored in `PluginNode.exports: Record<Runtime|"core"|"shared", BarrelExport[]>`. Per-symbol
consumers are computed at request-time in `plugin-view/server/internal/tree-handler.ts` via
`buildSymbolConsumers()`, which reads the legacy `apiUses` fields.

This task is Step 3 of the migration: create the `exports` facet with **dual-write** so
`node.facets["exports"]` is populated while `node.exports` remains unchanged. Doc output
must remain byte-identical. The `consumers` data (from `relate()`) becomes bonus metadata
that `tree-handler.ts` will consume in a later step.

## What to build

### 1. Export `parseBarrelExports` from `plugin-tree/core`

The function is currently private. Two files to change:

**`plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`**
- Change `function parseBarrelExports(src: string)` → `export function parseBarrelExports(src: string)`

**`plugins/plugin-meta/plugins/plugin-tree/core/index.ts`**
- Add `parseBarrelExports` to the existing `export { ... }` statement alongside `readIfExists`, `stripTypes`, etc.

### 2. Create `plugins/plugin-meta/plugins/facets/plugins/exports/`

Three files:

#### `facet/index.ts`

```typescript
import { join } from "path";
import {
  createFacet,
  defineFacet,
  getFacet,
} from "@plugins/plugin-meta/plugins/facets/core";
import {
  parseBarrelExports,
  readIfExists,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { crossRefsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/cross-refs/facet";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";

const RUNTIMES = ["core", "web", "server", "central", "shared"] as const;
type Runtime = (typeof RUNTIMES)[number];

export interface ExportedSymbol {
  name: string;
  kind: "type" | "value";
  consumers: string[];  // filled in relate()
}

export interface ExportsData {
  web: ExportedSymbol[];
  server: ExportedSymbol[];
  central: ExportedSymbol[];
  core: ExportedSymbol[];
  shared: ExportedSymbol[];
}

export const exportsFacetDef = defineFacet<ExportsData>("exports");

export default createFacet<ExportsData>({
  def: exportsFacetDef,

  extract(ctx) {
    const parse = (runtime: Runtime): ExportedSymbol[] => {
      const src = readIfExists(join(ctx.dir, runtime, "index.ts"));
      if (!src) return [];
      return parseBarrelExports(src).map(({ name, kind }) => ({ name, kind, consumers: [] }));
    };
    return {
      web: parse("web"),
      server: parse("server"),
      central: parse("central"),
      core: parse("core"),
      shared: parse("shared"),
    };
  },

  relate(ctx: unknown) {
    const { tree } = ctx as { tree: PluginTree };

    // Build: targetPluginName → Map<symbol, consumerNames[]>
    const byName = new Map<string, { name: string; facets: Record<string, unknown> }>();
    for (const node of tree.byDir.values()) byName.set(node.name, node);

    for (const importer of tree.byDir.values()) {
      const crossRefs = getFacet(importer, crossRefsFacetDef);
      if (!crossRefs) continue;

      for (const rt of RUNTIMES) {
        for (const use of crossRefs.apiUses[rt] ?? []) {
          const dot = use.indexOf(".");
          if (dot < 0) continue;  // namespace import — no symbol-level attribution
          const targetName = use.slice(0, dot);
          const symbol = use.slice(dot + 1);

          const target = byName.get(targetName);
          if (!target || target === importer) continue;

          const targetExports = getFacet(target, exportsFacetDef);
          if (!targetExports) continue;

          // Search all runtimes of the target for this symbol
          for (const targetRt of RUNTIMES) {
            const sym = targetExports[targetRt].find((s) => s.name === symbol);
            if (sym && !sym.consumers.includes(importer.name)) {
              sym.consumers.push(importer.name);
            }
          }
        }
      }
    }

    // Sort consumers for deterministic output
    for (const node of tree.byDir.values()) {
      const data = getFacet(node, exportsFacetDef);
      if (!data) continue;
      for (const rt of RUNTIMES) {
        for (const sym of data[rt]) sym.consumers.sort();
      }
    }
  },

  renderDoc(data, ctx) {
    const lines: string[] = [];
    const subIndent = `${ctx.bodyIndent}  `;

    const renderRuntime = (rt: Runtime, symbols: ExportedSymbol[]) => {
      if (symbols.length === 0) return;
      const types = symbols.filter((s) => s.kind === "type");
      const values = symbols.filter((s) => s.kind === "value");
      lines.push(`${ctx.bodyIndent}- Exports (${rt}):`);
      if (types.length > 0) {
        lines.push(`${subIndent}- Types: ${types.map((s) => `\`${s.name}\``).join(", ")}`);
      }
      if (values.length > 0) {
        lines.push(`${subIndent}- Values: ${values.map((s) => `\`${s.name}\``).join(", ")}`);
      }
    };

    renderRuntime("core", data.core);
    renderRuntime("web", data.web);
    renderRuntime("server", data.server);
    renderRuntime("central", data.central);
    renderRuntime("shared", data.shared);

    return lines;
  },
});
```

#### `package.json`

Copy the pattern from any sibling facet (e.g. `commands/package.json`) — only needs `name` and any
local `dependencies`/`peerDependencies`. No new deps needed beyond what `commands` uses.

#### `CLAUDE.md`

Standard plugin CLAUDE.md — brief prose description, no autogen block yet (added by build).

### 3. Run `./equin build`

`facet.generated.ts` auto-regenerates with the new `exports` entry. Doc output should be
byte-identical because:
- The facet's `renderDoc` mirrors `renderExportsAt` in docgen.ts exactly (same order: core → web → server → central → shared, same types/values grouping)
- `node.exports` monolithic field remains and is still used by docgen in this dual-write step

## Critical files

| File | Change |
|---|---|
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Export `parseBarrelExports` |
| `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` | Add `parseBarrelExports` to barrel |
| `plugins/plugin-meta/plugins/facets/plugins/exports/facet/index.ts` | **New** — the facet |
| `plugins/plugin-meta/plugins/facets/plugins/exports/package.json` | **New** — copy sibling pattern |
| `plugins/plugin-meta/plugins/facets/plugins/exports/CLAUDE.md` | **New** — prose description |
| `plugins/plugin-meta/plugins/facets/core/facet.generated.ts` | Auto-regenerated by build |

## Key design decisions

- **`parseBarrelExports` export**: exporting it is cleaner than duplicating it (unlike
  `parseApiUses` in cross-refs, which pre-dated this pattern). The function is a pure utility
  with no side effects and already morally public.
- **`relate()` reads `cross-refs` facet**: instead of re-scanning imports, we read the already-
  computed `crossRefsFacetDef` data. This requires `cross-refs` to run its `extract()` first,
  but `relate()` phases are all post-extract, so ordering is fine.
- **`consumers[]` cross-runtime search**: a named import `target-plugin.FooBar` found in any of
  the importer's runtimes is searched across all target runtimes (core/web/server/central/shared).
  This matches how `buildSymbolConsumers` in `tree-handler.ts` works today.
- **Dual-write**: `node.exports` is untouched. Docgen still calls `renderExportsAt` from the
  monolithic path. The facet lives alongside it. Step 4 (later) will flip docgen to the facet loop.

## Verification

After `./equin build`:

1. `facet.generated.ts` must include the new `exports` entry (9 facets total).
2. `./equin check` must pass (especially `plugins-doc-in-sync`, `plugin-boundaries`, `eslint`).
3. Spot-check a plugin with exports in the generated `docs/plugins-details.md` — the `Exports (web):` /
   `Exports (core):` sections must be byte-identical to the previous build output.
4. Verify the `exports` facet data is populated via `query_db` or by adding a temporary `console.log`
   in `enrichPluginTreeDocs` (optional — build success + check pass is sufficient for a dual-write step).
