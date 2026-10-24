# packages/plugin-tree — implementation plan

## Context

Four independent copies of the plugin directory walk exist in the codebase. The full metadata extraction (exports, slots, routes, contributions, cross-plugin relationships) lives only in `cli/src/docgen.ts` but will be needed by future consumers. This plan creates `packages/plugin-tree` — a single package that owns the complete plugin model, eagerly computed (148 plugins parse in ~100ms).

## API

```typescript
export type Runtime = "web" | "server" | "central";

export function buildPluginTree(pluginsRoot: string): PluginTree;

export interface PluginTree {
  pluginsRoot: string;
  byDir: Map<string, PluginNode>;
  roots: PluginNode[];
}

export interface PluginNode {
  dir: string;
  path: string;                       // relative to pluginsRoot, forward slashes
  name: string;
  hierarchyId: string;                // "active-data.conv"
  description?: string;               // first non-null across runtimes
  descriptions: Partial<Record<Runtime, string>>; // per-runtime (docgen concatenates these)
  loadBearing: boolean;
  runtimes: Record<Runtime, boolean>;
  children: PluginNode[];

  exports: Record<Runtime | "shared", BarrelExport[]>;
  slots: SlotDef[];
  commands: CommandDef[];
  contributions: Contribution[];
  server: RuntimeDetail;
  central: RuntimeDetail;
  dbFiles: string[];

  importedBy: string[];
  slotContributors: string[];
  endpointCallers: string[];
  entityExtensions: EntityExtension[];
  extendedBy: EntityExtensionRef[];
}

export interface RuntimeDetail {
  httpRoutes: string[];
  wsRoutes: string[];
  resources: { key: string; mode: string }[];
  registerTokens: string[];
  apiUses: string[];
}

// + BarrelExport, SlotDef, CommandDef, Contribution, EntityExtension, EntityExtensionRef
// (same shapes as current docgen types)
```

## Step-by-step

### Step 1: Create `packages/plugin-tree/`

Create `packages/plugin-tree/package.json`:
```json
{ "name": "@singularity/plugin-tree", "private": true }
```

Create `packages/plugin-tree/index.ts` — move from `cli/src/docgen.ts`:

**Types to export** (lines 7–83 of docgen, adapted):
- `Runtime`, `PluginNode`, `PluginTree`, `BarrelExport`, `SlotDef`, `CommandDef`, `Contribution`, `RuntimeDetail`, `EntityExtension`, `EntityExtensionRef`
- Internal-only: `PaneDefinition`, `ImportBinding`, `RawExtRef` — not exported

**Helpers to move** (keep internal, not exported):
- `readIfExists` (line 85)
- `stripTypes` / transpiler (lines 89–99)
- `parseStringField` (line 133) — enhance with backtick support from publish's version
- `parseBoolField` (line 139)
- `matchBracket` (line 199)
- `parseDefineGroup` (line 146)
- `parseImports` (line 176)
- `extractContributionsBlock` (line 221)
- `findCalls` (line 230)
- `parsePropsBlock` (line 244)
- `parseRouteMap` (line 306)
- `parseBarrelExports` (line 323)
- `walkFiles` (line 370)
- `parsePaneDefinitions` (line 388)
- `parseServerApiUses` (line 413)
- `parseResources` (line 457)
- `parseRegisterTokens` (line 483)
- `parseEntityExtensionCalls` (line 517)
- `parseTableNamesFromDbFiles` (line 535)
- `findDbFiles` (line 548)

**Core functions to move** (keep internal except `buildPluginTree`):
- `findAllPluginDirs` (line 101) — internal, called by `buildPluginTree`
- `collectPlugin` (line 575) — adapted to produce `PluginNode`:
  - Add `path` = `relative(pluginsRoot, dir)` with forward slashes
  - Add `hierarchyId` — computed during tree assembly, initially empty
  - Add `descriptions` — `{ web: webDesc, server: serverDesc, central: centralDesc }` filtered to non-undefined
  - Add `runtimes` — `{ web: !!webIndex, server: !!serverIndex, central: !!centralIndex }`
  - `description` = first non-null from web → server → central (NOT concatenated)
  - Group routes/resources/register/apiUses into `server: RuntimeDetail` and `central: RuntimeDetail`
  - Group exports into `exports: Record<Runtime | "shared", BarrelExport[]>`
  - Rename `definedSlots` → `slots`, `definedCommands` → `commands`
  - Drop `parentDir` (only used during tree assembly)
