# Packages Convention

## Context

The CLI intentionally cannot depend on plugins to keep the dependency graph clean. But some utility logic (plugin graph extraction in `cli/src/docgen.ts`) is useful to both CLI and server. The `findAllPluginDirs` walk is duplicated 3× today (docgen, checks/index, plugin-boundaries). We need a shared-code home that both CLI and server can import without creating cycles.

**Solution:** introduce `packages/` — pure TypeScript libraries with no framework awareness. Enforce boundaries via a new check, mirroring the existing `plugin-boundaries` enforcement.

## Design

### What is a package?

A pure TS library. No `definePlugin`, no slots, no contributions. Identity-less — just code that gets imported.

**Can import:** other packages, external deps.
**Cannot import:** plugins (`@plugins/*`), plugin-core (`@core/*`), server (`@server/*`), central (`@central/*`), web, CLI internals.
**Can be imported by:** CLI, server, central, web, plugins.

### Alias: `@packages/*` → `./packages/*`

Consistent with `@core/*` → `./plugin-core/*`. Resolved via tsconfig `paths` (no npm-style `main`/`exports`).

## Implementation

### Step 1: Workspace wiring

**`package.json`** (root) — add workspace:
```json
"workspaces": ["web", "server", "central", "plugin-core", "plugins/**", "cli", "packages/*"]
```

**`tsconfig.json`** (root) — add path:
```json
"@packages/*": ["./packages/*"]
```

**`cli/tsconfig.json`** — add paths block + include:
```json
{
  "compilerOptions": {
    ...existing...,
    "paths": { "@packages/*": ["../packages/*"] }
  },
  "include": ["src", "../packages/*"]
}
```

**`server/tsconfig.json`** — add to paths + include:
```json
"@packages/*": ["../packages/*"]
// include: add "../packages/*"
```

**`central/tsconfig.json`** — same as server.

**`web/tsconfig.app.json`** — paths only (no include needed for Vite):
```json
"@packages/*": ["../packages/*"]
```

### Step 2: Create empty `packages/` directory

Create `packages/.gitkeep` so the directory exists and the workspace glob resolves.

### Step 3: New check — `package-boundaries`

**`cli/src/checks/package-boundaries.ts`**

Rules:
| Rule | Violation |
|------|-----------|
| PB1 | Package imports from `@plugins/*` |
| PB2 | Package imports from `@core/*`, `@server/*`, `@central/*` |
| PB3 | Package imports workspace names (`@singularity/server`, etc.) |
| PB4 | Package relative-escapes into non-package dirs (`../../server/`) |

Scanner: same regex-based approach as `plugin-boundaries.ts`. Strip comments, extract import specifiers, check against forbidden prefixes.

Register in `cli/src/checks/index.ts`:
```ts
import { packageBoundaries } from "./package-boundaries";
export const CHECKS: Check[] = [...existing, packageBoundaries];
```

### Step 4: Document the convention in CLAUDE.md

Add a `### Packages` section to the root CLAUDE.md explaining:
- What packages are (pure TS libs, no framework awareness)
- Boundary rules (what they can/cannot import)
- Naming convention (`@singularity/<name>`, `@packages/<name>` alias)
- When to use a package vs a plugin

## Files

**New (2):**
- `packages/.gitkeep`
- `cli/src/checks/package-boundaries.ts`

**Modified (7):**
- `package.json` — workspaces
- `tsconfig.json` — paths
- `cli/tsconfig.json` — paths + include
- `server/tsconfig.json` — paths + include
- `central/tsconfig.json` — paths + include
- `web/tsconfig.app.json` — paths
- `cli/src/checks/index.ts` — add package-boundaries to CHECKS
- `CLAUDE.md` — document the convention

## Verification

1. `bun install` — workspace glob resolves (no errors even with empty packages/)
2. `./equin check --package-boundaries` — passes (no packages with violations yet)
3. `./equin check --plugin-boundaries` — still passes (no regressions)
4. Create a temporary test package with a `@plugins/...` import → check fails with PB1
