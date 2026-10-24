# Unified Facet-Based Plugin Docgen & Catalog

## Context

Plugin metadata is extracted and rendered by two divergent systems that share the same raw data (`buildPluginTree`) but diverge into incompatible shapes:

- **Docgen** builds an enriched tree, renders markdown via hardcoded `renderPluginBody()`. Outputs `docs/plugins-compact.md`, `docs/plugins-details.md`, `docs/routes.md`, per-plugin `CLAUDE.md`.
- **Plugin-view UI** builds the same tree, transforms to a *different* `PluginNode` type via `toApiNode()`, adds `buildSymbolConsumers()`, serves over HTTP for the detail pane and catalog.

Adding new metadata requires touching ~5 files across both systems. The two `PluginNode` types drift apart. This plan unifies them via a **facet-based** architecture where each metadata type is self-contained.

## Target Architecture

### Lean PluginNode + Facet Bag

```typescript
interface PluginNode {
  dir: string; path: string; name: string; hierarchyId: string;
  description?: string; descriptions: Partial<Record<Runtime, string>>;
  loadBearing: boolean; collapsed: boolean;
  runtimes: Record<Runtime, boolean>;
  children: PluginNode[];
  facets: Record<string, unknown>;  // typed access via getFacet(node, def)
}
```

### Facet Definition

Facet primitives live in `facets/core` (`@plugins/plugin-meta/plugins/facets/core`):

```typescript
interface FacetDef<T> { id: string; _phantom?: T; }
function defineFacet<T>(id: string): FacetDef<T>;
function getFacet<T>(node: PluginNode, def: FacetDef<T>): T | undefined;
function setFacet<T>(node: PluginNode, def: FacetDef<T>, data: T): void;
```

### Each Facet Exports

Each facet sub-plugin lives under `plugins/plugin-meta/plugins/facets/plugins/<name>/` and exposes `facet/index.ts`:

```typescript
export const facetDef: FacetDef<MyData>;
export function extract(ctx: ExtractContext): MyData;
export function relate?(ctx: RelateContext): void;  // cross-plugin pass
export function renderDoc(data: MyData, ctx: DocContext): string[];
// UI component stays in the existing plugin-view sub-plugin
```

### Two-Phase Pipeline (replaces three)

Always import barrels (side-effect-free by rule, ~2-3s acceptable). No separate regex static phase.

```
findAllPluginDirs() → collectCoreFields() → importAllBarrels()
  → for each facet: extract(modules, dir)
  → assembleTree()
  → for each facet: relate(allNodes)
  → PluginTree
```

### Dependency Graph

```
barrel-import  (leaf — no cross-plugin deps)
     │
     ▼
facets/core ─────────── owns: Facet, FacetDef, defineFacet, getFacet, setFacet, loadFacets
     │
     ▼
plugin-tree/core ────── owns: PluginNode, type defs, parsing helpers, buildPluginTree, enrichPluginTreeDocs
     │                  imports from facets/core: setFacet, loadFacets
     │
     ├─────────────────────────────────────────────┐
     ▼                                             ▼
facets/plugins/*         ←── imports from      codegen/docgen.ts
  (facet sub-plugins)       plugin-tree/core:   plugin-view/server
                            parsing helpers,    plugin-changes/server
                            type defs           etc.
```

No cycles. `plugin-tree → facets/core` is one-way. `facets/plugins/* → plugin-tree/core` is a separate plugin pair.

### Wildcard Bun Stub

Replace the manual npm package stubs in `barrel-import/core/internal/stubs.ts` with a catch-all `build.onResolve` for `node_modules/` that returns an empty proxy module. Keep only the structurally required stubs (React, web-sdk/core, config/server, database/server).

## Facets

| Facet | Data | Current source | `relate()` computes |
|-------|------|----------------|-------------------|
| `exports` | Barrel exports by runtime, category, per-symbol consumers | `parseBarrelExports` + `buildSymbolConsumers` | `consumers[]` per symbol (inverts apiUses) |
| `slots` | defineSlot definitions + contributors | `parseDefineGroup("defineSlot")` | `contributors[]` per slot group |
| `commands` | defineCommand definitions | `parseDefineGroup("defineCommand")` | — |
| `contributions` | Static contributions + runtime DocMeta | `extractContributionsBlock` + `enrichPluginTreeDocs` | — |
| `routes` | HTTP/WS routes by runtime + callers | `parseRouteMap` | `callers[]` per route prefix |
| `resources` | defineResource calls | `parseResources` | — |
| `db-schema` | Tables, entity extensions, extendedBy | `findDbFiles` + `parseTableNames` + `parseEntityExtensionCalls` | `extendedBy[]` cross-refs |
| `cross-refs` | apiUses (all runtimes), importedBy | `parseServerApiUses` | `importedBy[]` (inverts apiUses) |
| `registrations` | Runtime register[] with DocMeta (MCP tools, jobs) | `enrichPluginTreeDocs` | — |

