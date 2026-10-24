# Phase 7: `tooling/` → `plugins/framework/plugins/tooling/`

Implementation plan for the DAG migration phase that moves `tooling/` into the plugin tree as an umbrella of self-contained sub-plugins. Part of [`2026-05-12-global-plugin-dag-migration.md`](./2026-05-12-global-plugin-dag-migration.md).

## Context

`tooling/` is a build-time utility package: boundary checker, lint rules, checks, Claude Code guards, plugin doc generator, and plugin registry codegen. It sits outside the plugin DAG today as a top-level zone with a single explicit edge (`tooling -> plugin.framework.web-sdk`). Only three files import from it — all in `cli/src/commands/` — plus two root config files (`boundary.config.ts`, `eslint.config.ts`) via bare relative imports.

Unlike the flat-move approach, this plan **decomposes tooling into sub-plugins**, each with standard plugin structure (`core/` for public API, `bin/` for entry points). This keeps each concern self-contained and follows the project's modularity principle.

### Design decisions

1. **Sub-plugin decomposition, not monolithic move.** Each tooling concern (boundaries, checks, guards, lint, codegen) becomes its own sub-plugin under the `tooling` umbrella, with `core/` barrels and `bin/` entry points where applicable.

2. **`boundary.config.ts` lives with the boundaries plugin.** The root-level `boundary.config.ts` moves into the boundaries sub-plugin. The boundaries plugin owns both the DSL and the project config, exporting a ready-made `boundaryRulesCheck` from its barrel. This eliminates the fragile cross-package relative import entirely.

3. **`@tooling/*` alias removed as we go.** Each sub-task migrates its CLI consumers from `@tooling/*` to canonical `@plugins/...` barrel imports. By the final cleanup, no `@tooling/*` references remain.

4. **`Check`/`CheckResult` types live in the umbrella `core/`.** Both the `boundaries` and `checks` sub-plugins need these types — placing them in the umbrella breaks the cycle (`boundaries` produces a `Check`, `checks` consumes it) without either depending on the other for the type.

5. **Single tsconfig compilation unit preserved.** The umbrella `tsconfig.json` sweeps all sub-plugin `core/` and `bin/` dirs, keeping tooling as one TSC compilation unit.

---

## Target directory structure

```
plugins/framework/plugins/tooling/
  package.json                    ← @singularity/plugin-framework-tooling
  tsconfig.json                   ← sweeps all sub-plugin core/ + bin/
  core/
    index.ts                      ← Check, CheckResult types (shared by boundaries + checks)
  plugins/
    boundaries/
      core/
        index.ts                  ← exports DSL, createBoundaryCheck, boundaryRulesCheck
        config.ts                 ← defineBoundaries, zone, allow DSL
        check.ts                  ← createBoundaryCheck()
        evaluate.ts, match.ts, resolve.ts, types.ts
      boundary.config.ts          ← project boundary rules (imports DSL from core/)
    checks/
      core/
        index.ts                  ← runChecks, listAllChecks, CHECKS[]
        types.ts                  ← re-exports Check/CheckResult from umbrella core (convenience)
        *.ts                      ← individual check implementations
        scripts/
          fix-shared-to-relative.ts
    guards/
      core/
        index.ts                  ← GUARDS[], defineGuard, parseShell, createContext
        types.ts, define-guard.ts, runner.ts, parse-shell.ts, context.ts
        guards/*.ts               ← individual guard implementations
        hints/*.ts
      bin/
        guard.ts                  ← Claude Code hook entry point (stdin → runHook)
    lint/
      core/
        index.ts                  ← promiseSafetyRules, discoverAllowDefaultProject, findPluginDirs
        promise-safety/
          index.ts, no-bare-catch.ts, no-floating-promises.ts
        allow-default-project.ts
    codegen/
      core/
        index.ts                  ← generateDocs, generatePluginRegistry
        docgen.ts
        plugin-registry-gen.ts
```

---

## Internal dependency graph

