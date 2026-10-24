# Forge Catalog: Structure-Anomaly Facet

## Context

The Forge plugin **detail** pane already flags per-plugin structure anomalies — non-standard sub-folders, stray top-level `.ts`/`.tsx` files, and self-declared composition roots — via the `structure` Section sub-plugin that landed in Facets v3 Phase 7 (`research/2026-06-08-facets-v3-phase7-generic-plugin-discovery.md`). But there is **no repo-wide aggregate**: an engineer cannot see, at a glance, every plugin in the repo that has a non-standard folder or loose file.

This adds that aggregate as a new **"Structure" tab in the Forge catalog** (`Forge → Catalog`), one row per plugin-with-anomalies, clicking a row opens that plugin's detail pane.

### Why a facet (not a bespoke table)

The catalog tab strip is rendered purely from `Catalog.FacetTable.useContributions()`; the host slices `node.facets[facetId]` and stays **facet-blind**. The `facets:render-complete` check (`plugins/plugin-meta/plugins/facets/check/index.ts`) rejects any `Catalog.FacetTable` whose `facetId` isn't a registered facet (orphan). Therefore the only clean way to get an aggregate catalog table is to promote "structure" from ad-hoc `PluginNode` fields into a **real facet** — which also gives us PR-review diff rendering for free and keeps the existing detail section working (migrated). Single source of truth becomes `node.facets["structure"]`; the three redundant fields are removed from the plugin-view API `PluginNode` (decision confirmed with user).

### Decisive technical insight

`extract(ctx)` in the facet pipeline is **synchronous** (`plugin-tree.ts` does `const data = facet.extract(...)` with no `await`), but classifying folders needs `standardPluginDirs(repoRoot)` which is **async by signature only** — internally it does pure synchronous `readdirSync`/`readFileSync`/`existsSync`. So we resolve it **once at module load via top-level await** (`const STD = await standardPluginDirs(...)`), and the sync `extract` closes over `STD`. `loadFacets()` awaits each facet module's loader, so `STD` is always ready before `extract` runs. **Zero facet-core (`ExtractContext`) changes.**

---

## Implementation

### A. New facet: `plugins/plugin-meta/plugins/facets/plugins/structure/`

Mirror the `db-schema` facet's sub-plugin layout (`core/`, `facet/`, `plugins/render-detail/`, `plugins/render-catalog/`, `plugins/render-diff/`).

**`core/types.ts`**
```ts
import { defineFacet } from "@plugins/plugin-meta/plugins/facets/core";

export interface StructureFacetData {
  folders: { name: string; standard: boolean }[];
  looseFiles: string[];
  compositionRoot: boolean;
}

export const structureFacetDef = defineFacet<StructureFacetData>("structure");
```

**`core/to-comparable.ts`** — diff projection (anomalies only; standard folders excluded)
```ts
import type { StructureFacetData } from "./types";

export function structureToComparable(data: StructureFacetData): string[] {
  const out: string[] = [];
  for (const f of data.folders) if (!f.standard) out.push(`folder:${f.name}`);
  for (const file of data.looseFiles) out.push(`loose:${file}`);
  if (data.compositionRoot) out.push("composition-root");
  return out;
}
```

**`core/index.ts`** — re-export `structureFacetDef`, `StructureFacetData` (type), `structureToComparable`.

