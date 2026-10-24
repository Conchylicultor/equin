# Decouple plugin-tree from facets

## Context

The plugin-meta system has two layers: **plugin-tree** (builds `PluginTree` from disk) and **facets** (9 sub-plugins extracting domain metadata). Currently plugin-tree defines ~13 domain types and domain-specific parsing helpers that should live in facets. `PluginNode` has ~20 monolithic fields alongside a `facets: Record<string, unknown>` bag, with `populateCompatFields()` copying facet data back into flat fields.

**Target**: plugin-tree is pure plumbing (find dirs, build tree, invoke facet lifecycle). Each facet owns its domain completely (types, extraction, relation, doc rendering). No import cycles.

The 3 external consumers of monolithic fields (docgen, tree-handler, compute-plugin-diff) are **not** migrated in this plan — that is Phase 5, deferred.

---

## Phase 1: Create `parse-utils` plugin

**Goal**: Canonical home for shared parsing helpers. No consumer changes.

### New plugin: `plugins/plugin-meta/plugins/parse-utils/core/index.ts`

Move from `plugin-tree/core/internal/plugin-tree.ts`:

| Function | Lines | Notes |
|---|---|---|
| `readIfExists` | 144–146 | Returns `string \| null`. Cross-refs facet has a local copy returning `string \| undefined`; unify to `null`. |
| `stripTypes` + `transpiler` const | 148–156 | |
| `matchBracket` | 171–191 | |
| `parseBarrelExports` | 325–366 | `BarrelExport` type (`{ name, kind }`) moves here too. |
| `walkFiles` | 368–384 | |
| `parseDefineGroup` | 193–215 | Shared by slots + commands facets. |
| `parseStringField` | 158–164 | Currently private — export it. |
| `parseBoolField` | 166–169 | Currently private — export it. |

**Edits:**
- `plugin-tree/core/internal/plugin-tree.ts`: remove moved functions, `import { ... } from "@plugins/plugin-meta/plugins/parse-utils/core"`
- `plugin-tree/core/index.ts`: re-export everything from parse-utils for backward compat
- `facets/plugins/cross-refs/facet/index.ts`: remove duplicate `walkFiles` (lines 22–38) and `readIfExists` (lines 40–46), import from parse-utils

### Files
- NEW: `plugins/plugin-meta/plugins/parse-utils/core/index.ts`
- NEW: `plugins/plugin-meta/plugins/parse-utils/package.json`
- EDIT: `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`
- EDIT: `plugins/plugin-meta/plugins/plugin-tree/core/index.ts`
- EDIT: `plugins/plugin-meta/plugins/facets/plugins/cross-refs/facet/index.ts`

---

## Phase 2: Move domain types into owning facets

**Goal**: Each facet gets a `core/index.ts` barrel exporting its domain types and `FacetDef` token. Plugin-tree re-exports for backward compat. Per-facet, parallelizable.

### Per-facet type migrations

| Facet | Types (from plugin-tree) | Also export |
|---|---|---|
| `slots` | `SlotDef` | `slotsFacetDef` |
| `commands` | `CommandDef` | `commandsFacetDef` |
| `routes` | `RouteDef` | `routesFacetDef` |
| `resources` | `ResourceDef` | `resourcesFacetDef`, `parseResources` (moved from plugin-tree, single-consumer) |
| `exports` | — (already has local `ExportsData`, `ExportedSymbol`) | `exportsFacetDef` |
| `db-schema` | `TableDef`, `EntityExtension`, `EntityExtensionRef` | `dbSchemaFacetDef` |
| `contributions` | `DocMetaContribution` | `contributionsFacetDef` |
| `registrations` | `DocMetaRegistration` | `registrationsFacetDef` |
| `cross-refs` | — (already has local `CrossRefsData`) | `crossRefsFacetDef` |

**What stays in plugin-tree**: `Runtime`, `RuntimeDetail` (compat shim shape), `PluginNode`, `PluginTree`, `Contribution` (static — moves in Phase 4).