### Facet Inter-Dependencies During `relate()`

Some facets need data from other facets:
- `exports.relate()` needs `cross-refs` apiUses from all plugins to build per-symbol `consumers[]`
- `slots.relate()` needs `contributions` from all plugins to find slot contributors
- `routes.relate()` needs source files from all plugins to find endpoint callers

This means `relate()` receives the full tree and reads other facets via `getFacet()`. No ordering constraint needed — each facet reads already-extracted (Phase 1) data from other facets.

## File Structure

```
plugins/plugin-meta/plugins/facets/
  core/index.ts          — barrel: Facet/FacetDef primitives + loadFacets + collectedDir
  core/facets.ts         — Facet, FacetDef, defineFacet, getFacet, setFacet
  core/load-facets.ts    — loadFacets(): discovers and loads facet sub-plugins
  core/collected-dir.ts  — defineCollectedDir("facet")
  core/facet.generated.ts — auto-populated registry
  plugins/
    commands/facet/      — ✅ done (reference implementation)
    exports/facet/
    slots/facet/
    contributions/facet/
    routes/facet/
    resources/facet/
    db-schema/facet/
    cross-refs/facet/
    registrations/facet/
```

## Implementation Steps

Each step is one agent conversation. Every step must pass `./equin build` and produce byte-identical doc output until the final cleanup.

### Step 1: Foundation ✅ Done

**Completed.** Facet primitives (`defineFacet`, `getFacet`, `setFacet`, `Facet`, `FacetDef`) live in `facets/core`. `PluginNode.facets: Record<string, unknown>` initialized to `{}` in `collectPlugin`. Parsing helpers (`readIfExists`, `stripTypes`, `matchBracket`, `parseDefineGroup`) exported from `plugin-tree/core`. `facet` registered as a runtime zone in boundary checker, `findAllPluginDirs`, tsconfig, and lint config.

### Step 2: First Facet (commands) ✅ Done

**Completed.** Commands facet at `facets/plugins/commands/facet/index.ts` validates the full pattern: codegen discovery, `loadFacets()`, `extract()` per node via `setFacet()`, `relate()` loop. Dual-write: `collectPlugin()` still populates `node.commands`, facet independently populates `node.facets["commands"]`. Doc output byte-identical (docgen still reads `node.commands`).

See `research/2026-05-22-global-commands-facet-validation.md` for the detailed validation report.

### Step 3: Remaining Facets (exports, slots, contributions, routes, resources, db-schema, cross-refs, registrations)

**Goal**: All metadata lives in facets. Monolithic fields are now redundant (but still populated via dual-write).

- Create 8 remaining facet sub-plugins, each with `facet/index.ts`
- `exports` facet: move `parseBarrelExports` logic. `relate()` computes per-symbol `consumers[]` using `cross-refs` facet data.
- `slots` facet: reuse `parseDefineGroup("defineSlot")`. `relate()` computes `contributors` using `contributions` facet data.
- `contributions` facet: merges static parsing (`extractContributionsBlock`) + runtime enrichment from barrel imports. **Note**: `extract()` for this facet needs the imported barrel modules — the extract context must include `{ dir, importedModules }`.
- `routes` facet: move `parseRouteMap`. `relate()` computes `endpointCallers`.
- `resources` facet: move `parseResources`.
- `db-schema` facet: move `findDbFiles`, `parseTableNames`, `parseEntityExtensionCalls`. `relate()` computes `extendedBy` cross-refs.
- `cross-refs` facet: move `parseServerApiUses`. `relate()` computes `importedBy`.
- `registrations` facet: extracts from imported `mod.default.register[]`. Needs barrel modules in extract context.

**Extract context evolution**: The `commands` facet uses `{ dir: string }`. Facets that need barrel imports (`contributions`, `registrations`) will need `{ dir, importedModules }`. The typed `ExtractContext` should be formalized at this step — currently each facet casts from `unknown` internally.

**Verify**: Doc output byte-identical.

### Step 4: Unified Pipeline

**Goal**: `enrichPluginTreeDocs()` uses the faceted pipeline as its primary enrichment path. The hardcoded extraction in `collectPlugin()` becomes redundant.

- Refactor `enrichPluginTreeDocs()`: Pass 1 (barrel imports) stays. Pass 2 (contributions/registrations) is replaced by the facet extraction loop (already wired as Pass 3 — promote it). Pass 3 becomes the relate pass.
- Add `{ skipBarrelImport?: boolean }` escape hatch for callers that only need core fields (e.g. `plugin-registry-gen.ts`, `plugin-boundaries.ts` — they read only `dir`, `name`, `runtimes`, `path`)
- Backward-compat shim: populate old monolithic fields from facets (temporary)
- `buildEnrichedTree()` in `docgen.ts` continues to call `buildPluginTree()` then `enrichPluginTreeDocs()` — no change needed there.