**`facet/index.ts`** — lifts the classification logic verbatim from `tree-handler.ts` (`isIgnoredDir` denylist + folder/loose-file derivation) and the `compositionRoot` read from `plugin-tree.ts` (`package.json` `singularity.compositionRoot`):
```ts
import { readdirSync, type Dirent } from "fs";
import { dirname, join } from "path";
import { createFacet, type DocFact } from "@plugins/plugin-meta/plugins/facets/core";
import { standardPluginDirs } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/server";
import { readIfExists } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { type StructureFacetData, structureFacetDef } from "../core";

// async by signature only — resolves synchronously; safe at module load.
const STD = await standardPluginDirs(dirname(PLUGINS_DIR));

function readEntries(dir: string): Dirent[] {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function isIgnoredDir(name: string): boolean {
  return name === "node_modules" || name.startsWith(".") || name.startsWith("dist");
}
function readCompositionRoot(dir: string): boolean {
  const src = readIfExists(join(dir, "package.json"));
  if (!src) return false;
  try { return JSON.parse(src).singularity?.compositionRoot === true; }
  catch { return false; }
}

export default createFacet<StructureFacetData>({
  def: structureFacetDef,
  extract(ctx) {
    const entries = readEntries(ctx.dir);
    const folders = entries
      .filter((e) => e.isDirectory() && !isIgnoredDir(e.name))
      .map((e) => ({ name: e.name, standard: STD.has(e.name) }));
    const looseFiles = entries
      .filter((e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx")))
      .map((e) => e.name);
    return { folders, looseFiles, compositionRoot: readCompositionRoot(ctx.dir) };
  },
  renderDoc(data) {
    const facts: DocFact[] = [];
    const nonStandard = data.folders.filter((f) => !f.standard);
    if (nonStandard.length) facts.push({ folder: "structure", key: "Non-standard folders", values: nonStandard.map((f) => `\`${f.name}/\``) });
    if (data.looseFiles.length) facts.push({ folder: "structure", key: "Loose top-level files", values: data.looseFiles.map((f) => `\`${f}\``) });
    if (data.compositionRoot) facts.push({ folder: "structure", key: "Composition root", values: ["yes"] });
    return facts;
  },
});
```
No `relate` (purely per-plugin, like `commands`).

**`plugins/render-detail/web/`** — migrates the existing `StructureSection`, reading `node.facets["structure"]` instead of the flat fields. Section `id` must equal `"structure"`.
- `index.ts`: `PluginViewSlots.Section({ id: "structure", label: "Structure", component: StructureDetailSection })`
- `components/structure-detail-section.tsx`: same JSX as today's `structure-section.tsx` (info Badge for composition root, warning Badges for non-standard folders + loose files, `null` when no anomalies), but data from `node.facets?.["structure"] as StructureFacetData | undefined`. Type-only import from the facet `core` (erased — does not pull build-time code into the browser bundle).

**`plugins/render-catalog/web/`** — the new aggregate table.
- `index.ts`: `Catalog.FacetTable(structureFacetTable)`
- `structure-facet-table.tsx`: `defineFacetTable<StructureRow>({ facetId: "structure", label: "Structure", icon: MdRuleFolder, columns, rows, rowKey, onRowClick })`. Columns: **Plugin** (`<PluginChip hierarchyId=… />`, `width: "flex-1 min-w-0"`), **Non-standard folders**, **Loose files**, **Composition root**. `rows(entries)` filters to plugins with ≥1 anomaly (`continue` otherwise → clean plugins never appear; tab badge = count). `rowKey: (r) => r.plugin.hierarchyId`. Row click opens the plugin detail pane (verified export):
  ```ts
  onRowClick: (r, { openPane }) =>
    openPane(pluginViewPane, { pluginId: r.plugin.hierarchyId }, { mode: "push" }),
  ```
  Imports: `defineFacetTable`, `FacetTableEntry`, `PluginChip` from the catalog web barrel; `ColumnDef` from data-table web; `PluginNode` from plugin-view core; `pluginViewPane` from plugin-view web; `StructureFacetData` (type) from the facet core.

**`plugins/render-diff/web/index.ts`**
```ts
PluginChangesSlots.DiffRenderer({
  facetId: "structure",
  label: "Structure",
  toComparable: (data) => structureToComparable(data as StructureFacetData),
})
```

**`package.json` + `CLAUDE.md`** for each new plugin dir, mirroring db-schema's render-* sub-plugins (`name: "@singularity/plugin-plugin-meta-facets-structure[-render-*]"`, `private: true`, root-level `description`). Docgen regenerates the reference block in each `CLAUDE.md`.

### B. Remove the redundant API `PluginNode` fields (single source = facet)

- `plugins/plugin-meta/plugins/plugin-view/core/types.ts` — drop `compositionRoot`, `folders`, `looseFiles` from the `PluginNode` interface (keep `facets`).
- `plugins/plugin-meta/plugins/plugin-view/core/endpoints.ts` — drop those three keys from `pluginNodeSchema` (zod).
- `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` — remove the `standardPluginDirs`/`dirname`/`readEntries`/`isIgnoredDir` imports+helpers, the `std` await, the `folders`/`looseFiles` derivation, and the three fields from the returned object. `node.facets` is already passed through.
- `plugins/config_v2/plugins/settings/web/components/config-nav.tsx` — remove `compositionRoot: false`, `folders: []`, `looseFiles: []` from the synthetic node literal (keep `facets: {}`).
- **Delete** `plugins/plugin-meta/plugins/plugin-view/plugins/structure/` entirely (migrated into the facet's `render-detail`). Same `id: "structure"`, no collision since old is removed and new is added in the same change set.

> The boundary checker reads `compositionRoot` from **plugin-tree's own internal `PluginNode`** (`plugin-tree/core`), a different type — untouched. Do **not** modify `plugin-tree/core`.

### C. No catalog host change

`catalog-view.tsx` is facet-blind — zero edits. `facet.generated.ts` auto-regenerates on build to include `structure`.

---

## Critical files

- `plugins/plugin-meta/plugins/facets/plugins/structure/facet/index.ts` *(new — extract + TLA std-set + renderDoc)*
- `plugins/plugin-meta/plugins/facets/plugins/structure/plugins/render-catalog/web/structure-facet-table.tsx` *(new — aggregate table)*
- `plugins/plugin-meta/plugins/facets/plugins/structure/plugins/render-detail/web/components/structure-detail-section.tsx` *(migrated)*
- `plugins/plugin-meta/plugins/facets/plugins/structure/plugins/render-diff/web/index.ts` *(new)*
- `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` *(strip structure computation)*
- `plugins/plugin-meta/plugins/plugin-view/core/{types,endpoints}.ts` *(drop 3 fields + zod)*
- `plugins/config_v2/plugins/settings/web/components/config-nav.tsx` *(synthetic node fix)*
- `plugins/plugin-meta/plugins/plugin-view/plugins/structure/` *(delete)*

Reference to mirror: `plugins/plugin-meta/plugins/facets/plugins/db-schema/` (full trio + onRowClick), `commands` facet (simplest extract/renderDoc).

---

## Verification

1. `./equin build` — regenerates `facet.generated.ts` (adds `structure`), barrels, registry, docs. Confirm no boundary error on the facet's `paths/server` + `codegen/core` imports (**main risk** — see below).
2. `./equin check facets:render-complete` — must pass (all three surfaces present for `structure`).
3. `./equin check` — full suite; `plugins-doc-in-sync`, `plugins-registry-in-sync`, boundary check, typecheck. Doc diffs from the new `renderDoc` + deleted plugin are expected (regenerated by build).
4. Screenshot `Forge → Catalog → Structure` tab (via `e2e/screenshot.mjs` clicking "Structure"): rows only for anomalous plugins, four columns, tab badge = count.
5. Click a Structure row → confirm it pushes the plugin detail pane and the migrated **Structure** section renders. Also open a composition-root plugin (an app SPA) directly and confirm its Structure section still shows.
6. (Optional) Open a review pane on a branch adding/removing a non-standard folder; confirm the Structure diff renderer lists the change.

## Risks

- **Boundary edges (primary):** the facet imports `@plugins/infra/plugins/paths/server` and `@plugins/framework/plugins/tooling/plugins/codegen/core` — new edges for a facet zone (db-schema's facet only imports `parse-utils`/`plugin-tree`). Both imports already exist legitimately in `plugin-view/server/tree-handler.ts`, and `facet/` is build-time/server-only, so risk is low. If the boundary check rejects an edge, adjust the boundary config to allow it (do **not** route around with a hack) — surface and confirm.
- **Top-level await in a facet:** first use in the codebase; `load-facets.ts` awaits each loader under `Promise.allSettled`, so it's tolerated. `standardPluginDirs` does no real async I/O, so no ordering/latency risk.
- **Docgen content change:** `renderDoc` adds "structure" facts to anomalous plugins' docs and the old structure plugin drops — both regenerated by build, reflected in `plugins-doc-in-sync`.