Each facet's `facet/index.ts` switches imports to its own `core/` and to parse-utils. Plugin-tree's barrel re-exports all types from facet `core/` barrels.

### Files (per facet — 9 parallelizable units)
- NEW: `plugins/plugin-meta/plugins/facets/plugins/<name>/core/index.ts` (×9)
- EDIT: `plugins/plugin-meta/plugins/facets/plugins/<name>/facet/index.ts` (×9)
- EDIT: `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` (remove type defs + `parseResources`)
- EDIT: `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` (re-export from facet cores)

---

## Phase 3: Wire up topo-sort + typed cross-facet access

**Goal**: Replace raw `node.facets["x"]` casts with typed `getFacet()` calls; auto-detect dependency edges; enforce relate ordering.

### Step 3a: Typed cross-facet imports

**`contributions/facet/index.ts`** (line 56–57 raw cast → typed):
```ts
// Before: node.facets["slots"] as SlotDef[]
// After:
import { slotsFacetDef, type SlotDef } from "@plugins/.../slots/core";
const nodeSlots = getFacet(node, slotsFacetDef) ?? [];
```

**`exports/facet/index.ts`** (line 57 raw cast → typed):
```ts
// Before: importer.facets["cross-refs"] as { apiUses: ... }
// After:
import { crossRefsFacetDef, type CrossRefsData } from "@plugins/.../cross-refs/core";
const xrefs = getFacet(importer, crossRefsFacetDef);
```

These imports are from `/core` (boundary-legal). Codegen needs to detect them — see Step 3b.

### Step 3b: Enhance codegen dependency detection

In `plugin-registry-gen.ts`, `collectImportPaths()` (line 156) currently only matches `mod.endsWith(\`/${dir}\`)`. An import from `/core` of a sibling collected-dir plugin won't be detected.

**Fix**: instead of matching the trailing segment, match the plugin prefix. Build a `prefixSet` from entries (strip `/${dir}` suffix from each `e.importPath`). For each import, strip its trailing segment and check if the prefix is in the set.

```ts
// Before (line 156):
if (mod.startsWith("@plugins/") && mod.endsWith(`/${dir}`))

// After:
if (mod.startsWith("@plugins/")) {
  const prefix = mod.slice(0, mod.lastIndexOf("/"));
  if (entryPrefixes.has(prefix)) paths.add(prefix);
}
```

`buildDepsForDir()` resolves prefixes to `pluginPath` via the same map.

**Expected result** in `facet.generated.ts`:
- `contributions`: `dependsOn: ["plugin-meta/plugins/facets/plugins/slots"]`
- `exports`: `dependsOn: ["plugin-meta/plugins/facets/plugins/cross-refs"]`

### Step 3c: Topo-sort in `loadFacets()`

`facets/core/load-facets.ts` currently ignores `dependsOn`. Add an inline topo-sort (DFS, cycle detection, ~15 lines) operating on `CollectedEntry.pluginPath` strings. Apply before loading so the returned `Facet[]` is in dependency order.

```ts
function topoSort(entries: CollectedEntry[]): CollectedEntry[] {
  const byPath = new Map(entries.map(e => [e.pluginPath, e]));
  const visited = new Set<string>();
  const stack = new Set<string>();
  const result: CollectedEntry[] = [];
  function visit(path: string) {
    if (visited.has(path)) return;
    if (stack.has(path))
      throw new Error(`Facet dependency cycle: ${[...stack, path].join(" → ")}`);
    stack.add(path);
    const entry = byPath.get(path);
    if (entry) for (const dep of entry.dependsOn) visit(dep);
    stack.delete(path);
    visited.add(path);
    if (entry) result.push(entry);
  }
  for (const e of entries) visit(e.pluginPath);
  return result;
}
```

`Promise.allSettled` still loads modules in parallel (fine); the sorted order determines iteration order in `buildPluginTree()` for `extract()` and `relate()`.

