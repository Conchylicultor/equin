# Phase 7.6: Final cleanup — delete old `tooling/`, update stale references

## Context

Phases 7.0–7.5 migrated all code from the root `tooling/` directory into `plugins/framework/plugins/tooling/` as sub-plugins (boundaries, checks, codegen, guards, lint). The old `tooling/` directory now contains only two empty shell files (`package.json`, `tsconfig.json`) — no source code, no meaningful config. This phase deletes the husk and updates the handful of stale string references that still point to the old location.

## Changes

### 1. Delete `tooling/` directory

Remove the two remaining files:
- `tooling/package.json` (empty `@singularity/tooling` shell)
- `tooling/tsconfig.json` (stale — references nonexistent `src/` dir)

### 2. Remove workspace entry — `package.json` (line 4)

```diff
- "workspaces": ["plugins/**", "cli", "tooling"],
+ "workspaces": ["plugins/**", "cli"],
```

### 3. Update CLAUDE.md (3 stale path references)

**Line 72** — folder structure tree: remove the `tooling/` entry entirely.
```diff
  ├── cli/              # Agent CLI (TypeScript, Commander.js)
- ├── tooling/          # Repo tooling: checks, guards, lint rules, boundary engine
  ├── sidequests/       # Independent side projects (see Sidequests section below)
```

**Line 118** — checks documentation: update path.
```diff
- New built-in checks live in `tooling/src/checks/` and are registered in `tooling/src/checks/index.ts`.
+ New built-in checks live in `plugins/framework/plugins/tooling/plugins/checks/core/` and are registered in `plugins/framework/plugins/tooling/plugins/checks/core/index.ts`.
```

**Line 205** — promise-safety lint rules: update path.
```diff
- Two global ESLint rules enforce this (`tooling/src/lint/promise-safety/`):
+ Two global ESLint rules enforce this (`plugins/framework/plugins/tooling/plugins/lint/core/promise-safety/`):
```

### 4. No `@tooling/*` alias cleanup needed

Audit confirmed: no `@tooling/*` path alias exists in any tsconfig (root, cli, or plugin). Prior phases already cleaned these up or they were never introduced. Nothing to do here.

### 5. No import changes needed

All TypeScript imports already use `@plugins/framework/plugins/tooling/plugins/...` paths. The only `tooling/` string matches in `.ts` files are:
- CLI commands — already using the new `@plugins/...` import paths (the string `tooling/` appears as part of the correct `plugins/framework/plugins/tooling/...` path)
- Generated files — comment-only references to the correct new location
- `plugins/infra/plugins/paths/check/index.ts` — allowlist strings already pointing to `plugins/framework/plugins/tooling/...`

### 6. Run `bun install`

After removing the workspace entry and deleting `tooling/`, run `bun install` to update the lockfile.

## Files modified

| File | Change |
|---|---|
| `tooling/package.json` | **Delete** |
| `tooling/tsconfig.json` | **Delete** |
| `package.json` | Remove `"tooling"` from workspaces |
| `CLAUDE.md` | Update 3 stale path references |

## Verification

1. `bun install` — succeeds without errors (no broken workspace reference)
2. `./equin build` — full build succeeds
3. `./equin check` — all checks pass
4. `rg '^[^/]*tooling/' --type ts` — no stale root-level `tooling/` references remain (matches inside `plugins/framework/plugins/tooling/` are expected and correct)
5. Confirm `plugins.generated.ts` files are unchanged (tooling contributes no runtime plugin entries)
