# Facets v3 — Phase 2: exports facet reference rendering slice

> Executes **Phase 2** of `research/2026-06-02-global-facets-rendering-separation-v3.md`.
> Read that doc first for the full model. This plan covers only Phase 2.

## Context

A **facet** is a self-contained slice of plugin metadata. Each facet's data feeds four
surfaces: **doc** (markdown), **detail** (Forge plugin pane), **diff** (PR review), and
**catalog** (Forge aggregated tables). Today only the doc surface originates from the facet
folder (`facet.renderDoc`). Detail/diff/catalog rendering still lives in the *consumers*:
hardcoded `*Strings()` helpers in `compute-plugin-diff.ts`, the monolithic
`public-api-section.tsx`, and hardcoded `publicApi?.*` catalog tables.

Phase 2 builds the **reference vertical slice** for the `exports` facet — the pattern every
other facet will copy in Phase 3 — proving that diff/detail/catalog renderers can originate
from one facet folder. The three browser-render slots already exist (`PluginViewSlots.Section`,
`PluginChanges.DiffRenderer`, `Catalog.FacetTable`); Phase 2 contributes the first real
implementations to them and moves the pure `toComparable` projection into `exports/core`.

### Scope decision (confirmed: **strict slice**)

Phase 2 creates the three render sub-plugins + the `core` projection + the minimal **additive**
`facets` passthrough on the API node so they compile and register. It does **not** flip the
host consumers or the build pipeline — that is Phase 4. Consequence: the new contributions are
registered and visible in generated docs, but they render **empty live** until Phase 4 makes
`node.facets` actually populate (the hosts and the `skipBarrelImport` pipeline flip land then).
This is the correct, clean intermediate state — no half-flipped or throwaway host code, no
duplicate UI (the old detail section also renders empty today, so there is no visible double).

## Mental model (the rule this slice proves)

> Pure transforms (`toComparable`) → `core/`. Build-time ops (`extract`/`relate`/`renderDoc`)
> → `facet/`. Browser renderers (diff/detail/catalog) → `web/` sub-plugins under the facet.

Target shape after Phase 2:

```
facets/plugins/exports/
  core/            types + facetDef + toComparable (pure)            [exists + NEW to-comparable]
  facet/           extract + relate + renderDoc                      [exists, unchanged]
  plugins/
    render-diff/web/      contributes PluginChanges.DiffRenderer     [NEW]
    render-detail/web/    contributes PluginViewSlots.Section        [NEW]
    render-catalog/web/   contributes Catalog.FacetTable             [NEW]
```

## Work items

### 1. `toComparable` → `exports/core` (pure projection)

The diff projection currently lives in `compute-plugin-diff.ts:50-58` as `exportStrings(node)`,
reading the build node's `node.exports`. Re-home it as a pure function over the facet's
`ExportsData` shape.

- NEW `plugins/plugin-meta/plugins/facets/plugins/exports/core/to-comparable.ts`:
  ```ts
  import type { ExportsData } from "./types";

  /** Diff projection: one `"<runtime>: <name>"` string per exported symbol.
   *  Mirrors the legacy exportStrings() (compute-plugin-diff.ts) byte-for-byte —
   *  runtimes web/server/central/core, `shared` intentionally omitted. */
  export function exportsToComparable(data: ExportsData): string[] {
    const result: string[] = [];
    for (const runtime of ["web", "server", "central", "core"] as const) {
      for (const sym of data[runtime]) result.push(`${runtime}: ${sym.name}`);
    }
    return result;
  }
  ```
- EDIT `exports/core/index.ts`: add `export { exportsToComparable } from "./to-comparable";`

> Keep `shared` omitted to preserve identical diff output (mirror precedent). Do **not** touch
> `compute-plugin-diff.ts` — its `exportStrings` is deleted in Phase 4.4, not here.

### 2. `render-diff/web` — contributes `PluginChanges.DiffRenderer`

`PluginChanges.DiffRenderer` is a plain `defineSlot<DiffRenderer>` in
`plugins/review/plugins/plugin-changes/web/slots.ts:18`. `DiffRenderer` =
`{ facetId; label; toComparable: (data: unknown) => string[] }`.

