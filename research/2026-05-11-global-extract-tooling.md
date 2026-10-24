# Extract `tooling/` from `cli/src/`

## Context

`cli/src/` currently houses four independent subsystems that the CLI orchestrates but doesn't own:

- **checks/** — 16 repo validation checks + framework (types, runner, plugin discovery)
- **boundaries/** — Zone-DAG boundary engine (6 files)
- **guards/** — Pre-tool-use hooks for Claude Code (14 files, standalone Bun script entry point)
- **lint/** — Global ESLint rules (promise-safety, 3 files)

These are conceptually separate from the CLI command infrastructure. Guards aren't even a CLI command — they're invoked directly by Claude Code's hook system. Lint rules are consumed by `eslint.config.ts`, not the CLI. Moving them to a top-level `tooling/` workspace makes their independence explicit and the CLI a thin orchestrator.

A companion module, **`docgen.ts`**, must also move because two checks (`plugins-doc-in-sync`, `plugins-have-claudemd`) import heavily from it, and `tooling/` should not depend back on `cli/`.

## Plan

### 1. Create `tooling/` workspace scaffold

**New files:**

`tooling/package.json`:
```json
{
  "name": "@singularity/tooling",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "~5.8.3"
  }
}
```

`tooling/tsconfig.json` — mirrors `cli/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["@types/bun"],
    "paths": {
      "@plugins/*": ["../plugins/*"],
      "@tooling/*": ["./src/*"]
    }
  },
  "include": ["src", "../plugins/packages/plugins/*/shared"]
}
```

### 2. Move files from `cli/src/` → `tooling/src/`

| Old location | New location |
|---|---|
| `cli/src/checks/` (entire dir) | `tooling/src/checks/` |
| `cli/src/boundaries/` (entire dir) | `tooling/src/boundaries/` |
| `cli/src/guards/` (entire dir) | `tooling/src/guards/` |
| `cli/src/lint/` (entire dir) | `tooling/src/lint/` |
| `cli/src/guard.ts` | `tooling/src/guard.ts` |
| `cli/src/docgen.ts` | `tooling/src/docgen.ts` |

Delete all originals from `cli/src/` after creating the new files.

### 3. Fix imports within moved files

**`tooling/src/guards/guards/main-edits.ts`** — inline `HOME_DIR`:
- Remove: `import { HOME_DIR } from "../../paths";`
- Add: `import { homedir } from "node:os";` + `const HOME_DIR = homedir();`

**`tooling/src/checks/migrations-in-sync.ts`** — inline `libpqEnv`:
- Remove: `import { libpqEnv } from "../paths";`
- Inline the `libpqEnv()` function and its `readDatabaseConfig()` helper locally (reads `~/.singularity/database.json`). ~25 lines total from `cli/src/paths.ts`. This is preferable to moving all of `paths.ts` since the rest of `paths.ts` (PG_DIR, PG_DATA_DIR, PG_LOG_FILE, SINGULARITY_DIR, readDatabaseConfig) is only used by CLI commands.

**`tooling/src/checks/plugins-doc-in-sync.ts`** and **`tooling/src/checks/plugins-have-claudemd.ts`**:
- Change: `from "../docgen"` → `from "../docgen"` (same relative path, no change needed — docgen moves alongside)

**`tooling/src/checks/index.ts`**:
- `from "../boundaries/check"` — unchanged (still siblings under `tooling/src/`)
- `from "../../../boundary.config"` — unchanged (tooling/src/checks → 3 levels up = repo root)

**`tooling/src/boundaries/check.ts`**:
- `from "../checks/types"` — unchanged (siblings under `tooling/src/`)

**`tooling/src/guard.ts`**:
- `from "./guards/runner"` — unchanged

All `@plugins/...` alias imports remain unchanged.

### 4. Update workspace configuration

**`package.json` (root)** — add `"tooling"` to workspaces:
```json
"workspaces": ["web", "server", "central", "plugin-core", "plugins/**", "cli", "tooling"]
```

**`tsconfig.json` (root)** — add `@tooling/*` alias:
```json
"paths": {
  "@plugins/*": ["./plugins/*"],
  "@server/*": ["./server/src/*"],
  "@central/*": ["./central/src/*"],
  "@core/*": ["./plugin-core/*"],
  "@tooling/*": ["./tooling/src/*"]
}
```

**`cli/tsconfig.json`** — add `@tooling/*` alias:
```json
"paths": {
  "@plugins/*": ["../plugins/*"],
  "@tooling/*": ["../tooling/src/*"]
}
```

### 5. Update CLI consumers

**`cli/src/commands/check.ts`**:
```ts
import { CHECKS, listAllChecks, runChecks } from "@tooling/checks";
```

**`cli/src/commands/build.ts`**:
```ts
import { runChecks } from "@tooling/checks";
import { generatePluginDocs, collectAllPlugins } from "@tooling/docgen";
```

**`cli/src/commands/regen-docs.ts`**:
```ts
import { generatePluginDocs } from "@tooling/docgen";
```

### 6. Update root config files

**`eslint.config.ts`**:
```ts
import { promiseSafetyRules } from "./tooling/src/lint/promise-safety/index";
```
(Use relative path — `eslint.config.ts` is loaded by `jiti` which may not resolve tsconfig aliases reliably. The relative path is unambiguous.)

**`boundary.config.ts`**:
```ts
import { defineBoundaries, zone, allow, deny } from "./tooling/src/boundaries/config";
```

Add `tooling` zone and allow edges:
```ts
zones: [
  // ... existing zones ...
  zone("tooling", { match: "tooling" }),
],
edges: [
  // ... existing edges ...
  allow("tooling -> core"),
],
```

Add root config files to exclude list:
```ts
exclude: [
  // ... existing excludes ...
  "boundary.config.ts",
  "eslint.config.ts",
],
```

### 7. Update boundary checker SOURCE_ROOTS

**`tooling/src/boundaries/check.ts`** — add `"tooling/src"` to `SOURCE_ROOTS`:
```ts
const SOURCE_ROOTS = ["plugins", "web/src", "server/src", "central/src", "plugin-core", "cli/src", "tooling/src"];
```

### 8. Update `.claude/settings.json` hook path

```json
"command": "bun tooling/src/guard.ts"
```

### 9. Update typescript check

**`tooling/src/checks/typescript.ts`** — add `tooling/` as a type-check target:
```ts
const [web, server, tooling] = await Promise.all([
  runTsc(`${root}/web`, ["-p", "tsconfig.app.json"]),
  runTsc(`${root}/server`, []),
  runTsc(`${root}/tooling`, []),
]);
```
Update result merging to include `tooling`.

### 10. Update documentation references

- `eslint.config.ts` top comment: `cli/src/lint/` → `tooling/src/lint/`
- `tooling/src/checks/eslint.ts` hint string: `cli/src/lint/` → `tooling/src/lint/`
- `CLAUDE.md` references to `cli/src/checks/`, `cli/src/guards/`, `cli/src/lint/` → `tooling/src/...`

## Files to modify (summary)

| File | Action |
|---|---|
| `tooling/package.json` | Create |
| `tooling/tsconfig.json` | Create |
| `tooling/src/checks/*` | Move from `cli/src/checks/` |
| `tooling/src/boundaries/*` | Move from `cli/src/boundaries/` |
| `tooling/src/guards/*` | Move from `cli/src/guards/` |
| `tooling/src/lint/*` | Move from `cli/src/lint/` |
| `tooling/src/guard.ts` | Move from `cli/src/guard.ts` |
| `tooling/src/docgen.ts` | Move from `cli/src/docgen.ts` |
| `package.json` (root) | Add `"tooling"` to workspaces |
| `tsconfig.json` (root) | Add `@tooling/*` path alias |
| `cli/tsconfig.json` | Add `@tooling/*` path alias |
| `cli/src/commands/check.ts` | Import from `@tooling/checks` |
| `cli/src/commands/build.ts` | Import from `@tooling/checks` and `@tooling/docgen` |
| `cli/src/commands/regen-docs.ts` | Import from `@tooling/docgen` |
| `eslint.config.ts` | Update import path + comment |
| `boundary.config.ts` | Update import path + add tooling zone/edges/excludes |
| `.claude/settings.json` | Update guard hook command path |
| `CLAUDE.md` | Update path references |

## Verification

1. `bun install` — workspace resolution picks up `tooling/`
2. `./equin build` — full build succeeds (runs checks, type-checks, builds frontend)
3. `./equin check` — all checks pass including `typescript`, `eslint`, `boundary-rules`, `plugin-boundaries`
4. Verify guard works: create a test file edit outside the worktree and confirm the guard blocks it
5. `bunx tsc --noEmit` in `tooling/` — no type errors
