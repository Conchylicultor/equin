# Phase 7.2: Lint → `tooling/plugins/lint/`

Migrate `tooling/src/lint/` (promise-safety ESLint rules) and `tooling/src/eslint/` (discovery helpers) into `plugins/framework/plugins/tooling/plugins/lint/` as a self-contained sub-plugin.

## Context

Phase 7 decomposes `tooling/` into sub-plugins under `plugins/framework/plugins/tooling/`. Phase 7.0 created the umbrella scaffold and 7.1 migrated guards. This sub-task migrates lint — fully independent, consumed only by `eslint.config.ts` (root) and by `tooling/src/checks/` (updated later in 7.5).

## File moves

### Source → destination

| Old path | New path |
|----------|----------|
| `tooling/src/lint/promise-safety/index.ts` | `plugins/framework/plugins/tooling/plugins/lint/core/promise-safety/index.ts` |
| `tooling/src/lint/promise-safety/no-bare-catch.ts` | `plugins/framework/plugins/tooling/plugins/lint/core/promise-safety/no-bare-catch.ts` |
| `tooling/src/lint/promise-safety/no-floating-promises.ts` | `plugins/framework/plugins/tooling/plugins/lint/core/promise-safety/no-floating-promises.ts` |
| `tooling/src/eslint/allow-default-project.ts` | `plugins/framework/plugins/tooling/plugins/lint/core/allow-default-project.ts` |

### New files to create

| File | Contents |
|------|----------|
| `plugins/framework/plugins/tooling/plugins/lint/package.json` | Minimal: `@singularity/plugin-framework-tooling-lint`, description, private |
| `plugins/framework/plugins/tooling/plugins/lint/core/index.ts` | Barrel: re-exports `promiseSafetyRules`, `discoverAllowDefaultProject`, `findPluginDirs` |

### Files to delete

- `tooling/src/lint/` (entire directory)
- `tooling/src/eslint/` (entire directory)

## Implementation steps

### 1. Create the lint sub-plugin scaffold

**`plugins/framework/plugins/tooling/plugins/lint/package.json`**:
```json
{
  "name": "@singularity/plugin-framework-tooling-lint",
  "version": "0.0.1",
  "private": true,
  "description": "Global ESLint rules (promise-safety) and discovery helpers for the ESLint config"
}
```

### 2. Move source files

Copy the four source files into `core/`, preserving their internal structure:
- `promise-safety/` subdirectory stays as-is (internal imports are relative, no changes needed)
- `allow-default-project.ts` moves to `core/` root

No edits needed to moved files — all internal imports are relative and all external imports are from npm packages (`@typescript-eslint/utils`, `@typescript-eslint/eslint-plugin`, `fs`, `path`).

### 3. Create the barrel

**`plugins/framework/plugins/tooling/plugins/lint/core/index.ts`**:
```ts
export { promiseSafetyRules } from "./promise-safety/index";
export {
  discoverAllowDefaultProject,
  findPluginDirs,
} from "./allow-default-project";
```

### 4. Update `eslint.config.ts`

Replace two import lines:
```ts
// Before:
import { discoverAllowDefaultProject, findPluginDirs } from "./tooling/src/eslint/allow-default-project";
import { promiseSafetyRules } from "./tooling/src/lint/promise-safety/index";

// After:
import {
  discoverAllowDefaultProject,
  findPluginDirs,
  promiseSafetyRules,
} from "./plugins/framework/plugins/tooling/plugins/lint/core";
```

### 5. Delete old files

- `rm -r tooling/src/lint/`
- `rm -r tooling/src/eslint/`

### 6. Leave checks consumers alone (deferred to 7.5)

Two files in `tooling/src/checks/` depend on the moved modules but are NOT updated in this sub-task:
- `tooling/src/checks/allow-default-project.ts` — imports `discoverAllowDefaultProject` from `../eslint/allow-default-project`. After deletion, this relative path breaks. **Temporary fix**: add a re-export shim at the old path so checks keep working until 7.5 migrates them.
- `tooling/src/checks/eslint.ts` — hardcoded string `join(root, "tooling", "src", "lint")` for cache-busting mtime check. After deletion, the path won't exist. **Temporary fix**: update this single string path to the new location.

**Re-export shim** at `tooling/src/eslint/allow-default-project.ts`:
```ts
export { discoverAllowDefaultProject } from "@plugins/framework/plugins/tooling/plugins/lint/core";
```

**Path fix** in `tooling/src/checks/eslint.ts` line 37:
```ts
// Before:
join(root, "tooling", "src", "lint"),
// After:
join(root, "plugins", "framework", "plugins", "tooling", "plugins", "lint", "core"),
```

Also update the `hint` string on line 111 that references `tooling/src/lint/`:
```ts
// Before:
"Global rules live in tooling/src/lint/; plugin rules in plugins/<name>/lint/index.ts."
// After:
"Global rules live in plugins/framework/plugins/tooling/plugins/lint/core/; plugin rules in plugins/<name>/lint/index.ts."
```

## Critical files

- `plugins/framework/plugins/tooling/plugins/lint/core/index.ts` — new barrel
- `plugins/framework/plugins/tooling/plugins/lint/package.json` — new package
- `eslint.config.ts` — consumer import path update
- `tooling/src/eslint/allow-default-project.ts` — re-export shim (temporary until 7.5)
- `tooling/src/checks/eslint.ts` — path string fix

## Verification

1. `bunx eslint . --cache` — runs without import errors, rules fire correctly
2. `./equin check --eslint` — passes (cache-busting uses new path)
3. `./equin check --allow-default-project-in-sync` — passes (shim re-exports correctly)
4. `./equin check` — all checks pass
5. `./equin build` — full build succeeds
