# Unified Barrel Type Registry (v2)

## Context

Every plugin can have barrel directories (`web/`, `server/`, `check/`, `lint/`, etc.) — subdirectories with an `index.ts` entry point. Currently, web/server/central use a codegen registry (`plugins.generated.ts`) while check and lint each have their own ad-hoc filesystem walker + dynamic import. Adding a new barrel type today requires editing hardcoded lists in multiple files and writing a custom discovery loop from scratch.

Goal: zero-maintenance barrel detection + a `defineBarrelType()` API for barrels that want codegen registries.

## Changes from v1

- **Naming**: "facet" → "barrel" (already the codebase term — `barrel-stubs-in-sync`, `hasBarrel`, `barrel-import`)
- **Detection**: Convention-based. Any immediate subdirectory with `index.ts` is a barrel, minus `plugins/` and `node_modules/`. No central list.
- **API**: `defineBarrelType(dir, { type })` — two meaningful fields. Everything else derived.
- **No `KnownFacet` interface**: Barrel detection needs no config. Only barrels wanting codegen declare themselves.

## Design

### 1. Convention-based barrel detection

Replace every hardcoded barrel-directory list with a single convention: a directory is a barrel if it has an `index.ts` and its name isn't `plugins` or `node_modules`.

**`findAllPluginDirs`** in `plugin-tree.ts` (line 549) — currently checks 7 names. Replace:

```ts
const EXCLUDED_DIRS = new Set(["plugins", "node_modules"]);

function hasAnyBarrel(dir: string): boolean {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  return entries.some(
    e => e.isDirectory() && !EXCLUDED_DIRS.has(e.name) && existsSync(join(dir, e.name, "index.ts"))
  );
}

function findAllPluginDirs(pluginsRoot: string): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 10) return;
    const isUmbrella = existsSync(join(dir, "plugins")) &&
      readdirSync(join(dir, "plugins"), { withFileTypes: true }).some(e => e.isDirectory());
    if ((hasAnyBarrel(dir) || isUmbrella) && dir !== pluginsRoot) out.push(dir);
    // ... nesting walk unchanged
  }
  walk(pluginsRoot, 0);
  return out;
}
```

**`findPluginDirs`** in `allow-default-project.ts` (line 45) — same change: replace 5 `existsSync` checks with `hasAnyBarrel(dir)`.

**`collectPlugin`** in `plugin-tree.ts` (line 596) — currently hardcodes which barrels to read. Generalize to discover barrel dirs dynamically:

```ts
function discoverBarrelDirs(dir: string): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && !EXCLUDED_DIRS.has(e.name) && existsSync(join(dir, e.name, "index.ts")))
    .map(e => e.name);
}
```

Then `collectPlugin` uses `discoverBarrelDirs(dir)` to populate `PluginNode.exports` for all discovered barrels (not just the hardcoded 5). The `PluginNode.exports` type widens from `Record<Runtime | "core" | "shared", BarrelExport[]>` to `Record<string, BarrelExport[]>`.

`PluginNode.runtimes` stays `Record<Runtime, boolean>` for backward compat — it's derived from the exports map.

### 2. `defineBarrelType()` — registration for codegen

New file: `plugins/plugin-meta/plugins/plugin-tree/core/internal/barrel-types.ts`

```ts
export interface BarrelTypeDef {
  readonly dir: string;
  readonly type: { readonly name: string; readonly from: string };
  readonly _brand: "BarrelTypeDef";
}

export function defineBarrelType(
  dir: string,
  opts: { type: { name: string; from: string } },
): BarrelTypeDef {
  return { dir, type: opts.type, _brand: "BarrelTypeDef" };
}

export function isBarrelTypeDef(value: unknown): value is BarrelTypeDef {
  return typeof value === "object" && value !== null && (value as BarrelTypeDef)._brand === "BarrelTypeDef";
}
```

Re-export from `plugin-tree/core/index.ts`.

### 3. Barrel type declarations by owning plugins

Each plugin that owns a barrel type declares it in its `core/` barrel:

```ts
// plugins/framework/plugins/tooling/plugins/checks/core/index.ts
import { defineBarrelType } from "@plugins/plugin-meta/plugins/plugin-tree/core";

export const checkBarrelType = defineBarrelType("check", {
  type: { name: "Check | Check[]", from: "./types" },
});
```

