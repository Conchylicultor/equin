# Facets: Separate Data Extraction from Rendering (v2)

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

**Goal:** The `Facet` interface keeps `renderDoc` (docgen unchanged). Diff rendering
becomes a separate concern: facet sub-plugins contribute renderers via `web/` barrels.
Detail rendering is also separated into dedicated sub-plugins. Adding a facet
auto-updates all surfaces.

## Changes from v1

- **No `render-doc` sub-plugins** — `renderDoc` stays on the `Facet` interface. Docgen
  continues calling `facet.renderDoc()` as before. No `defineCollectedDir("doc-renderer")`.
- **`render-diff` uses `web/index.ts`** — standard web barrel contribution instead of
  a new `diffRenderer/` collected-dir zone. No new filesystem zones needed.

## Design Decisions

- **Consumers never import individual facet sub-plugins** — only the generic API from
  `@plugins/plugin-meta/plugins/facets/core`
- **Consumers never read `node.facets[<key>]` by name** — that's naming a specific facet
  in consumer code. Consumers iterate renderers generically. Only a facet's own
  sub-plugins may read their parent's data by facet ID.
- Each facet exposes structured data only (no rendering beyond `renderDoc`)
- Each rendering surface defines its own contribution point
- Facet sub-plugins contribute to the surfaces they support
- `Facet` interface: `{ def, extract, relate?, renderDoc }` — unchanged
- Structure: `facets/plugins/<name>/plugins/render-diff/`, `render-detail/`
- **Remove `routes.md`** — it reads compat fields directly and is a leak of facet
  internals into docgen

## Target Interfaces

### Facet (unchanged)

```ts
// facets/core/facets.ts — same as today
interface Facet {
  def: FacetDef<unknown>;
  extract: (ctx: ExtractContext) => unknown;
  relate?: (ctx: unknown) => void;
  renderDoc: (data: unknown, ctx: RenderDocContext) => DocFact[];
}
```

### DiffRenderer — owned by plugin-changes plugin

```ts
// plugins/review/plugins/plugin-changes/core/
interface DiffRenderer {
  facetId: string;
  label: string;                          // display name ("Slots", "Exports", ...)
  toComparable: (data: unknown) => string[];
}
```

Contributed via a web slot defined in `plugin-changes/web`:

```ts
export const DiffRendererSlot = defineContributionSlot<DiffRenderer>("PluginChanges.DiffRenderer");
```

Each `render-diff` sub-plugin registers via its `web/index.ts` barrel. Discovery is
automatic — iterating contributions at runtime. `compute-plugin-diff` on the server
sends raw facet data (both sides) to the client; the client runs `toComparable` and
`diffSets` using the contributed renderers.

### Detail rendering — owned by plugin-view plugin

No new interface — each render-detail sub-plugin contributes to `PluginViewSlots.Section`
using the existing slot pattern. The `PluginNode` API type changes from `publicApi?: PublicApi`
to `facets: Record<string, unknown>`.

### Ownership summary

| Surface | Owner plugin | Interface | Discovery |
|---------|-------------|-----------|-----------|
| Doc | `codegen` (via facets) | `facet.renderDoc()` | `loadFacets()` |
| Diff | `plugin-changes` | `DiffRenderer` | web slot contribution |
| Detail | `plugin-view` | existing slot | `PluginViewSlots.Section` |

## Target Structure (per facet)

Using exports as example:

```
facets/plugins/exports/
  core/                → ExportsData, exportsFacetDef (unchanged)
  facet/               → extract(), relate(), renderDoc() (unchanged)
  plugins/
    render-detail/
      web/index.ts            → contributes to PluginViewSlots.Section
      web/components/...      → category badges, consumer links, etc.
      package.json
    render-diff/
      web/index.ts            → contributes DiffRenderer (from plugin-changes web)
      package.json
```

Import directions:
- `render-diff` imports `DiffRendererSlot` from `@plugins/review/plugins/plugin-changes/web`
- `render-diff` imports `ExportsData` from `@plugins/plugin-meta/plugins/facets/plugins/exports/core` (parent)
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

The server sends raw `facets` data for both sides; the client computes diffs using
contributed `DiffRenderer`s. Or alternatively, if we keep server-side diff computation,
the `DiffRenderer.toComparable` must be importable server-side — in that case, move
the `toComparable` function to `core/` and have `web/index.ts` re-export with the label.

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

**1.1** Add `DiffRenderer` interface to plugin-changes core. Define
`DiffRendererSlot` in plugin-changes web barrel. Export from both barrels.

Files:
- NEW: `plugins/review/plugins/plugin-changes/core/diff-renderer.ts`
- EDIT: `plugins/review/plugins/plugin-changes/core/index.ts`
- EDIT: `plugins/review/plugins/plugin-changes/web/index.ts` (add slot definition)

Verify: `./equin build` succeeds.

### Phase 2: Reference Implementation (exports facet)

**2.1** Create `facets/plugins/exports/plugins/render-diff/` — extract `exportStrings()`
logic from `compute-plugin-diff.ts` (lines 50-58).