### Files
- EDIT: `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts`
- EDIT: `plugins/plugin-meta/plugins/facets/plugins/exports/facet/index.ts`
- EDIT: `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`
- EDIT: `plugins/plugin-meta/plugins/facets/core/load-facets.ts`

---

## Phase 4: Move static contribution parsing into contributions facet

**Goal**: plugin-tree's `collectCoreFields()` stops doing domain-specific work. The contributions facet owns both static source parsing and runtime barrel introspection.

### Step 4a: Move helpers to contributions facet

Move from `plugin-tree.ts` to `contributions/facet/internal/static-parse.ts`:

| Function | Lines | Depends on (from parse-utils) |
|---|---|---|
| `extractContributionsBlock` | 240–247 | `matchBracket` |
| `findCalls` | 249–261 | `matchBracket` |
| `parsePropsBlock` | 263–323 | `matchBracket` |
| `parseImports` | 217–238 | (standalone) |
| `parsePaneDefinitions` | 386–409 | `walkFiles`, `readIfExists`, `matchBracket`, `parseStringField` |

Also move `PaneDefinition` interface and `ImportBinding` interface.

### Step 4b: Extend facet data shape

```ts
// contributions/core/index.ts
interface ContributionsFacetData {
  static: Contribution[];           // from source text parsing
  runtime: DocMetaContribution[];   // from barrel import introspection
}
```

`Contribution` type (`{ slot, props, paneId?, panePath? }`) moves from plugin-tree to `contributions/core/`.

The facet's `extract(ctx)` does both:
1. Static: read `ctx.dir + "/web/index.ts"`, strip types, call `extractContributionsBlock` → `findCalls` → `parsePropsBlock` (same logic as current `collectCoreFields`)
2. Runtime: read `ctx.importedModules` (existing code, produces `DocMetaContribution[]`)

### Step 4c: Move `slotContributors` into contributions `relate()`

Currently computed in `populateCompatFields()` (lines 783–806). Move into contributions `relate()` which already reads slots facet data. Write results directly to `node.slotContributors` (field still on `PluginNode` until Phase 5).

### Step 4d: Update plugin-tree

- Rename `collectCoreFields()` → `collectStructuralFields()`. Remove all contribution parsing. Keep only: `description`, `descriptions`, `loadBearing`, `collapsed`, `runtimes`, parent resolution.
- Update `populateCompatFields()`: read new facet shape (`{ static, runtime }` instead of `DocMetaContribution[]`), remove `slotContributors` computation block.
- Remove moved helper functions and the `Contribution` type.

### Files
- NEW: `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/internal/static-parse.ts`
- EDIT: `plugins/plugin-meta/plugins/facets/plugins/contributions/core/index.ts` (export `Contribution`, update `ContributionsFacetData`)
- EDIT: `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts` (extend extract + relate)
- EDIT: `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` (strip contribution logic, rename function, update compat shim)
- EDIT: `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` (re-export `Contribution` from contributions/core)

---

## Deferred: Phase 5

- Migrate 3 external consumers to `getFacet()` (docgen, tree-handler, compute-plugin-diff)
- Remove monolithic fields from `PluginNode`
- Dissolve `RuntimeDetail`
- Delete `populateCompatFields()`
- Remove type re-exports from plugin-tree barrel

---

## Verification (after each phase)

1. `./equin build` succeeds
2. `./equin check` passes (especially `plugin-boundaries`, `plugins-registry-in-sync`, `eslint`)
3. Docgen output files identical before/after:
   - `docs/plugins-details.md`, `docs/plugins-compact.md`, `docs/routes.md`
   - Spot-check per-plugin `CLAUDE.md` for plugins with known contributions
4. After Phase 3: inspect `facet.generated.ts` for correct `dependsOn` edges
5. After Phase 3: reorder entries in `facet.generated.ts` to break alphabetical order → output still correct (topo-sort fixes ordering)
6. After Phase 4: `node.contributions` and `node.slotContributors` match pre-migration values