- NEW `exports/plugins/render-diff/package.json` (mirror sibling; name
  `@singularity/plugin-plugin-meta-facets-exports-render-diff`).
- NEW `exports/plugins/render-diff/web/index.ts`:
  ```ts
  import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
  import { PluginChanges } from "@plugins/review/plugins/plugin-changes/web";
  import {
    exportsToComparable,
    type ExportsData,
  } from "@plugins/plugin-meta/plugins/facets/plugins/exports/core";

  export default {
    id: "exports-render-diff",
    name: "Exports: Diff Renderer",
    description: "Diff renderer for the exports facet (PR review).",
    contributions: [
      PluginChanges.DiffRenderer({
        facetId: "exports",
        label: "Exports",
        toComparable: (data) => exportsToComparable(data as ExportsData),
      }),
    ],
  } satisfies PluginDefinition;
  ```
- NEW `exports/plugins/render-diff/CLAUDE.md` (title + `## Plugin reference` placeholder; build fills it).

### 3. `render-detail/web` — contributes `PluginViewSlots.Section`

The detail slot is `PluginViewSlots.Section` (a `defineDetailSections` slot,
`plugin-view/web/slots.ts:4`); contributors call
`PluginViewSlots.Section({ id, label, component })` with `component: ({ node }) => …`.
Port the exports-specific pieces of `public-api-section.tsx` (`RuntimeGroup`, `SymbolRow`,
`RUNTIME_COLORS`, `CATEGORY_STYLES`, `categorize`, `ConsumerList`, `PluginLink`). Read facet
data via `getFacet(node, exportsFacetDef)`.

Key adaptation: the facet stores raw `ExportedSymbol { name; kind: "type"|"value"; consumers }`
(no `category`). Move `categorize(name, kind)` (today in `tree-handler.ts:12`) into this sub-plugin
and derive the presentation category client-side. Render **only** the export runtime groups —
*not* `ImportedByBanner`/slots/routes/resources (those belong to other facets' render-detail in
Phase 3).

- NEW `exports/plugins/render-detail/package.json`.
- NEW `exports/plugins/render-detail/web/index.ts`:
  ```ts
  import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
  import { PluginViewSlots } from "@plugins/plugin-meta/plugins/plugin-view/web";
  import { ExportsDetailSection } from "./components/exports-detail-section";

  export default {
    id: "exports-render-detail",
    name: "Exports: Detail Section",
    description: "Per-plugin exports section in the plugin detail pane.",
    contributions: [
      PluginViewSlots.Section({ id: "exports", label: "Exports", component: ExportsDetailSection }),
    ],
  } satisfies PluginDefinition;
  ```
- NEW `exports/plugins/render-detail/web/components/exports-detail-section.tsx`:
  - `ExportsDetailSection({ node }: { node: PluginNode })` — `PluginNode` from
    `@plugins/plugin-meta/plugins/plugin-view/web`.
  - `const data = getFacet(node, exportsFacetDef)` (`getFacet` from
    `@plugins/plugin-meta/plugins/facets/core`; `exportsFacetDef` from the exports `core`);
    `if (!data) return null;`
  - Wrap in `<Section title="Exports" count={…}>` (`Section` from `plugin-view/web`).
  - Port `RUNTIME_COLORS`, `RuntimeGroup`, `CATEGORY_STYLES`, `categorize`, `SymbolRow`,
    `ConsumerList`, `PluginLink` verbatim from `public-api-section.tsx`, mapping
    `ExportedSymbol → {name, kind, category: categorize(name, kind), consumers}` at the group level.
  - `RUNTIMES = ["web","server","central","core","shared"]` (detail shows all five).
- NEW `exports/plugins/render-detail/CLAUDE.md`.

> `PluginLink`/`ConsumerList`/`SubHeading` are duplicated here intentionally; Phase 3 extracts
> them to a shared home. Keep the copies local for Phase 2.

### 4. `render-catalog/web` — contributes `Catalog.FacetTable`

