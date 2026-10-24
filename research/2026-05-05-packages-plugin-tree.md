# packages/plugin-tree — unified plugin discovery & metadata

## Context

Four independent places duplicate the same plugin directory walk logic:

1. `cli/src/docgen.ts` — `findAllPluginDirs()` + `collectPlugin()` + `computeReverseIndexes()`
2. `plugins/publish/server/internal/tree-handler.ts` — `buildNode()` (recursive inline)
3. `cli/src/checks/index.ts` — `findPluginDirs()` (comment: "mirrors docgen.ts")
4. `cli/src/checks/plugin-boundaries.ts` — `discoverPlugins()`

All four share the same walk algorithm. The publish plugin further duplicates `parseStringField`/`parseBoolField`. Docgen has the full metadata extraction (exports, slots, routes, contributions, etc.) which other future consumers will also need.

The goal: a single `packages/plugin-tree` package that owns the complete plugin model — tree structure, per-plugin metadata, and cross-plugin relationships. All eagerly computed (148 plugins parse in ~100ms — no perf concern).

## Design: full eager model, single entry point

`buildPluginTree(pluginsRoot)` returns a complete `PluginTree` with all metadata pre-computed. No lazy loading, no separate enrichment steps. Plain data in, plain data out.

### API

```typescript
export type Runtime = "web" | "server" | "central";

// ── Single entry point ──────────────────────────────────────────────

export function buildPluginTree(pluginsRoot: string): PluginTree;

// ── Tree ────────────────────────────────────────────────────────────

export interface PluginTree {
  pluginsRoot: string;
  byDir: Map<string, PluginNode>;
  roots: PluginNode[];                // top-level, sorted alphabetically
}

// ── Node ────────────────────────────────────────────────────────────

export interface PluginNode {
  // Identity & structure
  dir: string;                        // absolute path on disk
  path: string;                       // relative to pluginsRoot, forward slashes
  name: string;                       // leaf segment
  hierarchyId: string;                // dotted ancestry, e.g. "active-data.conv"
  description?: string;               // first non-null from web → server → central
  loadBearing: boolean;
  runtimes: Record<Runtime, boolean>;
  children: PluginNode[];

  // Per-runtime barrel analysis
  exports: Record<Runtime | "shared", BarrelExport[]>;

  // Web-specific
  slots: SlotDef[];
  commands: CommandDef[];
  contributions: Contribution[];

  // Server / central analysis
  server: RuntimeDetail;
  central: RuntimeDetail;

  // DB
  dbFiles: string[];

  // Cross-plugin relationships (computed from full graph)
  importedBy: string[];
  slotContributors: string[];
  endpointCallers: string[];
  entityExtensions: EntityExtension[];
  extendedBy: EntityExtensionRef[];
}

// ── Supporting types ────────────────────────────────────────────────

export interface BarrelExport {
  name: string;
  kind: "type" | "value";
}

export interface SlotDef {
  memberName: string;
  slotId: string;
  groupName: string;
}

export interface CommandDef {
  memberName: string;
  commandId: string;
  groupName: string;
}

export interface Contribution {
  slot: string;                       // e.g. "Shell.Toolbar"
  props: Record<string, string>;
  paneId?: string;
  panePath?: string;
}

export interface RuntimeDetail {
  httpRoutes: string[];
  wsRoutes: string[];
  resources: { key: string; mode: string }[];
  registerTokens: string[];
  apiUses: string[];
}

export interface EntityExtension {
  parentPlugin: string;
  extName: string;
  tableName: string;
}

export interface EntityExtensionRef {
  childPlugin: string;
  extName: string;
  tableName: string;
}
```

### Key design decisions

1. **Single entry point** — `buildPluginTree(pluginsRoot)` returns the full model. No `findAllPluginDirs` export; consumers that need paths just iterate `tree.byDir`.

2. **Eager everything** — 148 plugins parse in ~100ms. Lazy adds complexity for no practical gain.

3. **`description` uses first-non-null** (not concatenation) — docgen's concatenation of all barrel descriptions is a rendering choice. If docgen still wants concatenation for its docs, it can read barrels itself or we add a `descriptions: Record<Runtime, string | undefined>` field.

4. **Runtime detail grouped** — server and central each get their own `RuntimeDetail` (routes, resources, register, apiUses) instead of flat `httpRoutes`/`centralHttpRoutes`/etc. Cleaner than docgen's current `fooRoutes`/`centralFooRoutes` duplication.

