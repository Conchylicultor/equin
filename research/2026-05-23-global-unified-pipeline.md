# Unified Pipeline: buildPluginTree always imports barrels

## Context

Step 4 of the [facet migration plan](2026-05-20-global-unified-facet-docgen.md). All 9 facets exist and extract/relate correctly, but the pipeline has two separate paths:

1. **`buildPluginTree()`** (sync) — `collectPlugin()` extracts all metadata via regex + `computeRelationships()` computes cross-plugin links → returns tree with monolithic fields populated
2. **`enrichPluginTreeDocs()`** (async) — imports barrels, extracts runtime contributions/registrations, runs facet extract+relate → populates `node.facets` and `runtimeContributions`/`runtimeRegistrations`

This creates redundancy (facets duplicate monolithic extraction) and forces callers to know which path they need. This refactor merges them into one async `buildPluginTree()` with a `skipBarrelImport` escape hatch for lightweight callers.

## Changes

### 1. Create `collectCoreFields()` in `plugin-tree.ts`

Slim replacement for `collectPlugin()`. Extracts only data derivable from reading barrel source files — no file walking, no cross-plugin analysis:

- `dir`, `path`, `name`, `parentDir` — from filesystem + relative path math
- `description`, `descriptions` — from barrel source `parseStringField`
- `loadBearing`, `collapsed` — from barrel source `parseBoolField`
- `runtimes` — from barrel file existence
- `contributions` (static `Contribution[]`) — from `extractContributionsBlock` on web barrel source (same source already read for description; kept here because the contributions facet handles runtime `DocMetaContribution[]`, not static `Contribution[]`)

All other monolithic fields (`exports`, `slots`, `commands`, `server`, `central`, `webApiUses`, etc.) initialized to empty defaults.

File: `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`

### 2. Update facet relate() to read from facets, not monolithic fields

Currently three facet `relate()` functions read from monolithic fields — they must switch to reading facet data before we can remove `collectPlugin()`/`computeRelationships()`.

**`exports.relate()`** (`plugins/plugin-meta/plugins/facets/plugins/exports/facet/index.ts`):
- Currently reads: `importer.server.apiUses`, `importer.central.apiUses`, `importer.webApiUses`, `importer.coreApiUses`, `importer.sharedApiUses`
- Change to: `getFacet(importer, crossRefsFacetDef)?.apiUses` for each runtime
- New import: `crossRefsFacetDef` from `@plugins/plugin-meta/plugins/facets/plugins/cross-refs/facet`

**`contributions.relate()`** (`plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts`):
- Currently reads: `node.slots` (monolithic field)
- Change to: `getFacet(node, slotsFacetDef)` from the slots facet
- New import: `slotsFacetDef` from `@plugins/plugin-meta/plugins/facets/plugins/slots/facet`

**`routes.relate()`** (`plugins/plugin-meta/plugins/facets/plugins/routes/facet/index.ts`):
- Currently writes to `node.endpointCallers` (monolithic field)
- Keep as-is for Step 4 — the compat shim skips `endpointCallers` since relate() already populates it
- Cleanup in Step 6: move `endpointCallers` into the routes facet data type

### 3. Refactor `buildPluginTree()` to async unified pipeline

```typescript
export async function buildPluginTree(
  pluginsRoot: string,
  opts?: { skipBarrelImport?: boolean },
): Promise<PluginTree>
```

Pipeline:

```
1. findAllPluginDirs(pluginsRoot)
2. collectCoreFields(dir, pluginsRoot) for each dir  →  byDir, parentDirs
3. IF !skipBarrelImport:
   a. registerBarrelStubs(resolve(pluginsRoot, ".."))
   b. Seed web-sdk core barrel (collectSlotDisplayNames is gone — not needed, facets handle it)
   c. Import all barrels (web → server → central) → importedModules map
   d. loadFacets() + facet.extract({ dir, importedModules }) + setFacet() per node
4. Assemble tree: parent resolution → children → sort → computeHierarchyIds
5. IF !skipBarrelImport:
   e. facet.relate({ tree }) for each facet
   f. populateCompatFields(tree) — backward-compat shim
6. Return { pluginsRoot, byDir, roots }
```

