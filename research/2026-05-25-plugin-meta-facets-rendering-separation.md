# Facets: Separate Data Extraction from Rendering

## Context

The facet system (`plugins/plugin-meta/plugins/facets/`) bundles metadata extraction
AND rendering into a single `Facet` interface (`renderDoc` method). Three consumers
read facet data:

1. **docgen** — calls `facet.renderDoc()` for markdown docs. Also reads compat fields
   directly for `routes.md` (`p.server.httpRoutes` etc.)
2. **tree-handler** — reads compat fields for the Forge plugin-view UI (all empty
   because `skipBarrelImport: true` skips the entire facet pipeline)
3. **compute-plugin-diff** — reads compat fields for PR diffs (same bug — all empty)

The legacy compat shim (`populateCompatFields`) copies facet data into 20+ flat fields
on `PluginNode`. Consumers 2 and 3 use these fields but never get data because the
facet pipeline doesn't run.

**Goal:** The `Facet` interface becomes a pure data pipeline (extract + relate). Each
rendering surface is a separate concern: facet sub-plugins contribute renderers to
surface-defined contribution points. Adding a facet auto-updates all surfaces.

## Design Decisions

- **Consumers never import individual facet sub-plugins** — only the generic API from
  `@plugins/plugin-meta/plugins/facets/core`
- **Consumers never read `node.facets[<key>]` by name** — that's naming a specific facet
  in consumer code. Consumers iterate renderers generically. Only a facet's own
  sub-plugins may read their parent's data by facet ID.
- Each facet exposes structured data only (no rendering)
- Each rendering surface defines its own contribution point
- Facet sub-plugins contribute to the surfaces they support
- `Facet` interface: `{ def, extract, relate }` — `renderDoc` removed
- Structure: `facets/plugins/<name>/plugins/render-doc/`, `render-detail/`, `render-diff/`
- **Remove `routes.md`** — it reads compat fields directly and is a leak of facet
  internals into docgen

## Target Interfaces

### Facet (slimmed)

```ts
// facets/core/facets.ts — the ONLY thing facets core exports for rendering
interface Facet<T = unknown> {
  def: FacetDef<T>;
  extract: (ctx: ExtractContext) => T;
  relate?: (ctx: unknown) => void;
}
```

`DocFact`, `RenderDocContext`, and all rendering types move OUT of facets core.
Facets core exports only: `Facet`, `FacetDef`, `ExtractContext`, `createFacet`,
`defineFacet`, `getFacet`, `setFacet`, `loadFacets`.

### DocRenderer — owned by codegen plugin

```ts
// plugins/framework/plugins/tooling/plugins/codegen/core/
interface DocRenderer {
  facetId: string;
  render: (data: unknown, ctx: RenderDocContext) => DocFact[];
}
```

`defineCollectedDir("doc-renderer")` defined in codegen core. Generated file:
`codegen/core/doc-renderer.generated.ts`. Loaded by `loadDocRenderers()` in codegen core.
`DocFact` and `RenderDocContext` types move here from facets core.

### DiffRenderer — owned by plugin-changes plugin

```ts
// plugins/review/plugins/plugin-changes/core/
interface DiffRenderer {
  facetId: string;
  label: string;                          // display name ("Slots", "Exports", ...)
  toComparable: (data: unknown) => string[];
}
```

`defineCollectedDir("diff-renderer")` defined in plugin-changes core. Generated file:
`plugin-changes/core/diff-renderer.generated.ts`. Loaded by `loadDiffRenderers()` in
plugin-changes core.

### Detail rendering — owned by plugin-view plugin

No new interface — each render-detail sub-plugin contributes to `PluginViewSlots.Section`
using the existing slot pattern. The `PluginNode` API type changes from `publicApi?: PublicApi`
to `facets: Record<string, unknown>`.

### Ownership summary

| Surface | Owner plugin | Interface | CollectedDir | Discovery |
|---------|-------------|-----------|-------------|-----------|
| Doc | `codegen` | `DocRenderer` | `"doc-renderer"` | `loadDocRenderers()` |
| Diff | `plugin-changes` | `DiffRenderer` | `"diff-renderer"` | `loadDiffRenderers()` |
| Detail | `plugin-view` | existing slot | N/A | `PluginViewSlots.Section` |

## Target Structure (per facet)

Using exports as example:

```
facets/plugins/exports/
  core/                → ExportsData, exportsFacetDef (unchanged)
  facet/               → extract(), relate() (renderDoc removed)
  plugins/
    render-doc/
      doc-renderer/index.ts   → satisfies DocRenderer (from codegen core)
      package.json
    render-detail/
      web/index.ts            → contributes to PluginViewSlots.Section
      web/components/...      → category badges, consumer links, etc.
      package.json
    render-diff/
      diff-renderer/index.ts  → satisfies DiffRenderer (from plugin-changes core)
      package.json
```

Import directions:
- `render-doc` imports `DocRenderer` from `@plugins/framework/plugins/tooling/plugins/codegen/core`
- `render-doc` imports `ExportsData` from `@plugins/plugin-meta/plugins/facets/plugins/exports/core` (parent)
- `render-diff` imports `DiffRenderer` from `@plugins/review/plugins/plugin-changes/core`
- `render-detail` imports `PluginViewSlots` from `@plugins/plugin-meta/plugins/plugin-view/web`

## PluginNode API Type Change

```ts
// plugins/plugin-meta/plugins/plugin-view/core/types.ts
interface PluginNode {
  path: string;
  name: string;
  hierarchyId: string;
  description?: string;
  loadBearing: boolean;
  collapsed: boolean;
  runtimes: { web: boolean; server: boolean; central: boolean };
  children: PluginNode[];
  facets: Record<string, unknown>;  // replaces publicApi?: PublicApi
}
```

`PublicApi` and all sub-types (`SlotInfo`, `RouteInfo`, `BarrelExport`, etc.) removed.

## PluginChangeDiff Protocol Change

```ts
// plugins/review/plugins/plugin-changes/core/protocol.ts
interface PluginChangeDiff {
  // structural fields unchanged
  facetDiffs: Record<string, DiffList>;  // replaces 7 hardcoded aspect fields
}
```

## buildPluginTree Change

Currently facets only run when `skipBarrelImport` is false (lines 300-351 of
`plugin-tree.ts`). Restructure so facet extract/relate always run:

```ts
// 4a: barrel import (only when not skipped)
if (!opts?.skipBarrelImport) { /* existing barrel import code */ }

// 4b: always run facet extract
const facets = await loadFacets();
tree.facets = facets;
for (const node of byDir.values()) {
  const nodeModules = importedModules.get(node.dir) ?? [];
  for (const facet of facets) {
    setFacet(node, facet.def, facet.extract({ dir: node.dir, importedModules: nodeModules }));
  }
}

// 4c: always run facet relate
for (const facet of facets) { if (facet.relate) facet.relate({ tree }); }

// 4d: compat shim (removed in final phase)
if (!opts?.skipBarrelImport) { populateCompatFields(tree); }
```

7 of 9 facets are static-only and work without barrel imports. Only `contributions`
(runtime part) and `registrations` produce partial data, which is acceptable.

---

## Migration Phases

### Phase 1: Infrastructure

**1.1** Slim the `Facet` interface: make `renderDoc` optional. Update `isFacet()` guard
in `load-facets.ts` to not require it. Move `DocFact` and `RenderDocContext` types
to codegen core (keep a re-export in facets core temporarily for backward compat
during migration).

Files:
- EDIT: `plugins/plugin-meta/plugins/facets/core/facets.ts`
- EDIT: `plugins/plugin-meta/plugins/facets/core/load-facets.ts`
- EDIT: `plugins/plugin-meta/plugins/facets/core/index.ts`

**1.2** Add `DocRenderer` interface and `defineCollectedDir("doc-renderer")` to
codegen core. Add `loadDocRenderers()` loader. Export from codegen barrel.

Files:
- NEW: `plugins/framework/plugins/tooling/plugins/codegen/core/doc-renderer.ts`
- NEW: `plugins/framework/plugins/tooling/plugins/codegen/core/load-doc-renderers.ts`
- EDIT: `plugins/framework/plugins/tooling/plugins/codegen/core/index.ts`

**1.3** Add `DiffRenderer` interface and `defineCollectedDir("diff-renderer")` to
plugin-changes core. Add `loadDiffRenderers()` loader. Export from plugin-changes barrel.

Files:
- NEW: `plugins/review/plugins/plugin-changes/core/diff-renderer.ts`
- NEW: `plugins/review/plugins/plugin-changes/core/load-diff-renderers.ts`
- EDIT: `plugins/review/plugins/plugin-changes/core/index.ts`

Verify: `./equin build` succeeds, generated `doc-renderer.generated.ts` (in
codegen core) and `diff-renderer.generated.ts` (in plugin-changes core) appear
(initially empty).

