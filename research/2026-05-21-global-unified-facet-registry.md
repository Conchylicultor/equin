# Unified Plugin Facet Registry

## Context

Every plugin can have barrel directories (`web/`, `server/`, `check/`, `lint/`, etc.) that export typed values. Currently, web/server/central use a codegen registry (`plugins.generated.ts`) while check and lint each have their own ad-hoc filesystem walker + dynamic import. Adding a new barrel type today requires editing hardcoded lists in multiple files and writing a custom discovery loop from scratch.

Goal: a single canonical facet registry that drives all tree detection, codegen, and consumer loading — adding a new facet is one config entry + one consumer file.

## Design

### 1. Canonical facet list — `known-facets.ts`

New file: `plugins/plugin-meta/plugins/plugin-tree/core/internal/known-facets.ts`

Single source of truth for every recognized barrel directory. Both the plugin-tree walker and the codegen read from this list.

```ts
export interface KnownFacet {
  dir: string;
  kind: "runtime" | "library" | "registry";
  /** Should collectPlugin parse named exports from this barrel? */
  trackExports: boolean;
  /** Is this a boundary-checker runtime zone? */
  boundaryRuntime: boolean;
  /** If present, codegen generates a registry file for this facet. */
  registry?: RegistryConfig;
}

export interface RegistryConfig {
  generatedFile: string;    // path relative to repo root
  valueType: string;        // TS type for the default export
  typeImport: string;       // import statement for the type
  exportName: string;       // name of the exported array constant
}

export const KNOWN_FACETS: readonly KnownFacet[] = [
  // Runtime facets — app plugin definitions, lazy (web) or static (server/central)
  { dir: "web",     kind: "runtime",  trackExports: true,  boundaryRuntime: true,  registry: {
    generatedFile: "plugins/framework/plugins/web-core/web/plugins.generated.ts",
    valueType: "PluginDefinition", exportName: "pluginEntries",
    typeImport: 'import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";',
  }},
  { dir: "server",  kind: "runtime",  trackExports: true,  boundaryRuntime: true,  registry: {
    generatedFile: "plugins/framework/plugins/server-core/bin/plugins.generated.ts",
    valueType: "ServerPluginDefinition", exportName: "plugins",
    typeImport: 'import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";',
  }},
  { dir: "central", kind: "runtime",  trackExports: true,  boundaryRuntime: true,  registry: {
    generatedFile: "plugins/framework/plugins/central-core/bin/plugins.generated.ts",
    valueType: "CentralPluginDefinition", exportName: "plugins",
    typeImport: 'import type { CentralPluginDefinition } from "@plugins/framework/plugins/central-core/core";',
  }},

  // Library facets — shared code barrels, no default export, no registry
  { dir: "core",   kind: "library", trackExports: true,  boundaryRuntime: true  },
  { dir: "shared", kind: "library", trackExports: true,  boundaryRuntime: true  },

  // Registry facets — typed default exports, flat static-import registries
  { dir: "check",  kind: "registry", trackExports: false, boundaryRuntime: false, registry: {
    generatedFile: "plugins/framework/plugins/tooling/plugins/checks/core/checks.generated.ts",
    valueType: "Check | Check[]", exportName: "checkEntries",
    typeImport: 'import type { Check } from "./types";',
  }},
  { dir: "lint",   kind: "registry", trackExports: false, boundaryRuntime: false, registry: {
    generatedFile: "plugins/framework/plugins/tooling/plugins/lint/core/lint.generated.ts",
    valueType: "LintContribution", exportName: "lintEntries",
    typeImport: 'import type { LintContribution } from "./types";',
  }},
];

export const ALL_BARREL_DIRS = new Set(KNOWN_FACETS.map(f => f.dir));
export const BOUNDARY_RUNTIME_DIRS = new Set(
  KNOWN_FACETS.filter(f => f.boundaryRuntime).map(f => f.dir),
);
export const REGISTRY_FACETS = KNOWN_FACETS.filter(
  (f): f is KnownFacet & { registry: RegistryConfig } => !!f.registry,
);
```

Re-export from `plugin-tree/core/index.ts`.

### 2. Plugin tree walker reads from facet list

**`findAllPluginDirs`** in `plugin-tree.ts` (line 549): replace 7 hardcoded `existsSync` calls with:

```ts
import { ALL_BARREL_DIRS } from "./known-facets";

const hasBarrel = [...ALL_BARREL_DIRS].some(d => existsSync(join(dir, d, "index.ts")));
```

**`findPluginDirs`** in `allow-default-project.ts` (line 45): same change, import `ALL_BARREL_DIRS` from `@plugins/plugin-meta/plugins/plugin-tree/core`.

**`RUNTIMES`** in `boundaries/core/resolve.ts` (line 5): replace `new Set(["web", "server", "central", "core", "shared"])` with import of `BOUNDARY_RUNTIME_DIRS`.

### 3. Codegen generates registries for all registry facets

**`plugin-registry-gen.ts`**: The existing `RUNTIMES` config (lines 14-33) and `renderPluginRegistry` (line 181) stay for runtime facets — their format is complex (lazy loaders for web, `dependsOn` + `_hierarchyPath` for server/central) and worth keeping as specialized renderers.

Add a new `renderFacetRegistry` for the simpler "static-list" format used by registry facets (check, lint):

```ts
import { REGISTRY_FACETS } from "@plugins/plugin-meta/plugins/plugin-tree/core";

export function renderFacetRegistry(opts: { root: string; facet: KnownFacet & { registry: RegistryConfig } }): string {
  const { facet } = opts;
  const tree = buildPluginTree(resolve(opts.root, "plugins"));
  const entries: { alias: string; importPath: string; pluginPath: string }[] = [];
  for (const node of tree.byDir.values()) {
    if (!existsSync(join(node.dir, facet.dir, "index.ts"))) continue;
    if (!hasDefaultExport(join(node.dir, facet.dir, "index.ts"))) continue;
    entries.push({
      alias: `_${entries.length}`,
      importPath: `@plugins/${node.path}/${facet.dir}`,
      pluginPath: node.path,
    });
  }
  entries.sort((a, b) => a.importPath.localeCompare(b.importPath));

  // Render: header, type import, static imports, flat export array
  return [
    HEADER, "",
    facet.registry.typeImport, "",
    ...entries.map(e => `import ${e.alias} from "${e.importPath}";`),
    "",
    `export const ${facet.registry.exportName}: { pluginPath: string; value: ${facet.registry.valueType} }[] = [`,
    ...entries.map(e => `  { pluginPath: ${JSON.stringify(e.pluginPath)}, value: ${e.alias} },`),
    "];", "",
  ].join("\n");
}

export function facetRegistryPath(root: string, facet: { registry: RegistryConfig }): string {
  return join(root, facet.registry.generatedFile);
}
```

Extend `generatePluginRegistry`:

```ts
export async function generatePluginRegistry(opts: { root: string }): Promise<void> {
  // Existing runtime registries (web, server, central)
  for (const runtime of Object.keys(RUNTIMES) as Runtime[]) { /* ... unchanged ... */ }
  // New: registry facets (check, lint, future)
  for (const facet of REGISTRY_FACETS.filter(f => f.kind === "registry")) {
    const file = facetRegistryPath(opts.root, facet);
    const next = renderFacetRegistry({ root: opts.root, facet });
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (next !== existing) writeFileSync(file, next);
  }
}
```

**Future option**: the runtime facets (web/server/central) also have `registry` config in `KNOWN_FACETS`. A follow-up could migrate `renderPluginRegistry` to also read from `KNOWN_FACETS` instead of its local `RUNTIMES`, fully unifying the config. Not in scope here — the runtime renderers are complex enough to keep as-is.

### 4. New type: `LintContribution`

New file: `plugins/framework/plugins/tooling/plugins/lint/core/types.ts`

```ts
export interface LintContribution {
  name: string;
  rules: Record<string, unknown>;
}
```

Export from `lint/core/index.ts`.

### 5. Consumer migration

**Check runner** (`checks/core/runner.ts`): replace `loadAllChecks` (lines 24-62) — eliminate `buildPluginTree` walk and dynamic `import()`:

```ts
import { checkEntries } from "./checks.generated";

async function loadAllChecks(): Promise<Check[]> {
  const out: Check[] = [];
  const seenIds = new Set<string>();
  for (const entry of checkEntries) {
    const checks = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const c of checks) {
      if (!isCheck(c)) { console.warn(`...`); continue; }
      if (seenIds.has(c.id)) { console.warn(`...`); continue; }
      seenIds.add(c.id);
      out.push(c);
    }
  }
  return out;
}
```

No more `buildPluginTree`, no more `import()`, no more `root` parameter needed.

**ESLint config** (`eslint.config.ts`): replace `discoverPluginContributions` (lines 41-65) with synchronous import from the generated registry:

```ts
import { lintEntries } from "./plugins/framework/plugins/tooling/plugins/lint/core/lint.generated";

const contributions: PluginContribution[] = lintEntries.map(e => ({
  relPath: e.pluginPath,
  name: e.value.name,
  rules: e.value.rules as Record<string, unknown>,
}));
```

The top-level `await` for lint discovery is eliminated. `findPluginDirs` is no longer needed by ESLint (it stays for `discoverAllowDefaultProject`).

### 6. Extend `plugins-registry-in-sync`

The check at `plugins-registry-in-sync/check/index.ts` currently validates 3 files. Extend to also verify registry facet files:

```ts
import { REGISTRY_FACETS } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { facetRegistryPath, renderFacetRegistry } from "@plugins/framework/plugins/tooling/plugins/codegen/core";

// After existing RUNTIMES loop:
for (const facet of REGISTRY_FACETS.filter(f => f.kind === "registry")) {
  const file = facetRegistryPath(root, facet);
  // ... same existsSync + content comparison pattern
}
```

### 7. `PluginNode` changes

`PluginNode.runtimes` stays `Record<Runtime, boolean>` (web/server/central only) — no breaking change.

`PluginNode.exports` stays `Record<Runtime | "core" | "shared", BarrelExport[]>` — check/lint don't have named public API worth tracking.

In `collectPlugin` (line 596), populate `PluginNode.facets` for registry facets:

```ts
import { KNOWN_FACETS } from "./known-facets";

for (const f of KNOWN_FACETS) {
  if (f.kind === "registry" && existsSync(join(dir, f.dir, "index.ts"))) {
    node.facets[f.dir] = true;
  }
}
```

This lets docgen, plugin-view, etc. check `node.facets["check"]` without new `PluginNode` fields.

## Files to change

| File | Action |
|------|--------|
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/known-facets.ts` | **Create** — canonical facet list |
| `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` | Re-export facet types and constants |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Use `ALL_BARREL_DIRS` in `findAllPluginDirs`, populate facets in `collectPlugin` |
| `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` | Add `renderFacetRegistry`, `facetRegistryPath`, extend `generatePluginRegistry` |
| `plugins/framework/plugins/tooling/plugins/codegen/core/index.ts` | Export new functions |
| `plugins/framework/plugins/tooling/plugins/lint/core/types.ts` | **Create** — `LintContribution` type |
| `plugins/framework/plugins/tooling/plugins/lint/core/index.ts` | Export `LintContribution` |
| `plugins/framework/plugins/tooling/plugins/lint/core/allow-default-project.ts` | Use `ALL_BARREL_DIRS` in `findPluginDirs` |
| `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` | Consume `checks.generated.ts` instead of tree walk |
| `eslint.config.ts` | Consume `lint.generated.ts` instead of tree walk |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/plugins-registry-in-sync/check/index.ts` | Extend to verify registry facet files |
| `plugins/framework/plugins/tooling/plugins/boundaries/core/resolve.ts` | Use `BOUNDARY_RUNTIME_DIRS` |

**Generated files (committed, created by build):**
| File | Purpose |
|------|---------|
| `plugins/framework/plugins/tooling/plugins/checks/core/checks.generated.ts` | Static check registry |
| `plugins/framework/plugins/tooling/plugins/lint/core/lint.generated.ts` | Static lint contribution registry |

## Verification

1. `./equin build` should generate the two new `.generated.ts` files
2. `./equin check` should pass — all existing checks work, `plugins-registry-in-sync` now covers 5 files
3. ESLint continues to discover the `debug/plugins/logs/lint` rule (same scoping behavior)
4. Adding a test facet (e.g. create a `guard/` entry in `KNOWN_FACETS`) should be detected by `findAllPluginDirs` without any other code changes
5. `git diff $(git merge-base HEAD main)` for final review

## Tradeoff

New check/lint barrels now require `./equin build` before they take effect (same as web/server/central plugins). This trades instant ad-hoc discovery for a single unified mechanism. The `plugins-registry-in-sync` check catches drift.