`Catalog.FacetTable` = `defineSlot<CatalogFacetTable>` (`catalog/web/slots.ts:41`).
`CatalogFacetTable { facetId; label; icon; columns; rows; rowKey }` built via `defineFacetTable`
(`catalog/web/facet-table.ts`). The host that iterates this slot does not exist yet (Phase 4.5),
so this contribution is declarative-only for now.

- NEW `exports/plugins/render-catalog/package.json`.
- NEW `exports/plugins/render-catalog/web/exports-facet-table.tsx` (logic lives outside the
  barrel to satisfy barrel-purity):
  - Row type `ExportRow = { plugin: PluginNode; runtime: string; name: string; kind: "type"|"value"; consumers: string[] }`.
  - `rows(entries)` flattens every `{ node, data }` entry over the five runtimes
    (`data as ExportsData`), one row per symbol.
  - `columns: ColumnDef<ExportRow>[]` — Symbol (`code`), Runtime, Kind badge (use **muted/semantic**
    classes only — no raw color scale, so the catalog file needs no allowlist entry), Plugin
    (`PluginChip` from `catalog/web`), Consumers count.
  - `rowKey = (r) => \`${r.plugin.hierarchyId}:${r.runtime}:${r.name}\``.
  - Export `export const exportsFacetTable = defineFacetTable<ExportRow>({ facetId: "exports", label: "Exports", icon: MdOutput, columns, rows, rowKey });`
- NEW `exports/plugins/render-catalog/web/index.ts`:
  ```ts
  import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
  import { Catalog } from "@plugins/apps/plugins/forge/plugins/catalog/web";
  import { exportsFacetTable } from "./exports-facet-table";

  export default {
    id: "exports-render-catalog",
    name: "Exports: Catalog Table",
    description: "Aggregated cross-plugin exports table in the Forge catalog.",
    contributions: [Catalog.FacetTable(exportsFacetTable)],
  } satisfies PluginDefinition;
  ```
- NEW `exports/plugins/render-catalog/CLAUDE.md`.

### 5. Additive `facets` scaffolding on the API node (so the renderers compile)

The browser `PluginNode` (`plugin-view/core/types.ts`) carries `publicApi?` but no `facets`.
render-detail/render-catalog reference `node.facets[…]`. Add the field **additively** (keep
`publicApi?` for now — it is deleted in Phase 4) and pass it through. Under `skipBarrelImport`
the value is `{}`, so the renderers read `undefined` and render empty — the accepted dormant state.

- EDIT `plugin-view/core/types.ts`: add `facets: Record<string, unknown>;` to `interface PluginNode`.
- EDIT `plugin-view/server/internal/tree-handler.ts` `toApiNode(...)`: add `facets: node.facets,`
  to the returned object (the build node already has `node.facets`).

### 6. `no-hardcoded-colors` allowlist

render-detail ports categorical palettes (`RUNTIME_COLORS`, `CATEGORY_STYLES`).

- EDIT `plugins/framework/plugins/tooling/plugins/checks/plugins/no-hardcoded-colors/check/index.ts`
  `ALLOWED_PATHS`: add
  `"plugins/plugin-meta/plugins/facets/plugins/exports/plugins/render-detail/web/components/"`.
  (render-catalog uses muted/semantic classes only → no entry needed.)

## Critical files

| File | Change |
|---|---|
| `facets/plugins/exports/core/to-comparable.ts` | NEW — `exportsToComparable` |
| `facets/plugins/exports/core/index.ts` | EDIT — re-export `exportsToComparable` |
| `facets/plugins/exports/plugins/render-diff/{package.json,CLAUDE.md,web/index.ts}` | NEW |
| `facets/plugins/exports/plugins/render-detail/{package.json,CLAUDE.md,web/index.ts,web/components/exports-detail-section.tsx}` | NEW |
| `facets/plugins/exports/plugins/render-catalog/{package.json,CLAUDE.md,web/index.ts,web/exports-facet-table.tsx}` | NEW |
| `plugin-view/core/types.ts` | EDIT — add `facets` to `PluginNode` |
| `plugin-view/server/internal/tree-handler.ts` | EDIT — pass `facets` through `toApiNode` |
| `…/checks/plugins/no-hardcoded-colors/check/index.ts` | EDIT — allowlist render-detail components |