**Callers of `buildPluginTree()` (all must still work)**:
- `docgen.ts` — uses enriched tree → works (enrichment includes facets)
- `tree-handler.ts` — reads all fields → works via compat shim
- `compute-plugin-diff.ts` — reads slots, contributions, exports, routes, apiUses, resources, tables → works via compat shim
- `plugin-registry-gen.ts` — reads only dir/name/runtimes → pass `skipBarrelImport: true`
- `plugin-boundaries.ts` — reads dir/path/runtimes + apiUses → needs cross-refs facet, or `skipBarrelImport` + keep apiUses parse in core
- `runner.ts`, `no-reexport-default.ts`, `plugins-have-claudemd.ts`, `plugins-doc-in-sync.ts` — lightweight consumers → verify each

**Verify**: All `./equin check` checks pass. Doc output identical.

### Step 5: Consumer Migration

**Goal**: All consumers read facets via `getFacet()`. No one reads old monolithic fields.

- `docgen.ts`: replace `renderPluginBody()` with a loop over `allFacets`, calling `facet.renderDoc(getFacet(node, facet.def), ctx)`
- `tree-handler.ts`: build the API `PluginNode` by reading facets. Delete `toApiNode()` and `buildSymbolConsumers()`.
- `compute-plugin-diff.ts`: read facets instead of `node.slots`, `node.exports`, etc.
- `config-origin-gen.ts`: read contributions facet instead of re-importing barrels

**Verify**: Doc output byte-identical. Plugin-view API JSON identical. `./equin build` passes.

### Step 6: Cleanup

**Goal**: Remove all dead code and the backward-compat shim.

- Remove old monolithic fields from `PluginNode` (exports, slots, commands, contributions, server, central, webApiUses, coreApiUses, sharedApiUses, dbFiles, tables, importedBy, slotContributors, endpointCallers, entityExtensions, extendedBy, runtimeContributions, runtimeRegistrations)
- Remove backward-compat shim from `enrichPluginTreeDocs()`
- Delete dead parsing helpers from `plugin-tree.ts` that were moved to facets
- Unify the API `PluginNode` type in `plugin-view/core/types.ts` — either import from `plugin-tree/core` or keep as a view model assembled from facets
- Remove stale type exports

**Verify**: Full build + all checks. No remaining references to old fields.

## Dependency Graph

```
Step 1 (foundation) ✅
  └─ Step 2 (commands facet) ✅
       └─ Step 3 (remaining 8 facets)
            └─ Step 4 (unified pipeline)
                 └─ Step 5 (consumer migration)
                      └─ Step 6 (cleanup)
```

## Key Files

| File | Role |
|------|------|
| `plugins/plugin-meta/plugins/facets/core/facets.ts` | Facet primitives (defineFacet, getFacet, setFacet) |
| `plugins/plugin-meta/plugins/facets/core/load-facets.ts` | Facet loader (loadFacets) |
| `plugins/plugin-meta/plugins/facets/core/facet.generated.ts` | Auto-populated facet registry |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Tree builder (~1100 lines, major refactor target) |
| `plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts` | Markdown rendering (renderPluginBody → facet loop) |
| `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` | API handler (toApiNode + buildSymbolConsumers → facet reads) |
| `plugins/plugin-meta/plugins/plugin-view/core/types.ts` | API PluginNode type (unify with core type) |
| `plugins/review/plugins/plugin-changes/server/internal/compute-plugin-diff.ts` | Diff consumer (reads slots, exports, routes, etc.) |
| `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts` | Config origin consumer |

## Risks

| Risk | Mitigation |
|------|-----------|
| Wildcard stub breaks a package needing structural fidelity | Keep React/web-sdk/config/database stubs explicit. Test all ~150 barrel imports. |
| Facet extract produces subtly different data than regex parsing | Byte-compare doc output at every step. |
| 2-3s import added to fast-path callers (checks, boundaries) | `skipBarrelImport` option for callers that only need core fields. |
| Facet inter-dependencies during relate() create ordering issues | All relate() runs after all extract() — facets read each other's Phase 1 data freely. |
| plugin-view UI depends on specific API PluginNode shape | Keep API shape stable through Step 5. Unify in Step 6. |
| New `collectedDir` runtime type needs infra registration | Discovered during Step 1: must add to KNOWN_PLUGIN_DIRS, findAllPluginDirs, tsconfig, lint allow-default-project. |

## Verification

At every step:
1. `./equin build` succeeds
2. `diff` on `docs/plugins-compact.md`, `docs/plugins-details.md`, `docs/routes.md` — must be empty (modulo new facet plugin entries)
3. Spot-check 2-3 per-plugin `CLAUDE.md` files for identical autogen blocks
4. Plugin-view API at `GET /api/plugin-view/tree` returns identical JSON (compare before/after)
5. `./equin check` passes all checks