5. **Relationships on the node** — `importedBy`, `slotContributors`, etc. live directly on `PluginNode`, computed in a post-pass over the full graph (same as docgen's `computeReverseIndexes`).

## File layout

```
packages/plugin-tree/
  package.json    # { "name": "@singularity/plugin-tree", "private": true }
  index.ts        # Public API: types + buildPluginTree
```

Internally organized with clear sections:
- Types (exported)
- Parsing helpers (`parseStringField`, `parseBoolField`, `matchBracket`, `stripTypes`, `parseBarrelExports`, `parseRouteMap`, `parseDefineGroup`, `parseImports`, `extractContributionsBlock`, etc.)
- Walk (`findAllPluginDirs`)
- Per-plugin collection (`collectPlugin`)
- Cross-plugin analysis (`computeRelationships`)
- Tree assembly (`buildPluginTree` — the single export)

**Note:** Uses `Bun.Transpiler` for TypeScript stripping (same as docgen today). Fine — this is a Bun-only project.

## Migration plan

### 1. Create `packages/plugin-tree/`

Move all parsing logic from `cli/src/docgen.ts` into the package. This includes:
- `findAllPluginDirs` (lines 101–131)
- All parsing helpers: `parseStringField`, `parseBoolField`, `matchBracket`, `stripTypes`, `parseBarrelExports`, `parseRouteMap`, `parseDefineGroup`, `parseImports`, `extractContributionsBlock`, `findCalls`, `parsePropsBlock`, `walkFiles`, `parsePaneDefinitions`, `parseServerApiUses`, `parseResources`, `parseRegisterTokens`, `parseEntityExtensionCalls`, `parseTableNamesFromDbFiles`, `findDbFiles`
- `collectPlugin` (lines 575–706) — adapted to produce `PluginNode` instead of `PluginInfo`
- `computeReverseIndexes` (lines 902–1026) — renamed to `computeRelationships`
- Tree assembly logic from `buildPluginTree` (lines 1033–1067)

Adapt `PluginInfo` → `PluginNode`:
- Drop `parentDir` (implementation artifact — used only during tree assembly, not exposed)
- Group flat `httpRoutes`/`centralHttpRoutes`/etc. into `server: RuntimeDetail` / `central: RuntimeDetail`
- Group `webExports`/`serverExports`/etc. into `exports: Record<Runtime | "shared", BarrelExport[]>`
- Add `path`, `hierarchyId`, `runtimes` (from publish's model)
- `description`: first non-null, not concatenation

### 2. Slim down `cli/src/docgen.ts`

Docgen becomes a pure **renderer**. It imports `buildPluginTree` and all types from `@packages/plugin-tree`, keeps only:
- Rendering functions (`renderPluginTree`, `renderPluginBody`, `renderCompactDoc`, `renderDetailsDoc`, `renderRoutesDoc`, `renderPluginClaudeMd`, etc.)
- AUTOGEN fence constants
- Output path helpers
- `generatePluginDocs` (the CLI entry point)
- `collectAllPlugins` (thin wrapper if still needed by `build.ts`)

The ~600 lines of parsing logic move to the package. Docgen drops from ~1275 to ~600 lines.

If docgen needs concatenated descriptions for its docs, it can access `node.exports` or read barrel source directly — or we add `descriptions: Record<Runtime, string | undefined>` to `PluginNode`.

### 3. Update `cli/src/plugin-registry-gen.ts`

```diff
- import { findAllPluginDirs } from "./docgen";
+ import { buildPluginTree } from "@packages/plugin-tree";
```

Replace `findAllPluginDirs(pluginsRoot)` iteration with `tree.byDir.values()` iteration using `node.dir` and `node.path`.

### 4. Update `plugins/publish/server/internal/tree-handler.ts`

Replace ~60 lines of duplicated parsing with:
- Import `buildPluginTree` from `@packages/plugin-tree`
- Thin `toApiNode()` mapper that strips `dir` (absolute path shouldn't leak to browser) and keeps the fields publish needs
- Keep `tally()` and `handleTree()` response shaping
- Keep `publish/shared/types.ts` unchanged (web code has its own API type)

### 5. Update `cli/src/checks/index.ts`

- Remove local `findPluginDirs` (lines 57–83)
- Import `buildPluginTree` from `@packages/plugin-tree`
- Iterate `tree.byDir.values()` for plugin check discovery

### 6. Update `cli/src/checks/plugin-boundaries.ts`

- Remove `discoverPlugins` (lines 231–260)
- Import `buildPluginTree` from `@packages/plugin-tree`
- Derive `PluginDir[]` from `tree.byDir.values()`

### 7. Update `cli/src/checks/plugins-have-claudemd.ts` and `plugins-doc-in-sync.ts`

These import `buildPluginTree` from `../docgen`. Update to import from `@packages/plugin-tree` for the tree, and from `../docgen` only for rendering functions.

## Files modified

| File | Action |
|---|---|
| `packages/plugin-tree/package.json` | Create |
| `packages/plugin-tree/index.ts` | Create (~700 lines — all parsing + types) |
| `cli/src/docgen.ts` | Slim to ~600 lines (rendering only) |
| `cli/src/plugin-registry-gen.ts` | Swap to package import |
| `plugins/publish/server/internal/tree-handler.ts` | Replace with package import + mapper |
| `cli/src/checks/index.ts` | Remove `findPluginDirs`, use package |
| `cli/src/checks/plugin-boundaries.ts` | Remove `discoverPlugins`, use package |
| `cli/src/checks/plugins-have-claudemd.ts` | Swap tree import source |
| `cli/src/checks/plugins-doc-in-sync.ts` | Swap tree import source |

## Verification

1. `./equin build` — confirms docgen renders identical docs, registry-gen produces identical registries, server starts
2. `./equin check` — all checks pass (plugin-boundaries, plugins-doc-in-sync, plugins-have-claudemd, eslint)
3. Diff `docs/plugins-compact.md`, `docs/plugins-details.md`, `docs/routes.md` against pre-migration — must be identical
4. `GET /api/publish/tree` — compare response against pre-migration snapshot