- `computeReverseIndexes` (line 902) — renamed `computeRelationships`, adapted:
  - References to `p.httpRoutes` become `p.server.httpRoutes`
  - References to `p.centralHttpRoutes` become `p.central.httpRoutes`
  - Same for `apiUses`, `centralApiUses` → `p.server.apiUses`, `p.central.apiUses`
  - References to `p.definedSlots` become `p.slots`
- Tree assembly from `buildPluginTree` (line 1033):
  - Compute `parentDir` internally (not on node)
  - After tree assembly, compute `hierarchyId` in a recursive pass
  - Return `{ pluginsRoot, byDir, roots }`

### Step 2: Slim down `cli/src/docgen.ts`

Remove everything that moved to the package (~700 lines). Keep only:
- AUTOGEN fence constants (`BEGIN`, `END`)
- `stripQuotes` helper (used by renderers only)
- All rendering functions:
  - `renderContribution`
  - `renderPluginBody` — adapt to new field names (`p.slots` instead of `p.definedSlots`, `p.server.httpRoutes` instead of `p.httpRoutes`, `p.exports.web` instead of `p.webExports`, etc.)
  - `renderPluginTree`
  - `renderTreeBody`
  - `renderCompactDocFromTree`, `renderDetailsDocFromTree`, `renderRoutesDocFromTree`
  - `renderPluginClaudeAutogen`, `renderPluginClaudeMd`
  - `pluginHasRoutesDeep` — adapt: `p.server.httpRoutes` etc.
  - `groupHttpRoutes`, `renderRoutesPluginTree`
- Public exports:
  - `renderCompactDoc`, `renderDetailsDoc`, `renderRoutesDoc` — adapt: call `buildPluginTree(resolve(root, "plugins"))` from package
  - `generatePluginDocs`
  - `renderPluginClaudeMd` (used by plugins-doc-in-sync check)
  - Path helpers: `pluginCompactDocPath`, `pluginDetailsDocPath`, `pluginRoutesDocPath`, `pluginClaudeMdPath`
  - `collectAllPlugins` — thin wrapper: `Array.from(buildPluginTree(resolve(root, "plugins")).byDir.values())`

**Import changes:**
```typescript
import { buildPluginTree, type PluginNode, type PluginTree } from "@packages/plugin-tree";
```

**Rendering adaptation for description:**
- In `renderPluginBody` and related renderers, where the current code uses `p.description`, use the concatenated form: `Object.values(p.descriptions).join(" ") || undefined` to match current output exactly.

### Step 3: Update `cli/src/plugin-registry-gen.ts`

Replace:
```typescript
import { findAllPluginDirs } from "./docgen";
```
With:
```typescript
import { buildPluginTree } from "@packages/plugin-tree";
```

In `collectEntries`:
```typescript
const tree = buildPluginTree(pluginsRoot);
const entries: Entry[] = [];
for (const node of tree.byDir.values()) {
  const indexFile = join(node.dir, runtime, "index.ts");
  if (!existsSync(indexFile)) continue;
  if (!hasDefaultExport(indexFile)) continue;
  entries.push({
    importName: importNameFor(node.path),
    importPath: `@plugins/${node.path}/${runtime}`,
  });
}
```

### Step 4: Update `plugins/publish/server/internal/tree-handler.ts`

Replace the entire file body. Remove all local parsing (`readBarrel`, `parseStringField`, `parseBoolField`, `buildNode`). New implementation:

```typescript
import { resolve } from "path";
import { buildPluginTree, type PluginNode } from "@packages/plugin-tree";
import type { PluginNode as ApiPluginNode, PublishTreePayload } from "../../shared/types";

const PLUGINS_ROOT = resolve(import.meta.dir, "..", "..", "..");

function toApiNode(node: PluginNode): ApiPluginNode {
  return {
    path: node.path,
    name: node.name,
    hierarchyId: node.hierarchyId,
    description: node.description,
    loadBearing: node.loadBearing,
    runtimes: node.runtimes,
    children: node.children.map(toApiNode),
  };
}

function tally(node: ApiPluginNode, totals: { plugins: number; loadBearing: number; umbrellas: number }) {
  totals.plugins += 1;
  if (node.loadBearing) totals.loadBearing += 1;
  if (node.children.length > 0) totals.umbrellas += 1;
  for (const child of node.children) tally(child, totals);
}

export function handleTree(): Response {
  const tree = buildPluginTree(PLUGINS_ROOT);
  const plugins = tree.roots.map(toApiNode);
  const totals = { plugins: 0, loadBearing: 0, umbrellas: 0 };
  for (const p of plugins) tally(p, totals);
  const payload: PublishTreePayload = { plugins, totals };
  return Response.json(payload);
}
```