### Phase 2: Reference Implementation (exports facet)

**2.1** Create `facets/plugins/exports/plugins/render-doc/` — move `renderDoc` logic
from `facets/plugins/exports/facet/index.ts` (lines 80-93).

**2.2** Create `facets/plugins/exports/plugins/render-diff/` — extract `exportStrings()`
logic from `compute-plugin-diff.ts` (lines 50-58).

**2.3** Create `facets/plugins/exports/plugins/render-detail/` — move `RuntimeGroup`,
`SymbolRow`, `CATEGORY_STYLES`, `categorize()` from `public-api-section.tsx` and
`tree-handler.ts`. Component reads `node.facets["exports"]` and casts to `ExportsData`.

**2.4** Remove `renderDoc` from exports facet implementation.

**2.5** Verify: `./equin build`, check `doc-renderer.generated.ts` now contains
the exports entry.

Files (per sub-plugin: `doc-renderer/index.ts` + `package.json`):
- NEW: `plugins/plugin-meta/plugins/facets/plugins/exports/plugins/render-doc/`
- NEW: `plugins/plugin-meta/plugins/facets/plugins/exports/plugins/render-diff/`
- NEW: `plugins/plugin-meta/plugins/facets/plugins/exports/plugins/render-detail/`
- EDIT: `plugins/plugin-meta/plugins/facets/plugins/exports/facet/index.ts`

### Phase 3: Replicate for All Facets

Create render sub-plugins for remaining 8 facets. All parallelizable.

#### render-doc (8 facets)

| Facet | Source of renderDoc logic |
|-------|-------------------------|
| commands | `facets/plugins/commands/facet/index.ts` |
| contributions | `facets/plugins/contributions/facet/index.ts` |
| cross-refs | `facets/plugins/cross-refs/facet/index.ts` |
| db-schema | `facets/plugins/db-schema/facet/index.ts` |
| registrations | `facets/plugins/registrations/facet/index.ts` |
| resources | `facets/plugins/resources/facet/index.ts` |
| routes | `facets/plugins/routes/facet/index.ts` |
| slots | `facets/plugins/slots/facet/index.ts` |

#### render-diff (7 facets — from compute-plugin-diff.ts)

| Facet | Source function |
|-------|---------------|
| slots | `slotStrings()` lines 39-41 |
| contributions | `contributionStrings()` lines 43-48 |
| cross-refs | `apiUseStrings()` lines 69-78 |
| routes | `routeStrings()` lines 60-67 |
| resources | `resourceStrings()` lines 80-84 |
| db-schema | `tableStrings()` lines 86-88 |
| commands | new (not currently diffed) |

#### render-detail (web sections — from public-api-section.tsx)

| Facet | UI elements to move |
|-------|-------------------|
| exports | RuntimeGroup, SymbolRow, CATEGORY_STYLES (done in Phase 2) |
| cross-refs | ImportedByBanner |
| slots | SlotsGroup + contributor count |
| routes | RoutesGroup + METHOD_COLORS |
| resources | SubHeading + key/mode list |
| contributions | new (not currently in public-api section) |
| commands | new |
| db-schema | new |

Shared components (`SubHeading`, `PluginLink`, `ConsumerList`) must be extracted to a
shared location first — either `plugins/plugin-meta/plugins/plugin-view/web/components/`
or a new primitives plugin.

### Phase 4: Migrate Consumers

**4.1** Restructure `buildPluginTree` to always run facet extract/relate, even with
`skipBarrelImport: true` (see "buildPluginTree Change" above).

File: `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`

**4.2** Migrate docgen to use `loadDocRenderers()` instead of `facet.renderDoc()`.

```ts
// docgen.ts — renderPluginFacts
const docRenderers = await loadDocRenderers();
for (const renderer of docRenderers) {
  const data = p.facets[renderer.facetId];
  if (data != null) allFacts.push(...renderer.render(data, { root }));
}
```

Remove `renderRoutesDocFromTree` and `routes.md` generation entirely — it reads compat
fields directly, which violates the "no consumer reads facets by key" rule.

File: `plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts`

**4.3** Migrate tree-handler: drop compat field reads, pass raw facet data.

```ts
function toApiNode(node: TreePluginNode): PluginNode {
  return {
    path: node.path, name: node.name, hierarchyId: node.hierarchyId,
    description: node.description, loadBearing: node.loadBearing,
    collapsed: node.collapsed, runtimes: node.runtimes,
    children: node.children.map(toApiNode),
    facets: node.facets,
  };
}
```