Reuse (do not reinvent): `defineFacetTable`/`PluginChip` (`catalog/web`), `Section`/`PluginViewSlots`/
`PluginNode` (`plugin-view/web`), `getFacet`/`exportsFacetDef`/`ExportsData` (facets + exports core),
`PluginChanges.DiffRenderer` (`plugin-changes/web`), `DataTable`/`ColumnDef`
(`primitives/plugins/data-table/web`), `Collapsible*` (`primitives/plugins/collapsible/web`).

## Conventions / gotchas

- **Registration is automatic.** New `web/index.ts` plugins are discovered by codegen during
  `./equin build`, which regenerates `web-sdk/core/web.generated.ts` (validated by the
  `plugins-registry-in-sync` check). No manual registry edit.
- **Barrel purity** (boundary check): each `web/index.ts` contains only imports + a single default
  `PluginDefinition`. Table column/row logic lives in `exports-facet-table.tsx`, not the barrel.
- **Cross-plugin imports** use runtime barrels only (`@plugins/<…>/web|core`). Edges introduced
  (render-diff→plugin-changes, render-detail→plugin-view, render-catalog→catalog, all→exports/core)
  are acyclic.
- Each new sub-plugin needs a `package.json` (mirror a sibling) and a `CLAUDE.md`
  (`plugins-have-claudemd` check); run `bun install` from repo root after adding them.
- `./equin build` also regenerates `docs/plugins-*.md` (the `plugins-doc-in-sync` check) —
  commit the regenerated docs.

## Implementation note — facets/core browser-safety (added during build)

render-diff is the first **web** code to transitively import `facets/core` (via
`exports/core` → `exportsFacetDef` → `defineFacet`). That barrel also re-exports build-time
`loadFacets`, whose dynamic `import("./facet.generated")` made vite eagerly bundle every
`facet/index.ts` → `parse-utils` (`fs`/`path`), breaking the web build. Fix applied in
`plugins/plugin-meta/plugins/facets/core/load-facets.ts`: hold the specifier in a variable
(`const generatedModule = "./facet.generated"; await import(generatedModule)`) so the bundler
cannot statically follow it. (`/* @vite-ignore */` does **not** work — esbuild's TS transform
strips the comment before vite's import-analysis runs.) `loadFacets` is build/server-only and
never executes in the browser, so the runtime import still resolves under bun.

This makes `facets/core` safe to import transitively from browser render slices, so **Phase 3
facets need no extra work** here. render-detail also reads `node.facets["exports"]` directly
(type-only facet imports) rather than via `getFacet`, keeping web fully decoupled from the
facet primitive at runtime.

## Verification

1. `bun install` (repo root) → `./equin build` succeeds (codegen + tsc green).
2. `./equin check` passes — specifically `typescript`, `plugin-boundaries`,
   `no-hardcoded-colors`, `plugins-registry-in-sync`, `plugins-doc-in-sync`,
   `plugins-have-claudemd`.
3. Contributions registered: after build, `docs/plugins-details.md` lists the exports sub-plugins
   contributing `PluginChanges.DiffRenderer "Exports"`, `PluginViewSlots.Section "Exports"`, and
   `Catalog.FacetTable "Exports"`.
4. Additive passthrough: `curl -s http://<worktree>.localhost:9000/api/plugin-view/tree | jq '.plugins[0] | has("facets")'` → `true` (value `{}` under `skipBarrelImport`, as expected).
5. No regressions: Forge detail pane and catalog render exactly as before (still empty for these
   facets — live data lands in Phase 4); existing diff/detail/catalog surfaces unaffected.

## Out of scope (later phases)

- Flipping `compute-plugin-diff.ts`, `catalog/web/index.ts`, and deleting `public-api` — **Phase 4**.
- Running facet extract/relate under `skipBarrelImport` (makes data live) — **Phase 4.1**.
- Replicating the slice for the other 8 facets + shared component extraction — **Phase 3**.
- The cross-surface completeness check — **Phase 5**.