### Step 5: Update `cli/src/checks/index.ts`

Remove `findPluginDirs` (lines 57–83). Replace usage:

```typescript
import { buildPluginTree } from "@packages/plugin-tree";

// In loadPluginChecks:
const tree = buildPluginTree(pluginsRoot);
for (const node of tree.byDir.values()) {
  const checkBarrel = join(node.dir, "check", "index.ts");
  // ... rest unchanged, using node.dir instead of pluginDir
}
```

### Step 6: Update `cli/src/checks/plugin-boundaries.ts`

Remove `discoverPlugins` (lines 231–260) and `PluginDir` interface (lines 48–55). Replace usage:

```typescript
import { buildPluginTree } from "@packages/plugin-tree";

// In the check's run():
const tree = buildPluginTree(pluginsRoot);
const plugins = Array.from(tree.byDir.values()).map((node) => ({
  relPath: node.path,
  absPath: node.dir,
  name: node.name,
}));
```

Keep the local `PluginDir` interface (it's the shape the rest of the check uses) but remove `discoverPlugins`.

### Step 7: Update `cli/src/checks/plugins-have-claudemd.ts`

```diff
- import { buildPluginTree, pluginClaudeMdPath } from "../docgen";
+ import { buildPluginTree } from "@packages/plugin-tree";
+ import { pluginClaudeMdPath } from "../docgen";
```

### Step 8: Update `cli/src/checks/plugins-doc-in-sync.ts`

```diff
- import {
-   buildPluginTree,
-   pluginClaudeMdPath,
-   ...
- } from "../docgen";
+ import { buildPluginTree } from "@packages/plugin-tree";
+ import {
+   pluginClaudeMdPath,
+   ...
+ } from "../docgen";
```

### Step 9: Update `cli/src/commands/build.ts`

`collectAllPlugins` stays in docgen (thin wrapper over package's `buildPluginTree`). `collectCentralRoutes` accesses `p.central.httpRoutes` and `p.central.wsRoutes` instead of `p.centralHttpRoutes` / `p.centralWsRoutes`. Since `collectAllPlugins` returns `PluginNode` now (re-exported from docgen), the field access in `build.ts` (lines 47–53) needs updating:

```typescript
for (const p of collectAllPlugins(root)) {
  for (const route of p.central.httpRoutes) {  // was p.centralHttpRoutes
    ...
  }
  for (const route of p.central.wsRoutes) out.add(route);  // was p.centralWsRoutes
}
```

## Files modified

| File | Action |
|---|---|
| `packages/plugin-tree/package.json` | Create |
| `packages/plugin-tree/index.ts` | Create (~700 lines) |
| `cli/src/docgen.ts` | Slim to ~550 lines (rendering only) |
| `cli/src/plugin-registry-gen.ts` | Swap import, use tree |
| `plugins/publish/server/internal/tree-handler.ts` | Replace with package import + mapper |
| `cli/src/checks/index.ts` | Remove `findPluginDirs`, use package |
| `cli/src/checks/plugin-boundaries.ts` | Remove `discoverPlugins`, use package |
| `cli/src/checks/plugins-have-claudemd.ts` | Split imports |
| `cli/src/checks/plugins-doc-in-sync.ts` | Split imports |
| `cli/src/commands/build.ts` | Update field access |

## Verification

1. Save pre-migration snapshots:
   - `cp docs/plugins-compact.md /tmp/compact-before.md`
   - `cp docs/plugins-details.md /tmp/details-before.md`
   - `cp docs/routes.md /tmp/routes-before.md`
   - `curl http://att-....localhost:9000/api/publish/tree > /tmp/publish-before.json`

2. `./equin build` — must succeed (docgen, registry-gen, server start, checks pass)

3. Diff outputs against pre-migration:
   - `diff docs/plugins-compact.md /tmp/compact-before.md` — must be empty
   - `diff docs/plugins-details.md /tmp/details-before.md` — must be empty
   - `diff docs/routes.md /tmp/routes-before.md` — must be empty
   - Compare publish tree JSON response

4. `./equin check` — all checks pass