Remove: `buildSymbolConsumers()`, `categorize()`, all compat field reads.

Files:
- `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts`
- `plugins/plugin-meta/plugins/plugin-view/core/types.ts` (PluginNode type change)

**4.4** Remove `public-api` plugin — its functionality is now distributed across
render-detail sub-plugins.

File: DELETE `plugins/plugin-meta/plugins/plugin-view/plugins/public-api/`

**4.5** Migrate compute-plugin-diff to use `loadDiffRenderers()`.

```ts
const diffRenderers = await loadDiffRenderers();
for (const renderer of diffRenderers) {
  diffs[renderer.facetId] = diffSets(
    currentData ? renderer.toComparable(currentData) : [],
    mainData ? renderer.toComparable(mainData) : [],
  );
}
```

**4.6** Update `PluginChangeDiff` protocol: hardcoded fields → `facetDiffs: Record<string, DiffList>`.
Update `api-changes-section.tsx` to iterate `Object.entries(plugin.facetDiffs)`.
Update `api-changes-summary.tsx` `totalDiffCount` / `hasDiffs` to use `Object.values`.

Files:
- `plugins/review/plugins/plugin-changes/core/protocol.ts`
- `plugins/review/plugins/plugin-changes/server/internal/compute-plugin-diff.ts`
- `plugins/review/plugins/plugin-changes/plugins/api-changes/web/components/api-changes-section.tsx`
- `plugins/review/plugins/plugin-changes/plugins/api-changes/web/components/api-changes-summary.tsx`

### Phase 5: Cleanup

**5.1** Remove `renderDoc` from `Facet` interface entirely (was made optional in Phase 1).
Update `createFacet` parameter type. Keep `DocFact` and `RenderDocContext` exports
(still used by `DocRenderer`).

**5.2** Remove `populateCompatFields()` and all legacy flat fields from the internal
`PluginNode` type: `exports`, `slots`, `commands`, `contributions`, `server`,
`central`, `webApiUses`, `coreApiUses`, `sharedApiUses`, `dbFiles`, `tables`,
`importedBy`, `slotContributors`, `endpointCallers`, `entityExtensions`, `extendedBy`,
`runtimeContributions`, `runtimeRegistrations`. Remove `RuntimeDetail` type.

**5.3** Remove compat type re-exports from `plugin-tree/core/index.ts` (`SlotDef`,
`CommandDef`, `RouteDef`, `ResourceDef`, etc. — only keep structural types).

**5.4** Remove `docs/routes.md` and its generation code (`renderRoutesDocFromTree`,
`pluginHasRoutesDeep`, `groupHttpRoutes`, `renderRoutesPluginTree`, `renderRoutesDoc`,
`pluginRoutesDocPath`). Remove references from any check that validates routes.md
is in sync.

Files:
- `plugins/plugin-meta/plugins/facets/core/facets.ts`
- `plugins/plugin-meta/plugins/facets/core/load-facets.ts`
- `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`
- `plugins/plugin-meta/plugins/plugin-tree/core/index.ts`

---

## Verification

After each phase:
- `./equin build` succeeds
- `./equin check` passes

After Phase 4:
- Byte-compare `docs/plugins-details.md`, `docs/plugins-compact.md`
  before and after — must be identical
- Plugin-view UI shows the same data (screenshot before/after)
- PR diff view works (now with actual data instead of empty arrays)

After Phase 5:
- `./equin check --plugin-boundaries` passes
- No remaining imports of compat field types
- `rg "populateCompatFields|\.server\.httpRoutes|\.webApiUses"` returns no hits

## Risks

1. **CollectedDir recursive scanning** — verified: `collectEntries()` walks ALL nodes
   in `tree.byDir.values()`, not just direct children. Sub-sub-plugin discovery works.

2. **Barrel import performance** — mitigated by NOT dropping `skipBarrelImport`. Instead,
   facets always run but static-only facets (7/9) work without barrel imports.

3. **Generated docs stability** — mitigated by byte-comparing output at each phase.
   DocRenderer `render` functions are direct copies of removed `renderDoc` methods.

4. **UI parity** — extract shared components (`SubHeading`, `PluginLink`, `ConsumerList`)
   before splitting `PublicApiSection`. Slot ordering controlled by plugin registration
   order (alphabetical from codegen).

5. **routes.md removal** — `renderRoutesDocFromTree` reads compat fields directly.
   Remove it entirely rather than migrating — it violates the facet opacity rule.
