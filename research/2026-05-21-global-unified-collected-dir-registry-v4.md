# Unified Collected Dir Registry (v4)

## Context

Every plugin can have subdirectories with an `index.ts` barrel: `web/`, `server/`, `central/`, `check/`, `lint/`. Today these are handled three separate ways:

- **web/server/central** — codegen in `plugin-registry-gen.ts` drives a hardcoded `RUNTIMES` config, each with its own generated file format (web uses lazy loaders; server/central use static imports + mutation).
- **check** — `runner.ts` calls `buildPluginTree()`, walks every node, checks `existsSync(check/index.ts)`, dynamic `import()` at runtime.
- **lint** — `eslint.config.ts` calls `findPluginDirs()`, checks `existsSync(lint/index.ts)`, dynamic `import()` at config evaluation time.

Adding a new collected dir type requires writing a new discovery loop, editing hardcoded lists, and deciding on a format ad-hoc.

**Goal:** `defineCollectedDir(dir)` is the single declaration. One codegen pass generates one file per declared dir. Consumers import from generated files. No custom discovery loops, no hardcoded runtime lists in codegen.

**What changed from v3:** Scoped down after review. Plugin detection (`hasAnyBarrel`, `findAllPluginDirs`) stays unchanged. `PluginNode.exports` type stays unchanged. Boundary checker stays unchanged. Renamed from "barrel type" to "collected dir." No convention-based auto-detection.

## What does NOT change

1. **`hasAnyBarrel` / `findAllPluginDirs`** in `plugin-tree.ts` — plugin detection is a separate concern
2. **`findPluginDirs`** in `allow-default-project.ts` — lint tooling unchanged
3. **`PluginNode.exports`** typed union — check/lint don't participate in export tracking
4. **`RUNTIMES`** in `boundaries/core/resolve.ts` — import boundary targets unchanged
5. **`topoSortPlugins`** logic — consumers resolve dependsOn strings to object references before calling it

---

## 1. `defineCollectedDir` API

New file: `plugins/framework/plugins/tooling/plugins/codegen/core/collected-dir.ts`

```ts
export interface CollectedDirDef {
  readonly dir: string;
  readonly _brand: "CollectedDirDef";
}

export function defineCollectedDir(dir: string): CollectedDirDef {
  return { dir, _brand: "CollectedDirDef" };
}

export function isCollectedDirDef(value: unknown): value is CollectedDirDef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as CollectedDirDef)._brand === "CollectedDirDef"
  );
}
```

Zero dependencies. Re-exported from `codegen/core/index.ts`.

## 2. Declarations

Each framework plugin that owns a collected dir declares it in its `core/index.ts`:

```ts
// plugins/framework/plugins/web-sdk/core/index.ts
export const webCollectedDir = defineCollectedDir("web");

// plugins/framework/plugins/server-core/core/index.ts
export const serverCollectedDir = defineCollectedDir("server");

// plugins/framework/plugins/central-core/core/index.ts
export const centralCollectedDir = defineCollectedDir("central");

// plugins/framework/plugins/tooling/plugins/checks/core/index.ts
export const checkCollectedDir = defineCollectedDir("check");

// plugins/framework/plugins/tooling/plugins/lint/core/index.ts
export const lintCollectedDir = defineCollectedDir("lint");
```

Import direction: `web-sdk/core` → `codegen/core`. `defineCollectedDir` has zero transitive dependencies, so this adds no bundle weight. Tree-shaking eliminates unused `CollectedDirDef` values from the web bundle.

## 3. Codegen pipeline

Lives in `plugin-registry-gen.ts`, replacing the current `RUNTIMES`-based codegen.

### Step 1: `discoverCollectedDirs(root)`

Lightweight walk of `plugins/` for `*/core/index.ts` files following the `plugins/<X>/plugins/<Y>/...` nesting convention. Does NOT use `buildPluginTree` — just looks for `core/index.ts`, reads each, fast-path skips files without `defineCollectedDir`, dynamically imports matches, and collects `CollectedDirDef` exports.

```ts
async function discoverCollectedDirs(root: string):
  Promise<Array<CollectedDirDef & { ownerDir: string }>> {
  const pluginsRoot = resolve(root, "plugins");
  const coreBarrels = findCoreBarrels(pluginsRoot); // lightweight recursive walk
  const out = [];
  for (const barrelPath of coreBarrels) {
    if (!readFileSync(barrelPath, "utf8").includes("defineCollectedDir")) continue;
    const mod = await import(barrelPath);
    for (const value of Object.values(mod)) {
      if (isCollectedDirDef(value)) {
        out.push({ ...value, ownerDir: dirname(dirname(barrelPath)) });
      }
    }
  }
  return out;
}
```

### Step 2: `collectEntries(root, dir)`

Reuses existing `buildPluginTree` + `hasDefaultExport` logic. For each tree node, checks `<pluginDir>/<dir>/index.ts` exists with `export default`. Same as current `collectEntries` but parameterized on `dir` instead of `runtime`.

### Step 3: `buildDepsForDir(root, entries, dir)`