```
tooling/core (Check types)
    ↑                ↑
boundaries/core    checks/core
    ↑                  ↑
    └──────────────────┘  checks imports boundaryRulesCheck from boundaries barrel
                          checks imports discoverAllowDefaultProject from lint barrel
    
lint/core  ←── checks/core (eslint check references lint source paths)
    
codegen/core     (independent — only CLI consumes)
guards/core+bin  (independent — only .claude/settings.json hook consumes)
```

No cycles. `Check`/`CheckResult` types in the umbrella `core/` are the shared currency.

---

## External consumer map

| Consumer | Current import | After migration |
|----------|---------------|-----------------|
| `cli/src/commands/build.ts` | `@tooling/docgen` | `@plugins/framework/plugins/tooling/plugins/codegen/core` |
| `cli/src/commands/build.ts` | `@tooling/plugin-registry-gen` | `@plugins/framework/plugins/tooling/plugins/codegen/core` |
| `cli/src/commands/build.ts` | `@tooling/checks` | `@plugins/framework/plugins/tooling/plugins/checks/core` |
| `cli/src/commands/check.ts` | `@tooling/checks` | `@plugins/framework/plugins/tooling/plugins/checks/core` |
| `cli/src/commands/regen-docs.ts` | `@tooling/docgen` | `@plugins/framework/plugins/tooling/plugins/codegen/core` |
| `eslint.config.ts` (root) | `./tooling/src/eslint/allow-default-project` | `./plugins/framework/plugins/tooling/plugins/lint/core` (barrel) |
| `eslint.config.ts` (root) | `./tooling/src/lint/promise-safety/index` | `./plugins/framework/plugins/tooling/plugins/lint/core` (barrel) |
| `.claude/settings.json` | `bun tooling/src/guard.ts` | `bun plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts` |
| `boundary.config.ts` (root) | `./tooling/src/boundaries/config` | **Deleted** — config moves into boundaries plugin |

---

## Sub-tasks

Migration is incremental — one sub-plugin per task. Each sub-task plans its own file-by-file details. The order below respects the dependency graph.

### Sub-task 7.0: Umbrella scaffold

Create the umbrella and lift shared types.

- Create `plugins/framework/plugins/tooling/` with `package.json`, `tsconfig.json`
- Create `core/index.ts` exporting `Check` and `CheckResult` types (currently in `tooling/src/checks/types.ts`)
- Update root `package.json`: remove `"tooling"` from workspaces (covered by `plugins/**`)
- **Do not delete anything yet** — old `tooling/` stays functional, sub-tasks migrate from it

### Sub-task 7.1: Guards → `tooling/plugins/guards/`

Fully independent — no other tooling module imports guards, and guards imports nothing from tooling.

- Move `tooling/src/guards/` → `plugins/framework/plugins/tooling/plugins/guards/core/`
- Move `tooling/src/guard.ts` → `plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts`
- Update `.claude/settings.json` hook path
- Delete moved files from old `tooling/`

**Verification:** Run a tool call in a fresh Claude Code session — the PreToolUse hook must fire.

### Sub-task 7.2: Lint → `tooling/plugins/lint/`

Fully independent — consumed only by `eslint.config.ts` (root) and by `checks/allow-default-project.ts` (updated in 7.5).

- Move `tooling/src/lint/` + `tooling/src/eslint/` → `plugins/framework/plugins/tooling/plugins/lint/core/`
- Update `eslint.config.ts` imports to point to the lint barrel
- Delete moved files from old `tooling/`

**Verification:** `bunx eslint . --max-warnings 0` runs without import errors.

### Sub-task 7.3: Boundaries → `tooling/plugins/boundaries/`

Fully independent. Absorbs `boundary.config.ts` from root.

- Move `tooling/src/boundaries/` → `plugins/framework/plugins/tooling/plugins/boundaries/core/`
- Move root `boundary.config.ts` → `plugins/framework/plugins/tooling/plugins/boundaries/boundary.config.ts`
- Import `Check` type from the umbrella `core/` instead of `../checks/types` (breaks the cycle)
- The boundaries barrel exports `boundaryRulesCheck` — a ready-made `Check` instance created from the co-located config
- `SOURCE_ROOTS` in `check.ts`: remove `"tooling/src"` (now under `"plugins"`)
- Remove `zone("tooling", ...)` and `allow("tooling -> ...")` from the boundary config
- Delete moved files from old `tooling/` and root `boundary.config.ts`

