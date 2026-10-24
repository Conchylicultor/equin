# Checks as Independent Sub-Plugins

## Context

The checks system has 20 built-in checks hardcoded in a `CHECKS` array in `runner.ts`, each a separate `.ts` file but registered centrally. Adding or removing a check requires editing the array and its imports. Meanwhile, plugin-contributed checks (endpoints, paths, welcome) use a separate, fully dynamic discovery path — `loadPluginChecks` walks the plugin tree looking for `check/index.ts` files.

This plan unifies both paths: every check becomes a self-contained sub-plugin discovered dynamically. No central registration, no static array.

## Design

### Sub-plugin structure

Each built-in check moves to `plugins/framework/plugins/tooling/plugins/checks/plugins/<name>/check/index.ts`:

```
checks/
  plugins/
    allow-default-project/
      check/index.ts       # export default <check>
      package.json
    config-origins-in-sync/
      check/index.ts
      package.json
    conversation-trailer/
      check/index.ts
      package.json
    eslint/
      check/index.ts
      package.json
    migrations-in-sync/
      check/index.ts
      package.json
    no-plugin-imports-in-core/
      check/index.ts
      package.json
    no-plugin-workspace-deps/
      check/index.ts
      package.json
    no-raw-event-source/
      check/index.ts
      package.json
    no-raw-sse/
      check/index.ts
      package.json
    no-raw-websocket/
      check/index.ts
      package.json
    no-reexport-default/
      check/index.ts
      package.json
    no-relative-server-imports/
      check/index.ts
      package.json
    no-use-resource-cast/
      check/index.ts
      package.json
    plugin-boundaries/
      check/index.ts       # large file, moves verbatim
      package.json
    plugins-doc-in-sync/
      check/index.ts
      package.json
    plugins-have-claudemd/
      check/index.ts
      package.json
    plugins-registry-in-sync/
      check/index.ts
      package.json
    snapshot-chain-intact/
      check/index.ts
      package.json
    typescript/
      check/index.ts
      package.json
  core/
    runner.ts              # gutted: glob discovery, no CHECKS array
    index.ts               # barrel, removes CHECKS export
    types.ts               # unchanged
```

19 sub-plugins under `checks/plugins/`. The 20th check (`boundary-rules`) stays in the `boundaries` plugin — it already lives there, just needs a `check/index.ts` barrel added.

Each sub-plugin is check-only — no `core/`, `web/`, or `server/` barrel. Each gets a `package.json` with standard naming (`@singularity/plugin-framework-tooling-checks-<name>`, `"private": true`) for consistency with other plugins, even though the framework doesn't discover them via `findAllPluginDirs`.

### Discovery: direct glob, not buildPluginTree

`findAllPluginDirs` (in `plugin-tree.ts:547`) recognizes plugins by the presence of `web/`, `server/`, `central/`, `shared/`, or `core/` barrels. Check-only sub-plugins have none of these, so `buildPluginTree` won't find them.

Rather than modifying the framework to add `check/` as a plugin marker (invasive, affects codegen/docgen/registry), the runner switches to a **direct filesystem glob**: recursively walk `plugins/` looking for `**/check/index.ts` files. This:

- Finds the 19 new sub-plugins under `checks/plugins/*/check/index.ts`
- Finds the `boundaries/check/index.ts` barrel
- Finds existing plugin-contributed checks (`endpoints/check/index.ts`, `paths/check/index.ts`, `welcome/check/index.ts`)
- Eliminates the `buildPluginTree` dependency entirely

```ts
// New discovery in runner.ts
async function loadAllChecks(root: string): Promise<Check[]> {
  const pluginsRoot = join(root, "plugins");
  if (!existsSync(pluginsRoot)) return [];

  const checkBarrels = findCheckBarrels(pluginsRoot);  // recursive glob
  checkBarrels.sort();  // deterministic order

  const out: Check[] = [];
  const seenIds = new Set<string>();

  for (const barrel of checkBarrels) {
    const rel = relative(pluginsRoot, barrel);
    let mod: { default?: unknown };
    try {
      mod = await import(barrel);
    } catch (err) {
      console.warn(`  [check loader] failed to import ${rel}: ${err}`);
      continue;
    }
    const checks = Array.isArray(mod.default) ? mod.default : mod.default ? [mod.default] : [];
    for (const c of checks) {
      if (!isCheck(c)) {
        console.warn(`  [check loader] ${rel}: skipping non-Check export`);
        continue;
      }
      if (seenIds.has(c.id)) {
        console.warn(`  [check loader] ${rel}: duplicate id "${c.id}"; skipping`);
        continue;
      }
      seenIds.add(c.id);
      out.push(c);
    }
  }
  return out;
}

function findCheckBarrels(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string, depth: number) {
    if (depth > 12) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      const child = join(d, e.name);
      if (e.name === "check") {
        const barrel = join(child, "index.ts");
        if (existsSync(barrel)) out.push(barrel);
      } else {
        walk(child, depth + 1);
      }
    }
  }
  walk(dir, 0);
  return out;
}
```

### CLI: positional args replace --flags

Current: `./equin check --migrations-in-sync --eslint`
New: `./equin check migrations-in-sync eslint`

```ts
// cli/src/commands/check.ts
export function registerCheck(program: Command) {
  program
    .command("check")
    .description("Run repo validation checks")
    .argument("[checks...]", "Check IDs to run (default: all)")
    .option("--list", "List available checks and exit")
    .action(async (checks: string[], opts: { list?: boolean }) => {
      if (opts.list) {
        const all = await listAllChecks();
        for (const c of all) console.log(`  ${c.id} — ${c.description}`);
        return;
      }
      await checkBroadcasts("check");
      const ok = await runChecks(checks.length > 0 ? checks : undefined);
      if (!ok) process.exit(1);
    });
}
```