Generalizes current `buildDependsOn` (which only handles `"server" | "central"`) to accept any dir string. Scans `<pluginDir>/<dir>/` for `from "@plugins/.../<dir>"` imports. Returns `Map<pluginPath, string[]>`.

### Step 4: `renderCollectedDirRegistry(opts)`

One renderer for all collected dirs — unified lazy-loader format:

```ts
export interface CollectedEntry {
  pluginPath: string;
  hierarchyPath: string;
  loader: () => Promise<{ default: unknown }>;
  dependsOn: string[];
}

export const webEntries: CollectedEntry[] = [
  { pluginPath: "active-data/plugins/attempt",
    hierarchyPath: "active-data/attempt",
    loader: () => import("@plugins/active-data/plugins/attempt/web"),
    dependsOn: [] },
  // ...
];
```

`CollectedEntry` is inlined in each generated file (no external import needed). Export name is `${dir}Entries`.

### Step 5: Write if changed

```ts
export async function generatePluginRegistry(opts: { root: string }): Promise<void> {
  const defs = await discoverCollectedDirs(opts.root);
  for (const def of defs) {
    const file = join(def.ownerDir, "core", `${def.dir}.generated.ts`);
    const next = renderCollectedDirRegistry({ root: opts.root, def });
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (next !== existing) writeFileSync(file, next);
  }
}
```

Replaces the current `RUNTIMES` iteration, `renderPluginRegistry`, and the web vs server format branching.

## 4. Consumer migration

### Web — `plugins/framework/plugins/web-core/web/App.tsx`

**Before:** `import { pluginEntries } from "./plugins"` → `loadPlugins(pluginEntries)`

**After:** `import { webEntries } from "@plugins/framework/plugins/web-sdk/core/web.generated"` → `loadPlugins(webEntries)`

Update `loadPlugins` in `web-sdk/core/loader.ts`: rename `PluginEntry.name` → `pluginPath`. The function body is structurally identical — `Promise.allSettled` on loaders, stamp `_hierarchyPath`.

### Server — `plugins/framework/plugins/server-core/bin/index.ts`

**Before:** `import { plugins } from "./plugins"` — already has `dependsOn` as object refs and `_hierarchyPath` mutated by generated file.

**After:**

```ts
import { serverEntries } from "../core/server.generated";

const results = await Promise.allSettled(
  serverEntries.map(e => e.loader() as Promise<{ default: ServerPluginDefinition }>)
);
const byPath = new Map<string, ServerPluginDefinition>();
for (let i = 0; i < results.length; i++) {
  const r = results[i]!, e = serverEntries[i]!;
  if (r.status === "rejected") { console.error(`[plugin.${e.pluginPath}] load failed`, r.reason); continue; }
  const plugin = r.value.default;
  plugin._hierarchyPath = e.hierarchyPath;
  byPath.set(e.pluginPath, plugin);
}
// Resolve dependsOn strings → object references
for (const e of serverEntries) {
  const plugin = byPath.get(e.pluginPath);
  if (!plugin) continue;
  plugin.dependsOn = e.dependsOn.map(p => byPath.get(p)).filter(Boolean);
}
const ordered = topoSortPlugins([...byPath.values()]);
```

Rest of `bin/index.ts` (route tables, Bun.serve, register/onReady phases) unchanged.

### Central — `plugins/framework/plugins/central-core/bin/index.ts`

Same pattern as server.

### Check — `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts`

**Before:** `buildPluginTree` → walk nodes → `existsSync(check/index.ts)` → dynamic import

**After:**

```ts
import { checkEntries } from "./check.generated";

async function loadAllChecks(): Promise<Check[]> {
  const results = await Promise.allSettled(
    checkEntries.map(e => e.loader())
  );
  const out: Check[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!, e = checkEntries[i]!;
    if (r.status === "rejected") { console.warn(`[check] failed: ${e.pluginPath}`, r.reason); continue; }
    const exported = (r.value as { default?: unknown }).default;
    const checks = Array.isArray(exported) ? exported : exported ? [exported] : [];
    for (const c of checks) {
      if (!isCheck(c) || seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      out.push(c);
    }
  }
  return out;
}
```

Removes `buildPluginTree` import and `getRoot()` from this file.

### Lint — `eslint.config.ts`

**Before:** `discoverPluginContributions()` with `findPluginDirs` + `existsSync` walk

**After:**

```ts
import { lintEntries } from "./plugins/framework/plugins/tooling/plugins/lint/core/lint.generated";

const results = await Promise.allSettled(lintEntries.map(e => e.loader()));
const contributions: PluginContribution[] = [];
for (let i = 0; i < results.length; i++) {
  const r = results[i]!, e = lintEntries[i]!;
  if (r.status === "rejected") { console.warn(`[eslint] ${e.pluginPath}/lint failed`); continue; }
  const def = (r.value as { default?: { name?: string; rules?: Record<string, unknown> } }).default;
  if (!def?.name || !def.rules) continue;
  contributions.push({ relPath: e.pluginPath, name: def.name, rules: def.rules });
}
```