```
facets/plugins/exports/plugins/render-diff/
  web/index.ts   → contributes DiffRenderer { facetId: "exports", label: "Exports", toComparable }
  package.json
```

**2.2** Create `facets/plugins/exports/plugins/render-detail/` — move `RuntimeGroup`,
`SymbolRow`, `CATEGORY_STYLES`, `categorize()` from `public-api-section.tsx` and
`tree-handler.ts`. Component reads `node.facets["exports"]` and casts to `ExportsData`.

**2.3** Verify: `./equin build`.

Files:
- NEW: `plugins/plugin-meta/plugins/facets/plugins/exports/plugins/render-diff/`
- NEW: `plugins/plugin-meta/plugins/facets/plugins/exports/plugins/render-detail/`

### Phase 3: Replicate for All Facets

Create render sub-plugins for remaining facets. All parallelizable.

#### render-diff (7 facets — from compute-plugin-diff.ts)

| Facet | Source function | Label |
|-------|---------------|-------|
| slots | `slotStrings()` lines 39-41 | "Slots" |
| contributions | `contributionStrings()` lines 43-48 | "Contributions" |
| cross-refs | `apiUseStrings()` lines 69-78 | "API Uses" |
| routes | `routeStrings()` lines 60-67 | "Routes" |
| resources | `resourceStrings()` lines 80-84 | "Resources" |
| db-schema | `tableStrings()` lines 86-88 | "Tables" |
| exports | `exportStrings()` lines 50-58 (done in Phase 2) | "Exports" |

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

**4.2** Migrate tree-handler: drop compat field reads, pass raw facet data.

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

**4.3** Remove `public-api` plugin — its functionality is now distributed across
render-detail sub-plugins.

File: DELETE `plugins/plugin-meta/plugins/plugin-view/plugins/public-api/`

**4.4** Migrate compute-plugin-diff to use contributed `DiffRenderer`s.

Either:
- (a) Server-side: import `DiffRenderer` contributions, iterate them generically
- (b) Client-side: server sends raw facet data for both sides, client computes diffs

Option (b) keeps the server stateless with respect to facet knowledge:

```ts
// server sends:
interface PluginChangeDiff {
  // structural fields unchanged
  currentFacets: Record<string, unknown>;
  mainFacets: Record<string, unknown>;
}

// client computes diffs using DiffRendererSlot contributions:
for (const renderer of diffRenderers) {
  const current = plugin.currentFacets[renderer.facetId];
  const main = plugin.mainFacets[renderer.facetId];
  facetDiffs[renderer.facetId] = {
    label: renderer.label,
    diff: diffSets(
      current ? renderer.toComparable(current) : [],
      main ? renderer.toComparable(main) : [],
    ),
  };
}
```

**4.5** Update `api-changes-section.tsx` to iterate `Object.entries(facetDiffs)`
dynamically instead of 7 hardcoded `<DiffSection>` calls.
Update `api-changes-summary.tsx` `totalDiffCount` / `hasDiffs` to use `Object.values`.

Files:
- `plugins/review/plugins/plugin-changes/core/protocol.ts`
- `plugins/review/plugins/plugin-changes/server/internal/compute-plugin-diff.ts`
- `plugins/review/plugins/plugin-changes/plugins/api-changes/web/components/api-changes-section.tsx`
- `plugins/review/plugins/plugin-changes/plugins/api-changes/web/components/api-changes-summary.tsx`

### Phase 5: Cleanup

**5.1** Remove `populateCompatFields()` and all legacy flat fields from the internal
`PluginNode` type: `exports`, `slots`, `commands`, `contributions`, `server`,
`central`, `webApiUses`, `coreApiUses`, `sharedApiUses`, `dbFiles`, `tables`,
`importedBy`, `slotContributors`, `endpointCallers`, `entityExtensions`, `extendedBy`,
`runtimeContributions`, `runtimeRegistrations`. Remove `RuntimeDetail` type.

**5.2** Remove compat type re-exports from `plugin-tree/core/index.ts` (`SlotDef`,
`CommandDef`, `RouteDef`, `ResourceDef`, etc. — only keep structural types).

**5.3** Remove `docs/routes.md` and its generation code (`renderRoutesDocFromTree`,
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

1. **Barrel import performance** — mitigated by NOT dropping `skipBarrelImport`. Instead,
   facets always run but static-only facets (7/9) work without barrel imports.

2. **Generated docs stability** — mitigated by byte-comparing output at each phase.
   `renderDoc` is unchanged on the `Facet` interface — doc rendering is unaffected.

3. **UI parity** — extract shared components (`SubHeading`, `PluginLink`, `ConsumerList`)
   before splitting `PublicApiSection`. Slot ordering controlled by plugin registration
   order (alphabetical from codegen).

4. **routes.md removal** — `renderRoutesDocFromTree` reads compat fields directly.
   Remove it entirely rather than migrating — it violates the facet opacity rule.

5. **Client-side diff computation** — facet data payloads must be serializable (they
   already are — extracted from static file analysis). Payload size is negligible
   (metadata strings, not file contents).