Removes `CHECKS` import, `camel()` helper, and the flag registration loop.

### Public barrel changes

`checks/core/index.ts` removes `CHECKS`:

```ts
export { runChecks, listAllChecks } from "./runner";
export type { RunChecksOptions } from "./runner";
export type { Check, CheckResult } from "./types";
```

Consumers: `build.ts` imports only `runChecks` (unaffected). `push.ts` spawns `./equin check` as subprocess (unaffected).

### Type imports in sub-plugins

Sub-plugin check files must import `Check`/`CheckResult` from `@plugins/framework/plugins/tooling/core` (the canonical source), NOT from `checks/core` (that would be importing from the parent plugin). Alternatively, they can inline the types locally like existing plugin-contributed checks do. The inline approach is simpler and avoids cross-plugin import edges.

### Self-referencing ALLOWED_PATHS

Three check files self-exempt their own path in ALLOWED_PATHS:
- `no-raw-websocket.ts` → `"plugins/framework/plugins/tooling/plugins/checks/core/no-raw-websocket.ts"`
- `no-raw-event-source.ts` → `"plugins/framework/plugins/tooling/plugins/checks/core/no-raw-event-source.ts"`
- `no-raw-sse.ts` → `"plugins/framework/plugins/tooling/plugins/checks/core/no-raw-sse.ts"`

These update to the new paths:
- `"plugins/framework/plugins/tooling/plugins/checks/plugins/no-raw-websocket/check/index.ts"`
- etc.

One external reference also needs updating — `paths/check/index.ts` ALLOWED_PATHS contains `"plugins/framework/plugins/tooling/plugins/checks/core/migrations-in-sync.ts"`, updating to `"plugins/framework/plugins/tooling/plugins/checks/plugins/migrations-in-sync/check/index.ts"`.

### The `scripts/` directory

`checks/core/scripts/fix-shared-to-relative.ts` is a one-off fix script, not a check. It stays in `checks/core/scripts/` (or moves to `checks/scripts/` for cleanliness).

### boundary-rules check

The `boundaries` plugin already owns `boundaryRulesCheck` in its `core/`. Add `plugins/framework/plugins/tooling/plugins/boundaries/check/index.ts`:

```ts
export { boundaryRulesCheck as default } from "../core";
```

The glob walker finds it automatically. No changes to `boundaries/core/`.

## Implementation steps

### Step 1: Create sub-plugin directories and move check files

For each of the 19 built-in checks (all except boundary-rules):
- Create `checks/plugins/<name>/check/index.ts`
- Create `checks/plugins/<name>/package.json` with `@singularity/plugin-framework-tooling-checks-<name>` naming
- Move the check logic from `checks/core/<name>.ts`
- Change `import type { Check } from "./types"` to inline type declaration
- Change `export const <name>: Check = { ... }` to `export default { ... } satisfies Check`
- Update self-referencing ALLOWED_PATHS where applicable

For `boundary-rules`:
- Create `boundaries/check/index.ts` re-exporting from `../core`

### Step 2: Rewrite runner.ts

- Delete the CHECKS array and all 20 static imports
- Delete `buildPluginTree` import
- Replace `loadPluginChecks` with `loadAllChecks` (direct glob)
- `listAllChecks` calls `loadAllChecks` directly
- `runChecks` unchanged
- Keep `isCheck`, `getRoot`, `RunChecksOptions`

### Step 3: Update public barrel and CLI

- Remove `CHECKS` from `checks/core/index.ts`
- Rewrite `cli/src/commands/check.ts` to positional args
- Remove `CHECKS` import from `check.ts`

### Step 4: Update external ALLOWED_PATHS

- `paths/check/index.ts`: update `checks/core/migrations-in-sync.ts` → `checks/plugins/migrations-in-sync/check/index.ts`

### Step 5: Delete old check files from `checks/core/`

Delete all 19 individual `.ts` files (keep `runner.ts`, `index.ts`, `types.ts`, `scripts/`).

### Step 6: Update CLAUDE.md files

- `checks/CLAUDE.md` — reflect new structure, remove CHECKS from exports
- `tooling/CLAUDE.md` — mention check sub-plugin convention

## Files to modify

| File | Change |
|------|--------|
| `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` | Gut and rewrite: glob discovery |
| `plugins/framework/plugins/tooling/plugins/checks/core/index.ts` | Remove CHECKS export |
| `cli/src/commands/check.ts` | Positional args, remove CHECKS |
| `plugins/framework/plugins/tooling/plugins/boundaries/check/index.ts` | **New** — re-export boundaryRulesCheck |
| `plugins/infra/plugins/paths/check/index.ts` | Update ALLOWED_PATHS |
| 19 new `checks/plugins/<name>/check/index.ts` files | **New** — moved check logic |
| 19 old `checks/core/<name>.ts` files | **Delete** |

## Verification

1. `./equin check --list` — should show all 24 checks (19 built-in sub-plugins + boundary-rules + endpoints×2 + paths + welcome)
2. `./equin check` — all checks pass
3. `./equin check eslint typescript` — positional args work
4. `./equin check nonexistent` — prints "Unknown check(s): nonexistent"
5. `./equin build` — build succeeds (build.ts calls runChecks)