File: `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`

### 4. Write `populateCompatFields()` compat shim

Maps facet data → old monolithic fields so downstream consumers continue working unchanged. Runs after facet relate().

| Facet | Monolithic field(s) |
|-------|-------------------|
| `commands` | `node.commands` |
| `slots` | `node.slots` |
| `exports` | `node.exports` — map `ExportedSymbol[]` → `BarrelExport[]` (drop `consumers`) |
| `routes` | `node.server.httpRoutes`, `node.server.wsRoutes`, `node.central.httpRoutes`, `node.central.wsRoutes` — filter by `runtime` + `type` |
| `resources` | `node.server.resources`, `node.central.resources` |
| `cross-refs` | `node.server.apiUses`, `node.central.apiUses`, `node.webApiUses`, `node.coreApiUses`, `node.sharedApiUses`, `node.importedBy` |
| `db-schema` | `node.dbFiles`, `node.tables`, `node.entityExtensions`, `node.extendedBy` |
| `contributions` | `node.runtimeContributions` |
| `registrations` | `node.runtimeRegistrations` |
| (computed) | `node.slotContributors` — compute from slots facet + `node.contributions` (static, from core fields) |
| `routes.relate()` | `node.endpointCallers` — already set by relate(), shim skips |

Import all facet def tokens: `commandsFacetDef`, `slotsFacetDef`, `exportsFacetDef`, `routesFacetDef`, `resourcesFacetDef`, `crossRefsFacetDef`, `dbSchemaFacetDef`, `contributionsFacetDef`, `registrationsFacetDef`.

File: `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`

### 5. Remove dead code from `plugin-tree.ts`

Functions to delete:
- `collectPlugin()` (~180 lines) — replaced by `collectCoreFields()` + facets
- `computeRelationships()` (~120 lines) — replaced by facet relate() + compat shim
- `enrichPluginTreeDocs()` (~110 lines) — merged into `buildPluginTree()`
- `isSlotLike()`, `collectSlotDisplayNames()`, `extractComponentName()` — only used by enrichPluginTreeDocs Pass 1/2
- `parseRouteMap()` — only used by collectPlugin (routes facet has its own extraction)
- `parseServerApiUses()` — only used by collectPlugin (cross-refs facet has its own `parseApiUses`)

Functions/helpers that STAY (still used):
- `findAllPluginDirs()`, `computeHierarchyIds()` — used by buildPluginTree
- `readIfExists()`, `stripTypes()`, `matchBracket()`, `parseBarrelExports()`, `parseDefineGroup()`, `parseResources()`, `walkFiles()` — exported from barrel, used by facets
- `parseStringField()`, `parseBoolField()` — used by collectCoreFields
- `extractContributionsBlock()`, `findCalls()`, `parsePropsBlock()`, `parsePaneDefinitions()`, `parseImports()` — used by collectCoreFields for static contributions
- `findDbFiles()`, `parseTableNamesFromDbFiles()`, `parseEntityExtensionCalls()` — verify if db-schema facet imports these or has own copies; remove if dead

### 6. Update barrel (`plugin-tree/core/index.ts`)

- Remove `enrichPluginTreeDocs` from exports

### 7. Update all callers

Each caller adds `await` and makes its containing function async if not already.