Deletes `discoverPluginContributions`. Keeps `findPluginDirs` + `discoverAllowDefaultProject` imports (used for `allowDefaultProject`, unchanged).

## 5. Sync check update

`plugins-registry-in-sync` replaces hardcoded `RUNTIMES` loop with:

```ts
import { discoverCollectedDirs, renderCollectedDirRegistry, collectedDirRegistryPath }
  from "@plugins/framework/plugins/tooling/plugins/codegen/core";

async run() {
  const root = await getRoot();
  const defs = await discoverCollectedDirs(root);
  for (const def of defs) {
    const file = collectedDirRegistryPath(root, def);
    const expected = renderCollectedDirRegistry({ root, def });
    // byte-for-byte comparison, same as today
  }
  return { ok: true };
}
```

Automatically covers any future collected dir — no check updates needed.

## 6. Files to change

### Create

| File | Purpose |
|------|---------|
| `plugins/framework/plugins/tooling/plugins/codegen/core/collected-dir.ts` | `defineCollectedDir`, `isCollectedDirDef`, `CollectedDirDef` |

### Modify

| File | Change |
|------|--------|
| `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` | Replace `RUNTIMES` + web/server format split with `discoverCollectedDirs` + `renderCollectedDirRegistry`. Generalize `buildDependsOn` to any dir. |
| `plugins/framework/plugins/tooling/plugins/codegen/core/index.ts` | Re-export new API. Remove `Runtime`, `pluginRegistryPath`, `renderPluginRegistry`. |
| `plugins/framework/plugins/web-sdk/core/index.ts` | Add `defineCollectedDir("web")` export |
| `plugins/framework/plugins/server-core/core/index.ts` | Add `defineCollectedDir("server")` export |
| `plugins/framework/plugins/central-core/core/index.ts` | Add `defineCollectedDir("central")` export |
| `plugins/framework/plugins/tooling/plugins/checks/core/index.ts` | Add `defineCollectedDir("check")` export |
| `plugins/framework/plugins/tooling/plugins/lint/core/index.ts` | Add `defineCollectedDir("lint")` export |
| `plugins/framework/plugins/web-sdk/core/loader.ts` | `PluginEntry.name` → `pluginPath` |
| `plugins/framework/plugins/web-core/web/App.tsx` | Import from `web.generated` |
| `plugins/framework/plugins/server-core/bin/index.ts` | Import from `server.generated`, resolve dependsOn |
| `plugins/framework/plugins/central-core/bin/index.ts` | Import from `central.generated`, resolve dependsOn |
| `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` | Import from `check.generated`, remove `buildPluginTree` |
| `eslint.config.ts` | Import from `lint.generated`, remove `discoverPluginContributions` |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/plugins-registry-in-sync/check/index.ts` | Generic `discoverCollectedDirs` loop |

### Delete

| File | Reason |
|------|--------|
| `plugins/framework/plugins/web-core/web/plugins.generated.ts` | Replaced by `web-sdk/core/web.generated.ts` |
| `plugins/framework/plugins/web-core/web/plugins.ts` | Relay, no longer needed |
| `plugins/framework/plugins/server-core/bin/plugins.generated.ts` | Replaced by `server-core/core/server.generated.ts` |
| `plugins/framework/plugins/server-core/bin/plugins.ts` | Relay, no longer needed |
| `plugins/framework/plugins/central-core/bin/plugins.generated.ts` | Replaced by `central-core/core/central.generated.ts` |
| `plugins/framework/plugins/central-core/bin/plugins.ts` | Relay, no longer needed |

### Generated (by `./equin build`)

| File | Export |
|------|--------|
| `plugins/framework/plugins/web-sdk/core/web.generated.ts` | `webEntries` |
| `plugins/framework/plugins/server-core/core/server.generated.ts` | `serverEntries` |
| `plugins/framework/plugins/central-core/core/central.generated.ts` | `centralEntries` |
| `plugins/framework/plugins/tooling/plugins/checks/core/check.generated.ts` | `checkEntries` |
| `plugins/framework/plugins/tooling/plugins/lint/core/lint.generated.ts` | `lintEntries` |

## 7. Adding a new collected dir

1. In the owning plugin's `core/index.ts`: `export const guardCollectedDir = defineCollectedDir("guard")`
2. `./equin build` — generates `<ownerPlugin>/core/guard.generated.ts`
3. Write a consumer that imports `guardEntries` from the generated file
4. Commit the generated file — `plugins-registry-in-sync` catches drift

No hardcoded lists. No custom discovery code. No codegen flags.

## 8. Verification

1. `./equin build` generates all 5 `.generated.ts` files
2. `./equin check` passes (including `plugins-registry-in-sync` covering all 5 files)
3. App loads at `http://<worktree>.localhost:9000` — all web plugins render
4. Server starts — topo-sort works, `dependsOn` resolved correctly
5. `./equin check --eslint` discovers lint rules from `lint.generated.ts`
6. All checks run via `check.generated.ts`
7. Smoke test: add `defineCollectedDir("guard")` temporarily, build, verify `guard.generated.ts` appears, remove