```ts
// plugins/framework/plugins/tooling/plugins/lint/core/index.ts
import { defineBarrelType } from "@plugins/plugin-meta/plugins/plugin-tree/core";

export const lintBarrelType = defineBarrelType("lint", {
  type: { name: "LintContribution", from: "./types" },
});
```

New file: `plugins/framework/plugins/tooling/plugins/lint/core/types.ts`
```ts
export interface LintContribution {
  name: string;
  rules: Record<string, unknown>;
}
```

### 4. Codegen discovers barrel types and generates registries

In `plugin-registry-gen.ts`, add a discovery function:

```ts
async function discoverBarrelTypes(root: string): Promise<(BarrelTypeDef & { ownerDir: string })[]> {
  const tree = buildPluginTree(resolve(root, "plugins"));
  const out: (BarrelTypeDef & { ownerDir: string })[] = [];
  for (const node of tree.byDir.values()) {
    const coreBarrel = join(node.dir, "core", "index.ts");
    if (!existsSync(coreBarrel)) continue;
    const src = readFileSync(coreBarrel, "utf8");
    if (!src.includes("defineBarrelType")) continue;
    const mod = await import(coreBarrel);
    for (const value of Object.values(mod)) {
      if (isBarrelTypeDef(value)) out.push({ ...value, ownerDir: node.dir });
    }
  }
  return out;
}
```

For each discovered barrel type, generate a registry at `<ownerDir>/core/<dir>.generated.ts`:

```ts
function renderBarrelRegistry(opts: {
  root: string;
  barrelType: BarrelTypeDef & { ownerDir: string };
}): string {
  const { barrelType } = opts;
  const tree = buildPluginTree(resolve(opts.root, "plugins"));
  const entries: { alias: string; importPath: string; pluginPath: string }[] = [];

  for (const node of tree.byDir.values()) {
    const barrel = join(node.dir, barrelType.dir, "index.ts");
    if (!existsSync(barrel)) continue;
    if (!hasDefaultExport(barrel)) continue;
    entries.push({
      alias: `_${entries.length}`,
      importPath: `@plugins/${node.path}/${barrelType.dir}`,
      pluginPath: node.path,
    });
  }
  entries.sort((a, b) => a.importPath.localeCompare(b.importPath));

  const exportName = `${barrelType.dir}Entries`;
  const valueType = barrelType.type.name;
  const typeImport = `import type { ${valueType.replace(/ \| .*/,"")} } from "${barrelType.type.from}";`;

  return [
    HEADER, "",
    typeImport, "",
    ...entries.map(e => `import ${e.alias} from "${e.importPath}";`), "",
    `export const ${exportName}: { pluginPath: string; value: ${valueType} }[] = [`,
    ...entries.map(e => `  { pluginPath: ${JSON.stringify(e.pluginPath)}, value: ${e.alias} },`),
    "];", "",
  ].join("\n");
}
```

Extend `generatePluginRegistry`:

```ts
export async function generatePluginRegistry(opts: { root: string }): Promise<void> {
  // Existing runtime registries (web, server, central) — unchanged
  for (const runtime of Object.keys(RUNTIMES) as Runtime[]) { /* ... */ }

  // Barrel type registries (check, lint, future)
  const barrelTypes = await discoverBarrelTypes(opts.root);
  for (const bt of barrelTypes) {
    const file = join(bt.ownerDir, "core", `${bt.dir}.generated.ts`);
    const next = renderBarrelRegistry({ root: opts.root, barrelType: bt });
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (next !== existing) writeFileSync(file, next);
  }
}
```

### 5. Consumer migration

**Check runner** (`checks/core/runner.ts`): replace `loadAllChecks` with import from `check.generated.ts`:

```ts
import { checkEntries } from "./check.generated";

async function loadAllChecks(): Promise<Check[]> {
  const out: Check[] = [];
  const seenIds = new Set<string>();
  for (const { pluginPath, value } of checkEntries) {
    for (const c of Array.isArray(value) ? value : [value]) {
      if (!isCheck(c)) { console.warn(`[check] ${pluginPath}: non-Check export`); continue; }
      if (seenIds.has(c.id)) { console.warn(`[check] ${pluginPath}: duplicate "${c.id}"`); continue; }
      seenIds.add(c.id);
      out.push(c);
    }
  }
  return out;
}
```

No more `buildPluginTree`, no dynamic `import()`, no `root` parameter.

**ESLint config** (`eslint.config.ts`): replace async `discoverPluginContributions` with sync import:

```ts
import { lintEntries } from "./plugins/framework/plugins/tooling/plugins/lint/core/lint.generated";

const contributions: PluginContribution[] = lintEntries.map(e => ({
  relPath: e.pluginPath,
  name: e.value.name,
  rules: e.value.rules as Record<string, unknown>,
}));
```

Top-level `await` for lint discovery eliminated. `findPluginDirs` no longer needed by eslint.config.ts.

### 6. Extend `plugins-registry-in-sync` check

The sync check must also verify barrel type registries. It discovers barrel types the same way the codegen does, then compares generated files:

```ts
const barrelTypes = await discoverBarrelTypes(root);
for (const bt of barrelTypes) {
  const file = join(bt.ownerDir, "core", `${bt.dir}.generated.ts`);
  const expected = renderBarrelRegistry({ root, barrelType: bt });
  if (!existsSync(file) || readFileSync(file, "utf8") !== expected) {
    return { ok: false, message: `${relative(root, file)} is out of sync`, hint: "Run `./equin build`" };
  }
}
```

### 7. Boundary checker

`boundaries/core/resolve.ts` line 5: `const RUNTIMES = new Set(["web", "server", "central", "core", "shared"])` — this defines which barrel directories are valid cross-plugin import targets. Check/lint are NOT valid targets (no one imports `@plugins/foo/check` cross-plugin).

For now, this stays hardcoded — it's an import-rule concern, not a detection concern. It could read from barrel type metadata in a follow-up (e.g., a `crossPlugin: true` flag on `defineBarrelType`), but that's not needed for this iteration.

## Adding a new barrel type — the workflow

To add a new barrel type (e.g., `guard/`):

1. Add `guard/index.ts` to any plugin — the tree walker detects it automatically (convention-based)
2. In the framework plugin that owns the barrel type, declare it:
   ```ts
   export const guardBarrelType = defineBarrelType("guard", {
     type: { name: "Guard", from: "./types" },
   });
   ```
3. Run `./equin build` — codegen discovers the barrel type and generates `guard.generated.ts`
4. Write a consumer that imports from the generated file

No hardcoded lists edited. No custom discovery code.

## Files to change

| File | Action |
|------|--------|
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/barrel-types.ts` | **Create** — `defineBarrelType`, `isBarrelTypeDef`, `BarrelTypeDef` |
| `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` | Re-export barrel type API |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Convention-based `findAllPluginDirs`, widen `PluginNode.exports`, generalize `collectPlugin` |
| `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` | Add `discoverBarrelTypes`, `renderBarrelRegistry`, extend `generatePluginRegistry` |
| `plugins/framework/plugins/tooling/plugins/codegen/core/index.ts` | Export new functions |
| `plugins/framework/plugins/tooling/plugins/checks/core/index.ts` | Add `checkBarrelType = defineBarrelType(...)` |
| `plugins/framework/plugins/tooling/plugins/lint/core/types.ts` | **Create** — `LintContribution` interface |
| `plugins/framework/plugins/tooling/plugins/lint/core/index.ts` | Add `lintBarrelType = defineBarrelType(...)`, export `LintContribution` |
| `plugins/framework/plugins/tooling/plugins/lint/core/allow-default-project.ts` | Use `hasAnyBarrel` convention in `findPluginDirs` |
| `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` | Import from `check.generated.ts` instead of tree walk |
| `eslint.config.ts` | Import from `lint.generated.ts` instead of tree walk |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/plugins-registry-in-sync/check/index.ts` | Extend to verify barrel type registries |

**Generated files (committed, created by build):**
| File | Purpose |
|------|---------|
| `plugins/framework/plugins/tooling/plugins/checks/core/check.generated.ts` | Static check registry |
| `plugins/framework/plugins/tooling/plugins/lint/core/lint.generated.ts` | Static lint contribution registry |

## Verification

1. `./equin build` generates the two new `.generated.ts` files
2. `./equin check` passes — existing checks work, `plugins-registry-in-sync` covers the new files
3. ESLint discovers the `debug/plugins/logs/lint` rule (same scoping behavior)
4. Create a dummy `test-barrel/index.ts` in any plugin → `findAllPluginDirs` detects it automatically
5. `git diff $(git merge-base HEAD main)` for review

## Tradeoff

New check/lint barrels require `./equin build` before they take effect (same as web/server/central). The `plugins-registry-in-sync` check catches drift.