**Verification:** `./equin check --boundary-rules` passes, with tooling scanned as `plugin.framework.tooling.*`.

### Sub-task 7.4: Codegen → `tooling/plugins/codegen/`

Fully independent — consumed only by CLI.

- Move `tooling/src/docgen.ts` + `tooling/src/plugin-registry-gen.ts` → `plugins/framework/plugins/tooling/plugins/codegen/core/`
- **Migrate alias:** update CLI consumers from `@tooling/docgen` and `@tooling/plugin-registry-gen` to `@plugins/.../codegen/core`
- Update generated-file header comment string
- Delete moved files from old `tooling/`

**Verification:** `./equin build` succeeds (docgen + registry-gen run during build).

### Sub-task 7.5: Checks → `tooling/plugins/checks/`

Depends on 7.2 (lint) and 7.3 (boundaries).

- Move `tooling/src/checks/` → `plugins/framework/plugins/tooling/plugins/checks/core/`
- Import `boundaryRulesCheck` from `@plugins/.../boundaries/core` (replaces the old `boundary.config.ts` import + `createBoundaryCheck` call)
- Import `discoverAllowDefaultProject` from `@plugins/.../lint/core` (for the allow-default-project check)
- **Migrate alias:** update CLI consumers from `@tooling/checks` to `@plugins/.../checks/core`
- Update `typescript` check: `runTsc` path `${root}/tooling` → `${root}/plugins/framework/plugins/tooling`
- Update `eslint` check: lint source path in `bustCacheIfStale`
- Delete moved files from old `tooling/`

**Verification:** `./equin check` passes (all individual checks + check runner).

### Sub-task 7.6: Final cleanup

- Delete old `tooling/` directory entirely
- Remove `@tooling/*` alias from root `tsconfig.json` and `cli/tsconfig.json`
- Stale-reference audit: `rg 'tooling/' --type ts` for comment/string references
- Update umbrella `tsconfig.json` to its final form (include all sub-plugin dirs, drop any temp aliases)

**Verification:** `./equin build` + `./equin check` + hook fires.

---

## Sub-task dependency DAG

```
7.0 (umbrella)
 ├─→ 7.1 (guards)     ──┐
 ├─→ 7.2 (lint)        ──┤
 ├─→ 7.3 (boundaries)  ──┼─→ 7.5 (checks) ──→ 7.6 (cleanup)
 └─→ 7.4 (codegen)     ──┘
```

7.1–7.4 are independent of each other (could theoretically parallelize, but they touch shared files like `tsconfig.json` so sequential is safer).

---

## Key risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `boundary.config.ts` move breaks `./equin check` bootstrap | **Critical** | Boundaries sub-task (7.3) is atomic: DSL, config, and checker move together. The config imports the DSL from a sibling file, not a cross-package path. |
| Claude Code hook path wrong → blocks all tool calls | **High** | Guards sub-task (7.1) updates `.claude/settings.json` atomically. Verified immediately by running a tool call. |
| Partial migration leaves tooling in inconsistent state | **Medium** | Each sub-task deletes its moved files from old `tooling/`. The `@tooling/*` alias continues resolving un-migrated modules until 7.6 removes it. |
| Plugin tree walker generates registry entries for tooling | **Low** | Tooling sub-plugins have no `web/index.ts`, `server/index.ts`, or `central/index.ts` — registry codegen skips them. Verify `plugins.generated.ts` files are unchanged after each sub-task. |

---

## Done when

- `./equin build` succeeds
- `./equin check` passes (boundary-rules scans tooling as `plugin.framework.tooling.*`)
- Claude Code hooks work (PreToolUse guard fires from new path)
- `tooling/` deleted from repo root
- `boundary.config.ts` deleted from repo root (lives in boundaries plugin)
- No `@tooling/*` alias remains in any tsconfig
- `plugins.generated.ts` files unchanged (tooling contributes no runtime plugin entries)