| File | Change |
|------|--------|
| `codegen/core/docgen.ts` | `buildEnrichedTree()`: remove `enrichPluginTreeDocs()` call, just `await buildPluginTree(pluginsRoot)`. `collectAllPlugins()`: add `await`. Both become async. |
| `codegen/core/index.ts` | Re-exports flow through — `buildPluginTree` is now async, type updates automatically |
| `plugin-view/server/internal/tree-handler.ts` | Add `await` to `buildPluginTree()` call; handler should already be async |
| `review/plugin-changes/server/internal/compute-plugin-diff.ts` | Use `await Promise.all([buildPluginTree(worktreeDir), buildPluginTree(mainDir)])` |
| `codegen/core/plugin-registry-gen.ts` | Add `await` + `{ skipBarrelImport: true }` |
| `boundaries/core/check.ts` | Add `await` + `{ skipBarrelImport: true }` |
| `checks/plugins/plugin-boundaries/check/index.ts` | Add `await` + `{ skipBarrelImport: true }` |
| `checks/plugins/no-reexport-default/check/index.ts` | Add `await` + `{ skipBarrelImport: true }` |
| `checks/plugins/plugins-have-claudemd/check/index.ts` | Add `await` + `{ skipBarrelImport: true }` |
| `checks/core/scripts/fix-shared-to-relative.ts` | Add `await` + `{ skipBarrelImport: true }` |

### 8. Update CLAUDE.md references

- `plugins/plugin-meta/plugins/facets/CLAUDE.md` — references `enrichPluginTreeDocs()` in "Adding a facet" section; update to reference `buildPluginTree()`
- `plugins/plugin-meta/plugins/facets/plugins/contributions/CLAUDE.md` — references "Pass 1 of enrichPluginTreeDocs()"; update
- `plugins/plugin-meta/plugins/facets/plugins/exports/CLAUDE.md` — references monolithic fields; update
- `plugins/plugin-meta/plugins/facets/plugins/routes/CLAUDE.md` — references monolithic pass; update
- `plugins/plugin-meta/plugins/facets/plugins/cross-refs/CLAUDE.md` — references dual-write; update

## Order of execution

1. Update facet relate() functions (step 2) — must happen first so facets don't depend on monolithic fields
2. Create `collectCoreFields()` + `populateCompatFields()` (steps 1, 4)
3. Rewrite `buildPluginTree()` (step 3) — swap to the new pipeline
4. Remove dead code (step 5) — delete old functions
5. Update barrel (step 6)
6. Update all callers (step 7)
7. Update CLAUDE.md files (step 8)
8. Verify (below)

## Key files

| File | Role |
|------|------|
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Primary refactor target (~1100 lines) |
| `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` | Barrel — remove enrichPluginTreeDocs |
| `plugins/plugin-meta/plugins/facets/plugins/exports/facet/index.ts` | relate() reads cross-refs facet |
| `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts` | relate() reads slots facet |
| `plugins/plugin-meta/plugins/facets/plugins/routes/facet/index.ts` | relate() writes endpointCallers (keep as-is) |
| `plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts` | Remove enrichPluginTreeDocs call |
| All 6 check/boundary callers | Add await + skipBarrelImport where appropriate |

## Verification

1. `./equin build` succeeds
2. `diff` on `docs/plugins-compact.md`, `docs/plugins-details.md`, `docs/routes.md` — must be empty (modulo the new facet plugin entries for any new code)
3. Spot-check 2-3 per-plugin `CLAUDE.md` files for identical autogen blocks
4. `./equin check` passes all checks
5. Compare `GET /api/plugin-view/tree` JSON before/after (tree-handler uses all monolithic fields)

## Risks

| Risk | Mitigation |
|------|-----------|
| Static `Contribution[]` not in a facet — `slotContributors` computed in compat shim rather than in a facet relate() | Acceptable for Step 4; Step 6 will move static contributions into the contributions facet |
| `routes.relate()` still writes to monolithic `node.endpointCallers` | Acceptable for Step 4; Step 6 will move endpointCallers into routes facet data |
| 2-3s barrel import overhead for callers that previously used sync-only path (tree-handler, compute-plugin-diff) | Modules cached by Bun after first import — subsequent calls fast |
| Making buildPluginTree async is a breaking API change | All callers enumerated and updated; TypeScript will catch missed `await`s |
| db-schema facet may import helpers from plugin-tree that we plan to remove | Verify before deleting — keep helpers if facets import them |
